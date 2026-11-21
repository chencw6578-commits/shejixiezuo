/** 设计尺寸单位：px/pt/dp 只换后缀（1:1）；rpx 按画板宽度换算成 750rpx 制 */
export type Unit = 'px' | 'pt' | 'dp' | 'rpx';

/**
 * 把原始 px 标注值换算成目标单位显示值。
 * rpx：微信规定 750rpx = 屏幕宽度，设计稿宽度即屏幕宽度，故系数 = 750 / baseWidth。
 *      例：375 宽的稿 ×2（375→750），750 宽的稿 ×1。
 * px/pt/dp：数值不变，仅后缀不同（沿用原 1:1 显示约定）。
 */
export function unitValue(raw: number, unit: Unit, baseWidth: number): number {
  if (unit !== 'rpx') return raw;
  if (!baseWidth || baseWidth <= 0) return raw;
  return Math.round((raw * 750) / baseWidth);
}

const KEY = 'designhub-unit';

export function readUnit(): Unit {
  const v = localStorage.getItem(KEY);
  return v === 'pt' || v === 'dp' || v === 'rpx' ? v : 'px';
}

export function saveUnit(u: Unit) {
  localStorage.setItem(KEY, u);
}

export function unitLabel(u: Unit): string {
  return u === 'pt' ? 'pt（iOS）' : u === 'dp' ? 'dp（Android）' : u === 'rpx' ? 'rpx（微信小程序）' : 'px（Web）';
}

/** 导入平台对应的默认单位：iOS → pt、Android → dp、Web → px */
export function unitForPlatform(platform?: string | null): Unit {
  if (platform === 'ios') return 'pt';
  if (platform === 'android') return 'dp';
  return 'px';
}
