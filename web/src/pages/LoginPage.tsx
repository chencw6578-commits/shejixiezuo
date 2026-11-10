import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type AuthUser } from '../api';

/** 登录 / 注册双模式卡片页。登录成功后回到来源页或首页。 */
export default function LoginPage() {
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? '/';

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // 注册成功提示：先展示「验证邮件已发送」，稍候自动进入
  const [registered, setRegistered] = useState('');
  // 忘记密码：发送重置邮件后的提示
  const [forgotSent, setForgotSent] = useState(false);

  // 已登录则直接进入
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    api
      .me()
      .then(() => nav(from, { replace: true }))
      .catch(() => undefined)
      .finally(() => setChecked(true));
  }, [from, nav]);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setErr('');
      setBusy(true);
      try {
        const user =
          mode === 'login'
            ? await api.login(email.trim(), password)
            : await api.register(email.trim(), password, name.trim());
        if (mode === 'register') {
          // 软验证：已登录可用，先提示验证邮件已发出
          setRegistered(user.email);
          setTimeout(() => nav(from, { replace: true }), 2500);
          return;
        }
        nav(from, { replace: true });
      } catch (ex) {
        setErr(ex instanceof Error ? ex.message : String(ex));
      } finally {
        setBusy(false);
      }
    },
    [mode, email, password, name, nav, from]
  );

  if (registered) {
    return (
      <div className="auth-wrap">
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <p style={{ fontSize: 30, margin: '8px 0' }}>📨</p>
          <strong style={{ fontSize: 17 }}>注册成功，验证邮件已发送</strong>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '8px 0 0' }}>
            我们已向 <b>{registered}</b> 发送验证链接，请查收。
            <br />
            现在也可以直接使用，正在进入工作台…
          </p>
        </div>
      </div>
    );
  }

  if (!checked) return <div className="page-msg">加载中…</div>;

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="logo">✦</span>
          <strong>Design Handoff</strong>
          <p>设计协作与交付平台</p>
        </div>

        <div className="auth-tabs">
          <button className={mode === 'login' ? 'is-active' : ''} onClick={() => { setMode('login'); setErr(''); }}>
            登录
          </button>
          <button className={mode === 'register' ? 'is-active' : ''} onClick={() => { setMode('register'); setErr(''); }}>
            注册
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === 'register' && (
            <label>
              昵称
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="怎么称呼你（可选）"
                autoComplete="nickname"
              />
            </label>
          )}
          <label>
            邮箱
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'register' ? '至少 8 位' : '输入密码'}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
            />
          </label>

          {err && <p className="auth-err">{err}</p>}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '创建账号'}
          </button>
        </form>

        <p className="auth-foot">
          {mode === 'login' ? (
            forgotSent ? (
              <span className="dim">重置邮件已发送（仅发送给已注册邮箱），请查收</span>
            ) : (
              <button
                type="button"
                className="auth-link-btn"
                onClick={() => {
                  const em = email.trim();
                  if (!em) {
                    setErr('请先在上方输入注册邮箱，再点击「忘记密码」');
                    return;
                  }
                  setErr('');
                  api
                    .forgotPassword(em)
                    .catch(() => undefined)
                    .finally(() => setForgotSent(true));
                }}
              >
                忘记密码？
              </button>
            )
          ) : (
            <button
              type="button"
              className="auth-link-btn"
              onClick={() => {
                setErr('');
                setMode('login');
              }}
            >
              已有账号？去登录
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
