/**
 * 演示项目节点数据种子（可重复执行）。
 *  - 给演示项目的 10 张画板写入真实节点树（矩形/文字/按钮/分组），坐标与画板 1:1 对齐
 *  - 画布与属性面板读同一份 nodes 数据，颜色/尺寸与实际渲染一致
 *  - 幂等：按 frame 清空旧 nodes 再写入
 *
 * 运行（server 目录）：npx tsx scripts/seedDemoNodes.ts
 */
import { initDb, pool } from '../src/db.js';

type TextSpec = {
  content: string;
  size: number;
  weight?: number;
  lineHeight?: number;
  align?: 'LEFT' | 'CENTER' | 'RIGHT';
  color?: string;
};

interface N {
  id: string; // 相对 key
  parent?: string; // 父节点相对 key
  name: string;
  type: string;
  x: number; y: number; w: number; h: number;
  fill?: string;
  radius?: number;
  border?: { color: string; width: number };
  opacity?: number;
  shadow?: boolean;
  text?: TextSpec;
}

const rgbaOf = (hex: string, alpha = 1) => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { hex, alpha, rgba: `rgba(${r}, ${g}, ${b}, ${alpha})` };
};
const fillOf = (hex: string, alpha = 1) => ({
  type: 'solid',
  visible: true,
  opacity: 1,
  color: rgbaOf(hex, alpha),
  css: rgbaOf(hex, alpha).rgba,
});

const toProps = (n: N) => {
  const textColor = n.text?.color ?? n.fill ?? '#1D2129';
  return {
    opacity: n.opacity ?? 1,
    fills: n.text ? [] : n.fill ? [fillOf(n.fill)] : [],
    strokes: n.border ? [fillOf(n.border.color)] : [],
    strokeWeight: n.border?.width,
    strokeAlign: 'INSIDE',
    effects: n.shadow
      ? [
          {
            type: 'DROP_SHADOW',
            offsetX: 0,
            offsetY: 2,
            radius: 8,
            spread: 0,
            color: rgbaOf('#1B2A4A', 0.08),
            css: '0px 2px 8px 0px rgba(27, 42, 74, 0.08)',
          },
        ]
      : [],
    cornerRadius: n.radius ?? 0,
    exportPresets: [],
    hasImageFill: false,
    ...(n.text
      ? {
          fills: [fillOf(textColor)],
          text: {
            family: 'PingFang SC',
            weight: n.text.weight ?? 400,
            size: n.text.size,
            lineHeight: n.text.lineHeight ?? Math.round(n.text.size * 1.45),
            alignHorizontal: n.text.align ?? 'LEFT',
            alignVertical: 'CENTER',
            color: rgbaOf(textColor),
            content: n.text.content,
          },
        }
      : {}),
  };
};

// ---------- 通用小部件 ----------
const C = {
  bg: '#F5F7FB', phoneBg: '#F5F7FB', card: '#FFFFFF', primary: '#1B6DFF',
  text: '#1D2129', sub: '#86909C', line: '#E5E6EB', input: '#F2F3F5',
  green: '#00B42A', red: '#F53F3F', white: '#FFFFFF', dark: '#1D2129',
};

const T = (id: string, parent: string | null, name: string, x: number, y: number, w: number, h: number, t: TextSpec, color?: string): N => ({
  id, parent: parent ?? undefined, name, type: 'TEXT', x, y, w, h, text: t, fill: color ?? t.color,
});

const R = (id: string, parent: string | null, name: string, x: number, y: number, w: number, h: number, fill: string, radius = 0, shadow = false, border?: N['border']): N => ({
  id, parent: parent ?? undefined, name, type: 'RECTANGLE', x, y, w, h, fill, radius, shadow, border,
});

const E = (id: string, parent: string | null, name: string, x: number, y: number, w: number, h: number, fill: string): N => ({
  id, parent: parent ?? undefined, name, type: 'ELLIPSE', x, y, w, h, fill,
});

const F = (id: string, parent: string | null, name: string, x: number, y: number, w: number, h: number, fill: string, radius = 0): N => ({
  id, parent: parent ?? undefined, name, type: 'FRAME', x, y, w, h, fill, radius,
});

const G = (id: string, name: string, x: number, y: number, w: number, h: number): N => ({
  id, name, type: 'GROUP', x, y, w, h,
});

// ---------- 手机画板 390×844 ----------

function login(): N[] {
  const W = 390;
  const out: N[] = [
    R('bg', null, '页面背景', 0, 0, W, 844, C.phoneBg),
    R('hero', null, '品牌区', 0, 0, W, 260, '#EAF2FF'),
    E('logo', null, 'Logo', 155, 64, 80, 80, C.primary),
    T('title', null, '标题', 95, 170, 200, 28, { content: '设计协作', size: 20, weight: 700, align: 'CENTER', color: C.text }),
    T('subtitle', null, '副标题', 75, 204, 240, 18, { content: '登录以继续使用你的团队空间', size: 13, align: 'CENTER', color: C.sub }),
    G('card', '登录卡片', 24, 280, 342, 300),
    R('card-bg', 'card', '卡片背景', 24, 280, 342, 300, C.card, 20, true),
    T('label-phone', 'card', '手机号标签', 48, 312, 120, 18, { content: '手机号', size: 13, color: C.text }),
    R('input-phone', 'card', '手机号输入框', 48, 336, 294, 48, C.input, 10),
    T('ph-phone', 'card', '手机号占位', 64, 350, 200, 20, { content: '请输入手机号', size: 14, color: C.sub }),
    T('label-code', 'card', '验证码标签', 48, 402, 120, 18, { content: '验证码', size: 13, color: C.text }),
    R('input-code', 'card', '验证码输入框', 48, 426, 186, 48, C.input, 10),
    T('ph-code', 'card', '验证码占位', 64, 440, 140, 20, { content: '6 位验证码', size: 14, color: C.sub }),
    F('btn-code', 'card', '获取验证码按钮', 246, 426, 96, 48, C.primary, 10),
    T('btn-code-label', 'btn-code', '验证码按钮文案', 246, 442, 96, 18, { content: '获取验证码', size: 12, align: 'CENTER', color: C.white }),
    F('btn-login', 'card', '登录按钮', 48, 500, 294, 48, C.primary, 24),
    T('btn-login-label', 'btn-login', '登录按钮文案', 48, 516, 294, 20, { content: '登 录', size: 16, weight: 600, align: 'CENTER', color: C.white }),
    T('agree', null, '协议说明', 75, 600, 240, 16, { content: '登录即代表同意《用户协议》与《隐私政策》', size: 11, align: 'CENTER', color: C.sub }),
  ];
  return out;
}

function register(): N[] {
  const W = 390;
  return [
    R('bg', null, '页面背景', 0, 0, W, 844, C.phoneBg),
    R('hero', null, '品牌区', 0, 0, W, 240, '#EAF2FF'),
    T('title', null, '标题', 95, 96, 200, 28, { content: '创建账号', size: 20, weight: 700, align: 'CENTER', color: C.text }),
    T('subtitle', null, '副标题', 75, 132, 240, 18, { content: '注册后即可加入团队协作', size: 13, align: 'CENTER', color: C.sub }),
    E('avatar', null, '头像占位', 167, 168, 56, 56, '#FFFFFF'),
    G('card', '注册卡片', 24, 260, 342, 420),
    R('card-bg', 'card', '卡片背景', 24, 260, 342, 420, C.card, 20, true),
    T('label-name', 'card', '昵称标签', 48, 288, 120, 18, { content: '昵称', size: 13, color: C.text }),
    R('input-name', 'card', '昵称输入框', 48, 312, 294, 48, C.input, 10),
    T('ph-name', 'card', '昵称占位', 64, 326, 200, 20, { content: '请输入昵称', size: 14, color: C.sub }),
    T('label-phone', 'card', '手机号标签', 48, 376, 120, 18, { content: '手机号', size: 13, color: C.text }),
    R('input-phone', 'card', '手机号输入框', 48, 400, 294, 48, C.input, 10),
    T('ph-phone', 'card', '手机号占位', 64, 414, 200, 20, { content: '请输入手机号', size: 14, color: C.sub }),
    T('label-pwd', 'card', '密码标签', 48, 464, 120, 18, { content: '密码', size: 13, color: C.text }),
    R('input-pwd', 'card', '密码输入框', 48, 488, 294, 48, C.input, 10),
    T('ph-pwd', 'card', '密码占位', 64, 502, 220, 20, { content: '至少 8 位字符', size: 14, color: C.sub }),
    T('tip', 'card', '安全提示', 48, 546, 294, 18, { content: '密码需包含字母与数字', size: 12, color: C.sub }),
    F('btn-register', 'card', '注册按钮', 48, 588, 294, 48, C.primary, 24),
    T('btn-register-label', 'btn-register', '注册按钮文案', 48, 604, 294, 20, { content: '注 册', size: 16, weight: 600, align: 'CENTER', color: C.white }),
    T('agree', null, '协议说明', 45, 710, 300, 32, { content: '注册即代表同意《用户协议》与《隐私政策》', size: 11, align: 'CENTER', color: C.sub }),
  ];
}

function forgot(): N[] {
  return [
    R('bg', null, '页面背景', 0, 0, 390, 844, C.phoneBg),
    R('hero', null, '品牌区', 0, 0, 390, 200, '#EAF2FF'),
    T('back', null, '返回', 24, 48, 40, 24, { content: '‹', size: 22, weight: 600, color: C.text }),
    T('title', null, '标题', 95, 110, 200, 28, { content: '找回密码', size: 20, weight: 700, align: 'CENTER', color: C.text }),
    T('subtitle', null, '副标题', 75, 144, 240, 18, { content: '通过手机号验证后重置密码', size: 13, align: 'CENTER', color: C.sub }),
    G('card', '找回密码卡片', 24, 232, 342, 320),
    R('card-bg', 'card', '卡片背景', 24, 232, 342, 320, C.card, 20, true),
    T('label-phone', 'card', '手机号标签', 48, 264, 120, 18, { content: '手机号', size: 13, color: C.text }),
    R('input-phone', 'card', '手机号输入框', 48, 288, 294, 48, C.input, 10),
    T('ph-phone', 'card', '手机号占位', 64, 302, 200, 20, { content: '请输入注册手机号', size: 14, color: C.sub }),
    T('label-code', 'card', '验证码标签', 48, 354, 120, 18, { content: '验证码', size: 13, color: C.text }),
    R('input-code', 'card', '验证码输入框', 48, 378, 186, 48, C.input, 10),
    T('ph-code', 'card', '验证码占位', 64, 392, 140, 20, { content: '6 位验证码', size: 14, color: C.sub }),
    F('btn-code', 'card', '获取验证码按钮', 246, 378, 96, 48, C.primary, 10),
    T('btn-code-label', 'btn-code', '验证码按钮文案', 246, 394, 96, 18, { content: '获取验证码', size: 12, align: 'CENTER', color: C.white }),
    T('label-pwd', 'card', '新密码标签', 48, 442, 120, 18, { content: '新密码', size: 13, color: C.text }),
    R('input-pwd', 'card', '新密码输入框', 48, 466, 294, 48, C.input, 10),
    T('ph-pwd', 'card', '新密码占位', 64, 480, 220, 20, { content: '请输入新密码', size: 14, color: C.sub }),
    F('btn-reset', 'card', '重置按钮', 48, 524, 294, 48, C.primary, 24),
    T('btn-reset-label', 'btn-reset', '重置按钮文案', 48, 540, 294, 20, { content: '重 置 密 码', size: 16, weight: 600, align: 'CENTER', color: C.white }),
    T('tip', null, '提示', 45, 576, 300, 32, { content: '重置后旧密码立即失效，请使用新密码登录', size: 12, align: 'CENTER', color: C.sub }),
  ];
}

function memberHome(): N[] {
  const out: N[] = [
    R('bg', null, '页面背景', 0, 0, 390, 844, C.phoneBg),
    R('header', null, '头部', 0, 0, 390, 180, C.primary),
    E('avatar', null, '头像', 24, 52, 56, 56, C.white),
    T('name', null, '昵称', 92, 56, 160, 22, { content: '设计小助手', size: 16, weight: 600, color: C.white }),
    T('level', null, '会员等级', 92, 82, 180, 16, { content: '黄金会员 · 剩余 128 天', size: 12, color: '#D6E4FF' }),
    G('card', '会员卡', 16, 140, 358, 120),
    R('card-bg', 'card', '会员卡背景', 16, 140, 358, 120, C.card, 16, true),
    T('points-label', 'card', '积分标签', 36, 156, 100, 16, { content: '会员积分', size: 12, color: C.sub }),
    T('points', 'card', '积分数值', 36, 178, 160, 32, { content: '12,800', size: 24, weight: 700, color: C.primary }),
    F('renew', 'card', '续费按钮', 268, 176, 86, 32, C.primary, 16),
    T('renew-label', 'renew', '续费按钮文案', 268, 183, 86, 16, { content: '立即续费', size: 12, align: 'CENTER', color: C.white }),
    T('section', null, '分区标题', 16, 280, 160, 18, { content: '会员专属服务', size: 14, weight: 600, color: C.text }),
  ];
  const services = [
    ['专属客服', '7×24 小时响应'],
    ['生日礼包', '每年一次'],
    ['积分加倍', '消费积分翻倍'],
    ['免费素材', '海量资源'],
  ];
  services.forEach(([title, desc], i) => {
    const x = 16 + (i % 2) * 182;
    const y = 308 + Math.floor(i / 2) * 92;
    out.push(R(`grid${i}`, null, `服务卡片 ${i + 1}`, x, y, 174, 84, C.card, 12, true));
    out.push(E(`grid${i}-icon`, null, `服务图标 ${i + 1}`, x + 14, y + 16, 28, 28, i % 2 ? '#E8F1FF' : '#FFF3E0'));
    out.push(T(`grid${i}-t`, null, `服务标题 ${i + 1}`, x + 52, y + 16, 110, 18, { content: title, size: 13, weight: 600, color: C.text }));
    out.push(T(`grid${i}-d`, null, `服务描述 ${i + 1}`, x + 52, y + 40, 110, 16, { content: desc, size: 11, color: C.sub }));
  });
  const menus = ['我的订单', '我的收藏', '浏览历史'];
  menus.forEach((m, i) => {
    const y = 496 + i * 64;
    out.push(R(`menu${i}`, null, `菜单 ${i + 1}`, 16, y, 358, 56, C.card, 10, true));
    out.push(T(`menu${i}-t`, null, `菜单文案 ${i + 1}`, 36, y + 18, 160, 20, { content: m, size: 14, color: C.text }));
    out.push(T(`menu${i}-a`, null, `菜单箭头 ${i + 1}`, 340, y + 18, 16, 20, { content: '›', size: 18, align: 'CENTER', color: C.sub }));
  });
  out.push(R('tab', null, '底部标签栏', 0, 772, 390, 72, C.card, 0, true));
  ['首页', '会员', '订单', '我的'].forEach((t, i) => {
    out.push(T(`tab${i}`, null, `标签 ${i + 1}`, 20 + i * 92, 792, 80, 20, { content: t, size: 12, align: 'CENTER', color: i === 1 ? C.primary : C.sub }));
  });
  return out;
}

function benefits(): N[] {
  const out: N[] = [
    R('bg', null, '页面背景', 0, 0, 390, 844, C.phoneBg),
    R('header', null, '头部', 0, 0, 390, 120, C.primary),
    T('title', null, '标题', 120, 56, 150, 24, { content: '会员权益', size: 18, weight: 700, align: 'CENTER', color: C.white }),
    T('subtitle', null, '说明', 24, 136, 342, 18, { content: '黄金会员可享受以下专属权益', size: 13, color: C.sub }),
  ];
  const items = [
    ['专属客服通道', '优先接入人工客服，问题优先处理', '#E8F1FF'],
    ['每月会员礼包', '每月可领取优惠券与积分礼包', '#FFF3E0'],
    ['积分双倍返还', '消费获得的积分按 2 倍计算', '#E8FFEA'],
  ];
  items.forEach(([title, desc, icon], i) => {
    const y = 176 + i * 116;
    out.push(R(`card${i}`, null, `权益卡片 ${i + 1}`, 24, y, 342, 100, C.card, 16, true));
    out.push(E(`card${i}-icon`, null, `权益图标 ${i + 1}`, 44, y + 22, 56, 56, icon));
    out.push(T(`card${i}-t`, null, `权益标题 ${i + 1}`, 116, y + 24, 220, 20, { content: title, size: 15, weight: 600, color: C.text }));
    out.push(T(`card${i}-d`, null, `权益描述 ${i + 1}`, 116, y + 50, 230, 32, { content: desc, size: 12, color: C.sub }));
  });
  out.push(T('note', null, '说明文案', 24, 536, 342, 48, { content: '权益自开通之日起生效，有效期内可随时使用\n到期未续费将自动降为普通会员', size: 12, color: C.sub }));
  out.push(F('upgrade', null, '升级按钮', 24, 660, 342, 52, C.primary, 26));
  out.push(T('upgrade-label', 'upgrade', '升级按钮文案', 24, 676, 342, 20, { content: '升级为钻石会员', size: 16, weight: 600, align: 'CENTER', color: C.white }));
  return out;
}

function settings(): N[] {
  const out: N[] = [
    R('bg', null, '页面背景', 0, 0, 390, 844, C.phoneBg),
    R('header', null, '头部', 0, 0, 390, 88, C.card),
    T('title', null, '标题', 145, 42, 100, 24, { content: '设置', size: 18, weight: 600, align: 'CENTER', color: C.text }),
  ];
  const rows = ['个人资料', '通知设置', '隐私设置', '关于我们'];
  rows.forEach((r, i) => {
    const y = 108 + i * 64;
    out.push(R(`row${i}`, null, `${r}菜单`, 16, y, 358, 56, C.card, 10, true));
    out.push(T(`row${i}-t`, null, `${r}文案`, 36, y + 18, 200, 20, { content: r, size: 14, color: C.text }));
    out.push(T(`row${i}-a`, null, `${r}箭头`, 340, y + 18, 16, 20, { content: '›', size: 18, align: 'CENTER', color: C.sub }));
  });
  out.push(R('logout', null, '退出登录按钮', 24, 680, 342, 48, C.card, 24, false, { color: C.red, width: 1 }));
  out.push(T('logout-label', 'logout', '退出登录文案', 24, 694, 342, 20, { content: '退出登录', size: 15, align: 'CENTER', color: C.red }));
  out.push(T('version', null, '版本号', 95, 760, 200, 16, { content: 'DesignHub v1.0.0', size: 11, align: 'CENTER', color: C.sub }));
  return out;
}

// ---------- 后台画板 1440×900 ----------

const ADMIN = { bg: '#F5F7FA', sidebar: '#1D2129', card: '#FFFFFF', primary: '#1B6DFF', text: '#1D2129', sub: '#86909C', line: '#E5E6EB' };

function adminSidebar(out: N[], key: string, active: number) {
  out.push(R(`${key}-sidebar`, null, '侧边栏', 0, 0, 220, 900, ADMIN.sidebar));
  out.push(T(`${key}-logo`, null, '产品名', 24, 24, 150, 28, { content: '设计数据平台', size: 18, weight: 700, color: C.white }));
  ['数据看板', '订单列表', '商品管理', '权限设置'].forEach((t, i) => {
    const y = 90 + i * 44;
    if (i === active) out.push(R(`${key}-nav${i}`, null, `菜单选中态`, 16, y, 188, 36, ADMIN.primary, 8));
    out.push(T(`${key}-nav${i}-t`, null, `菜单 ${t}`, 32, y + 8, 160, 18, { content: t, size: 13, color: i === active ? C.white : '#C9CDD4' }));
  });
}

function dashboard(): N[] {
  const out: N[] = [R('bg', null, '页面背景', 0, 0, 1440, 900, ADMIN.bg)];
  adminSidebar(out, 'd', 0);
  out.push(R('header', null, '顶栏', 220, 0, 1220, 64, C.white));
  out.push(T('title', null, '页面标题', 244, 20, 200, 24, { content: '数据看板', size: 18, weight: 600, color: ADMIN.text }));
  out.push(R('search', null, '搜索框', 1020, 16, 300, 32, '#F2F3F5', 16));
  out.push(T('search-ph', null, '搜索占位', 1036, 23, 200, 18, { content: '搜索订单 / 商品', size: 12, color: ADMIN.sub }));
  const kpis = [
    ['总访问量', '128,460', '+12.4%', C.primary],
    ['新增用户', '3,820', '+8.2%', '#00B42A'],
    ['订单金额', '¥ 86,210', '+5.6%', '#FF7D00'],
    ['退款率', '1.2%', '-0.4%', '#F53F3F'],
  ];
  kpis.forEach(([label, value, delta, color], i) => {
    const x = 244 + i * 290;
    out.push(R(`kpi${i}`, null, `指标卡 ${i + 1}`, x, 84, 270, 110, C.card, 12, true));
    out.push(T(`kpi${i}-l`, null, `指标标签 ${i + 1}`, x + 20, 100, 150, 16, { content: label, size: 12, color: ADMIN.sub }));
    out.push(T(`kpi${i}-v`, null, `指标数值 ${i + 1}`, x + 20, 124, 180, 32, { content: value, size: 26, weight: 700, color: ADMIN.text }));
    out.push(T(`kpi${i}-d`, null, `指标变化 ${i + 1}`, x + 20, 164, 120, 16, { content: delta, size: 12, color }));
  });
  out.push(R('chart', null, '图表卡片', 244, 214, 1200, 320, C.card, 12, true));
  out.push(T('chart-title', null, '图表标题', 268, 234, 200, 20, { content: '近 7 日访问量', size: 15, weight: 600, color: ADMIN.text }));
  const heights = [120, 160, 200, 150, 230, 190, 260];
  heights.forEach((h, i) => {
    const x = 300 + i * 150;
    out.push(R(`bar${i}`, null, `柱子 ${i + 1}`, x, 520 - h, 44, h, i === 6 ? ADMIN.primary : '#94BFFF', 6));
    out.push(T(`bar${i}-l`, null, `横轴 ${i + 1}`, x - 8, 530, 60, 16, { content: `第 ${i + 1} 天`, size: 11, align: 'CENTER', color: ADMIN.sub }));
  });
  out.push(R('table', null, '表格卡片', 244, 554, 1200, 320, C.card, 12, true));
  out.push(T('table-title', null, '表格标题', 268, 574, 200, 20, { content: '最近订单', size: 15, weight: 600, color: ADMIN.text }));
  ['订单号', '客户', '金额', '状态'].forEach((h, i) => {
    out.push(T(`th${i}`, null, `表头 ${h}`, 268 + i * 280, 608, 200, 18, { content: h, size: 12, color: ADMIN.sub }));
  });
  for (let i = 0; i < 5; i++) {
    const y = 640 + i * 44;
    out.push(R(`line${i}`, null, `分隔线 ${i + 1}`, 268, y, 1150, 1, ADMIN.line));
    out.push(T(`row${i}-id`, null, `订单号 ${i + 1}`, 268, y + 12, 200, 18, { content: `DH2026110${i + 1}`, size: 12, color: ADMIN.text }));
    out.push(T(`row${i}-user`, null, `客户 ${i + 1}`, 548, y + 12, 160, 18, { content: ['林一', '周可', '陈默', '许可', '赵四'][i], size: 12, color: ADMIN.text }));
    out.push(T(`row${i}-amt`, null, `金额 ${i + 1}`, 828, y + 12, 120, 18, { content: `¥ ${[128, 322, 86, 456, 199][i]}.00`, size: 12, color: ADMIN.text }));
    out.push(T(`row${i}-st`, null, `状态 ${i + 1}`, 1108, y + 12, 100, 18, { content: ['已完成', '处理中', '已取消', '已完成', '待发货'][i], size: 12, color: '#00B42A' }));
  }
  return out;
}

function orders(): N[] {
  const out: N[] = [R('bg', null, '页面背景', 0, 0, 1440, 900, ADMIN.bg)];
  adminSidebar(out, 'o', 1);
  out.push(R('header', null, '顶栏', 220, 0, 1220, 64, C.white));
  out.push(T('title', null, '页面标题', 244, 20, 200, 24, { content: '订单列表', size: 18, weight: 600, color: ADMIN.text }));
  out.push(R('filter', null, '筛选栏', 244, 84, 1176, 64, C.card, 12, true));
  out.push(T('filter-label', null, '筛选项', 268, 104, 100, 20, { content: '订单状态', size: 13, color: ADMIN.sub }));
  out.push(R('filter-select', null, '状态下拉', 356, 100, 180, 32, '#F2F3F5', 8));
  out.push(T('filter-select-t', null, '下拉文案', 372, 107, 140, 18, { content: '全部状态', size: 12, color: ADMIN.text }));
  out.push(R('search-input', null, '搜索订单号', 556, 100, 260, 32, '#F2F3F5', 8));
  out.push(T('search-ph', null, '搜索占位', 572, 107, 200, 18, { content: '输入订单号搜索', size: 12, color: ADMIN.sub }));
  out.push(F('search-btn', null, '搜索按钮', 1200, 100, 88, 32, ADMIN.primary, 8));
  out.push(T('search-btn-t', 'search-btn', '搜索按钮文案', 1200, 107, 88, 18, { content: '查询', size: 12, align: 'CENTER', color: C.white }));
  out.push(R('thead', null, '表头', 244, 164, 1176, 48, '#FAFBFC', 8));
  ['订单号', '客户', '商品', '金额', '状态', '操作'].forEach((h, i) => {
    out.push(T(`th${i}`, null, `表头 ${h}`, 268 + i * 190, 179, 160, 18, { content: h, size: 12, weight: 600, color: ADMIN.sub }));
  });
  for (let i = 0; i < 8; i++) {
    const y = 212 + i * 68;
    out.push(R(`row${i}`, null, `订单行 ${i + 1}`, 244, y, 1176, 67, C.card));
    out.push(R(`row${i}-line`, null, `行分隔线 ${i + 1}`, 244, y + 67, 1176, 1, ADMIN.line));
    out.push(T(`row${i}-id`, null, `订单号 ${i + 1}`, 268, y + 24, 180, 18, { content: `DH2026110${i + 1}`, size: 13, color: ADMIN.text }));
    out.push(T(`row${i}-user`, null, `客户 ${i + 1}`, 458, y + 24, 120, 18, { content: ['林一', '周可', '陈默', '许可', '赵四', '钱五', '孙六', '李七'][i], size: 13, color: ADMIN.text }));
    out.push(T(`row${i}-goods`, null, `商品 ${i + 1}`, 648, y + 24, 180, 18, { content: ['会员年卡', '设计模板包', '素材会员', '团队席位', '高级组件库', '字体授权', '插件订阅', '培训课程'][i], size: 13, color: ADMIN.text }));
    out.push(T(`row${i}-amt`, null, `金额 ${i + 1}`, 838, y + 24, 100, 18, { content: `¥ ${[128, 322, 86, 456, 199, 268, 99, 599][i]}.00`, size: 13, color: ADMIN.text }));
    out.push(T(`row${i}-st`, null, `状态 ${i + 1}`, 1028, y + 24, 100, 18, { content: ['已完成', '处理中', '已取消', '已完成', '待发货', '已完成', '已退款', '处理中'][i], size: 12, color: i % 2 ? '#FF7D00' : '#00B42A' }));
    out.push(T(`row${i}-act`, null, `操作 ${i + 1}`, 1218, y + 24, 60, 18, { content: '详情', size: 12, color: ADMIN.primary }));
  }
  out.push(T('pager', null, '分页', 1180, 796, 220, 18, { content: '共 128 条  ‹ 1 2 3 ›', size: 12, align: 'RIGHT', color: ADMIN.sub }));
  return out;
}

function product(): N[] {
  const out: N[] = [R('bg', null, '页面背景', 0, 0, 1440, 900, ADMIN.bg)];
  out.push(R('header', null, '顶栏', 0, 0, 1440, 64, C.white));
  out.push(T('back', null, '返回', 24, 20, 40, 24, { content: '‹', size: 20, color: ADMIN.text }));
  out.push(T('title', null, '页面标题', 76, 20, 240, 24, { content: '商品详情', size: 18, weight: 600, color: ADMIN.text }));
  out.push(R('left', null, '图片卡片', 24, 84, 520, 520, C.card, 12, true));
  out.push(R('photo', 'left', '商品主图', 48, 108, 472, 472, '#F2F3F5', 12));
  out.push(T('photo-label', 'left', '主图说明', 48, 540, 472, 20, { content: '商品主图（1:1）', size: 12, align: 'CENTER', color: ADMIN.sub }));
  out.push(R('right', null, '信息卡片', 568, 84, 848, 520, C.card, 12, true));
  out.push(T('p-title', 'right', '商品名称', 596, 112, 500, 28, { content: 'DesignHub 会员年卡', size: 20, weight: 700, color: ADMIN.text }));
  out.push(T('p-price', 'right', '价格', 596, 152, 240, 36, { content: '¥ 1,288.00', size: 26, weight: 700, color: '#F53F3F' }));
  out.push(T('p-origin', 'right', '原价', 850, 160, 120, 20, { content: '¥ 1,688.00', size: 13, color: ADMIN.sub }));
  ['官方授权', '随时退款', '开具发票'].forEach((t, i) => {
    out.push(R(`tag${i}`, 'right', `标签 ${i + 1}`, 596 + i * 88, 200, 80, 26, '#E8F1FF', 6));
    out.push(T(`tag${i}-t`, 'right', `标签文案 ${i + 1}`, 596 + i * 88, 205, 80, 16, { content: t, size: 11, align: 'CENTER', color: ADMIN.primary }));
  });
  out.push(T('p-desc', 'right', '商品描述', 596, 248, 760, 60, { content: '开通后可无限使用团队素材库、模板库与高级组件，支持 5 个协作席位。', size: 13, color: ADMIN.sub }));
  out.push(T('p-spec', 'right', '规格说明', 596, 318, 760, 20, { content: '有效期：365 天        席位：5 人       支持：设计 / 前端', size: 13, color: ADMIN.text }));
  out.push(F('buy', 'right', '立即购买', 596, 372, 260, 48, ADMIN.primary, 24));
  out.push(T('buy-t', 'buy', '购买按钮文案', 596, 388, 260, 20, { content: '立即购买', size: 15, weight: 600, align: 'CENTER', color: C.white }));
  out.push(F('cart', 'right', '加入购物车', 872, 372, 260, 48, C.white, 24));
  out.push(R('cart-border', 'right', '购物车边框', 872, 372, 260, 48, C.white, 24, false, { color: ADMIN.primary, width: 1 }));
  out.push(T('cart-t', 'cart', '购物车文案', 872, 388, 260, 20, { content: '加入购物车', size: 15, align: 'CENTER', color: ADMIN.primary }));
  out.push(R('bottom', null, '详情卡片', 24, 624, 1392, 240, C.card, 12, true));
  out.push(T('b-title', null, '详情标题', 48, 644, 200, 20, { content: '商品参数', size: 15, weight: 600, color: ADMIN.text }));
  for (let i = 0; i < 4; i++) {
    const y = 684 + i * 40;
    out.push(T(`spec-l${i}`, null, `参数名 ${i + 1}`, 48, y, 160, 18, { content: ['商品类型', '适用人数', '有效期', '授权方式'][i], size: 12, color: ADMIN.sub }));
    out.push(T(`spec-v${i}`, null, `参数值 ${i + 1}`, 220, y, 300, 18, { content: ['数字会员', '5 人', '365 天', '团队授权'][i], size: 12, color: ADMIN.text }));
  }
  return out;
}

function permissions(): N[] {
  const out: N[] = [R('bg', null, '页面背景', 0, 0, 1440, 900, ADMIN.bg)];
  adminSidebar(out, 'p', 3);
  out.push(R('header', null, '顶栏', 220, 0, 1220, 64, C.white));
  out.push(T('title', null, '页面标题', 244, 20, 240, 24, { content: '权限设置', size: 18, weight: 600, color: ADMIN.text }));
  out.push(R('card', null, '权限卡片', 244, 84, 1176, 700, C.card, 12, true));
  out.push(T('card-title', null, '卡片标题', 268, 108, 240, 24, { content: '角色与权限', size: 16, weight: 600, color: ADMIN.text }));
  out.push(T('card-desc', null, '卡片说明', 268, 138, 700, 18, { content: '为不同角色分配可见模块与操作权限', size: 12, color: ADMIN.sub }));
  out.push(G('roles', '角色列表', 268, 176, 1128, 480));
  const roles = [
    ['超级管理员', '拥有全部模块与操作权限', true],
    ['管理员', '可管理项目、成员与设计稿', true],
    ['设计师', '可查看与编辑设计稿', true],
    ['协作者', '只读查看项目与评论', false],
    ['访客', '仅查看分享链接', false],
  ];
  roles.forEach(([name, desc, on], i) => {
    const y = 176 + i * 92;
    out.push(R(`role${i}`, 'roles', `角色行 ${i + 1}`, 268, y, 1128, 80, '#FAFBFC', 10));
    out.push(E(`role${i}-icon`, 'roles', `角色头像 ${i + 1}`, 292, y + 20, 40, 40, i % 2 ? '#FFF3E0' : '#E8F1FF'));
    out.push(T(`role${i}-n`, 'roles', `角色名 ${i + 1}`, 348, y + 18, 200, 20, { content: name, size: 14, weight: 600, color: ADMIN.text }));
    out.push(T(`role${i}-d`, 'roles', `角色说明 ${i + 1}`, 348, y + 42, 400, 18, { content: desc, size: 12, color: ADMIN.sub }));
    out.push(R(`role${i}-sw`, 'roles', `开关底 ${i + 1}`, 1300, y + 30, 44, 20, on ? ADMIN.primary : '#C9CDD4', 10));
    out.push(E(`role${i}-knob`, 'roles', `开关圆点 ${i + 1}`, on ? 1322 : 1302, y + 32, 16, 16, C.white));
  });
  out.push(F('save', null, '保存按钮', 1236, 700, 160, 44, ADMIN.primary, 22));
  out.push(T('save-t', 'save', '保存按钮文案', 1236, 712, 160, 20, { content: '保存设置', size: 14, align: 'CENTER', color: C.white }));
  return out;
}

// ---------- 写入 ----------

const FRAME_SPECS: Record<string, Record<string, N[]>> = {
  'demo-phone': {
    登录页: login(),
    注册页: register(),
    忘记密码: forgot(),
    会员中心首页: memberHome(),
    会员权益: benefits(),
    设置页: settings(),
  },
  'demo-dash': {
    数据看板: dashboard(),
    订单列表: orders(),
    商品详情: product(),
    权限设置: permissions(),
  },
};

async function ensureFile(figmaKey: string, name: string, projectId: string | null) {
  const found = await pool.query<{ id: string }>('SELECT id FROM design_files WHERE figma_key = $1', [figmaKey]);
  if (found.rows[0]) return found.rows[0].id;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO design_files (figma_key, name, version, status, project_id)
     VALUES ($1, $2, 'demo-nodes', 'ready', $3) RETURNING id`,
    [figmaKey, name, projectId]
  );
  return rows[0].id;
}

async function ensureFrame(fileId: string, name: string, width: number, height: number, sort: number) {
  const found = await pool.query<{ id: string }>(
    'SELECT id FROM frames WHERE file_id = $1 AND name = $2',
    [fileId, name]
  );
  if (found.rows[0]) return found.rows[0].id;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO frames (file_id, node_id, name, width, height, sort_order, thumb_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [fileId, `demo:${name}`, name, width, height, sort, '/storage/demo/phone.svg']
  );
  return rows[0].id;
}

async function main() {
  await initDb();
  const project = await pool.query<{ id: string }>(
    "SELECT id FROM projects WHERE name = '设计协作演示 · 本轮改动验证'"
  ).catch(() => ({ rows: [] as { id: string }[] }));
  const projectId = project.rows[0]?.id ?? null;

  for (const [figmaKey, frames] of Object.entries(FRAME_SPECS)) {
    const fileId = await ensureFile(
      figmaKey,
      figmaKey === 'demo-phone' ? '移动端 · 会员中心' : '后台 · 数据看板',
      projectId
    );
    let sort = 0;
    for (const [frameName, nodes] of Object.entries(frames)) {
      const isPhone = figmaKey === 'demo-phone';
      const frameId = await ensureFrame(fileId, frameName, isPhone ? 390 : 1440, isPhone ? 844 : 900, sort++);
      await pool.query('DELETE FROM nodes WHERE frame_id = $1', [frameId]);
      for (const n of nodes) {
        await pool.query(
          `INSERT INTO nodes (file_id, frame_id, node_id, parent_id, name, type, x, y, width, height, visible, props)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11)`,
          [
            fileId,
            frameId,
            `${figmaKey}:${frameName}:${n.id}`,
            n.parent ? `${figmaKey}:${frameName}:${n.parent}` : null,
            n.name,
            n.type,
            n.x,
            n.y,
            n.w,
            n.h,
            JSON.stringify(toProps(n)),
          ]
        );
      }
      console.log(`seeded nodes: ${frameName} (${nodes.length})`);
    }
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
