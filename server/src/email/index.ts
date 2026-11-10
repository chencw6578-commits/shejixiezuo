import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emailConfig } from '../config.js';
import { pool } from '../db.js';

/**
 * 邮件发送适配器（三通道，按 EMAIL_PROVIDER 切换）：
 * - outbox（默认）：邮件以 .eml 落盘到 outbox/ 目录，开发/演示无需任何凭据
 * - resend：Resend HTTP API（fetch，无额外依赖）
 * - smtp：nodemailer（用到时才动态 import）
 */

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

function buildEml(msg: MailMessage, from: string): string {
  return [
    `From: ${from}`,
    `To: ${msg.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(msg.subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(msg.html).toString('base64'),
  ].join('\r\n');
}

async function sendOutbox(msg: MailMessage, from: string) {
  const dir = path.resolve(process.cwd(), emailConfig.outboxDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${msg.to.replace(/[^a-z0-9@.]/gi, '_')}.eml`);
  await writeFile(file, buildEml(msg, from), 'utf8');
  console.log(`[email] outbox -> ${file}`);
}

async function sendResend(msg: MailMessage, from: string) {
  const res = await fetch(emailConfig.resend.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${emailConfig.resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: emailConfig.from, to: [msg.to], subject: msg.subject, html: msg.html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
  }
  console.log(`[email] resend -> ${msg.to}`);
}

async function sendSmtp(msg: MailMessage, from: string) {
  // 按需加载，未使用 smtp 通道时不引入依赖
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({
    host: emailConfig.smtp.host,
    port: emailConfig.smtp.port,
    secure: emailConfig.smtp.secure,
    auth: { user: emailConfig.smtp.user, pass: emailConfig.smtp.pass },
  });
  await transport.sendMail({ from, to: msg.to, subject: msg.subject, html: msg.html });
  console.log(`[email] smtp -> ${msg.to}`);
}

export async function sendMail(msg: MailMessage): Promise<void> {
  const from = emailConfig.from;
  switch (emailConfig.provider) {
    case 'resend':
      return sendResend(msg, from);
    case 'smtp':
      return sendSmtp(msg, from);
    default:
      return sendOutbox(msg, from);
  }
}

// ---------- 验证令牌 ----------

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** 生成验证令牌：明文返回（进邮件链接），库里只存 sha256；24h 过期 */
export async function createEmailToken(userId: string, type: 'verify' | 'reset' = 'verify'): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO email_tokens (user_id, token_hash, type, expires_at)
     VALUES ($1, $2, $3, now() + interval '24 hours')`,
    [userId, hashToken(token), type]
  );
  return token;
}

/** 核验令牌：一次性，成功后立即作废 */
export async function consumeEmailToken(token: string, type: 'verify' | 'reset' = 'verify') {
  const { rows } = await pool.query<{ user_id: string }>(
    `UPDATE email_tokens
     SET used_at = now()
     WHERE token_hash = $1 AND type = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(token), type]
  );
  return rows[0]?.user_id ?? null;
}

// ---------- 验证邮件模板 ----------

export async function sendVerificationEmail(userId: string, email: string): Promise<void> {
  const token = await createEmailToken(userId, 'verify');
  const url = `${emailConfig.webBaseUrl}/verify?token=${token}`;
  const html = `
<div style="max-width:520px;margin:0 auto;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937;">
  <h2 style="font-size:18px;">验证你的邮箱</h2>
  <p style="font-size:14px;line-height:1.7;color:#4b5563;">
    你在 <b>设计协作 · Design Handoff</b> 注册了账号（${email}）。点击下面按钮完成邮箱验证：
  </p>
  <p style="text-align:center;margin:28px 0;">
    <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;
       padding:10px 28px;border-radius:8px;font-size:14px;">验证邮箱</a>
  </p>
  <p style="font-size:12px;line-height:1.7;color:#9ca3af;">
    如果按钮无法点击，请复制以下链接到浏览器打开：<br/>
    <a href="${url}" style="color:#4f46e5;word-break:break-all;">${url}</a>
  </p>
  <p style="font-size:12px;color:#9ca3af;">链接 24 小时内有效。若这不是你的操作，请忽略本邮件。</p>
</div>`;
  await sendMail({ to: email, subject: '验证你的邮箱 · 设计协作', html });
}

/** 忘记密码：发送重置链接（type=reset，一次性 24h） */
export async function sendPasswordResetEmail(userId: string, email: string): Promise<void> {
  const token = await createEmailToken(userId, 'reset');
  const url = `${emailConfig.webBaseUrl}/reset?token=${token}`;
  const html = `
<div style="max-width:520px;margin:0 auto;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937;">
  <h2 style="font-size:18px;">重置密码</h2>
  <p style="font-size:14px;line-height:1.7;color:#4b5563;">
    你在 <b>设计协作 · Design Handoff</b>（账号 ${email}）发起了密码重置。点击下面按钮设置新密码：
  </p>
  <p style="text-align:center;margin:28px 0;">
    <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;
       padding:10px 28px;border-radius:8px;font-size:14px;">设置新密码</a>
  </p>
  <p style="font-size:12px;line-height:1.7;color:#9ca3af;">
    如果按钮无法点击，请复制以下链接到浏览器打开：<br/>
    <a href="${url}" style="color:#4f46e5;word-break:break-all;">${url}</a>
  </p>
  <p style="font-size:12px;color:#9ca3af;">链接 24 小时内有效。若这不是你的操作，请忽略本邮件，密码不会变更。</p>
</div>`;
  await sendMail({ to: email, subject: '重置密码 · 设计协作', html });
}
