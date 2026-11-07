/** 设计尺寸单位：只影响数值后缀/标注，不改变尺寸与坐标数据（1:1 显示） */
export type Unit = 'px' | 'pt' | 'dp';

const KEY = 'designhub-unit';

export function readUnit(): Unit {
  const v = localStorage.getItem(KEY);
  return v === 'pt' || v === 'dp' ? v : 'px';
}

export function saveUnit(u: Unit) {
  localStorage.setItem(KEY, u);
}

export function unitLabel(u: Unit): string {
  return u === 'pt' ? 'pt（iOS）' : u === 'dp' ? 'dp（Android）' : 'px（Web）';
}
