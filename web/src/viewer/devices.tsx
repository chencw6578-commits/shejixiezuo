/** 设备尺寸规范预设：iOS（pt）/ Android（dp）/ Web（px） */
import type { ReactNode } from 'react';

export type PlatformId = 'ios' | 'android' | 'web';

export interface DevicePreset {
  id: string;
  name: string;
  /** 逻辑宽度（iOS=pt，Android=dp，Web=px） */
  width: number;
  height: number;
  /** 屏幕物理像素比（切图倍率基准，如 @3x） */
  dpr: number;
  unit: 'pt' | 'dp' | 'px';
}

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  ios: 'iOS（苹果）',
  android: 'Android（安卓）',
  web: 'Web（网页）',
};

export const DEVICES: Record<PlatformId, DevicePreset[]> = {
  ios: [
    { id: 'iphone-se', name: 'iPhone SE', width: 375, height: 667, dpr: 2, unit: 'pt' },
    { id: 'iphone-15', name: 'iPhone 15 / 15 Pro', width: 393, height: 852, dpr: 3, unit: 'pt' },
    { id: 'iphone-15-max', name: 'iPhone 15 Plus / Pro Max', width: 430, height: 932, dpr: 3, unit: 'pt' },
    { id: 'ipad-11', name: 'iPad mini / Pro 11"', width: 834, height: 1194, dpr: 2, unit: 'pt' },
  ],
  android: [
    { id: 'android-small', name: '小屏手机', width: 360, height: 640, dpr: 2, unit: 'dp' },
    { id: 'android-phone', name: '主流手机（Pixel）', width: 412, height: 915, dpr: 2.625, unit: 'dp' },
    { id: 'android-tablet', name: '平板', width: 800, height: 1280, dpr: 2, unit: 'dp' },
  ],
  web: [
    { id: 'web-desktop-l', name: '桌面 · 1440', width: 1440, height: 900, dpr: 1, unit: 'px' },
    { id: 'web-desktop', name: '桌面 · 1280', width: 1280, height: 800, dpr: 1, unit: 'px' },
    { id: 'web-tablet', name: '平板', width: 768, height: 1024, dpr: 2, unit: 'px' },
    { id: 'web-mobile', name: '手机', width: 375, height: 812, dpr: 3, unit: 'px' },
  ],
};

export const ALL_DEVICES: DevicePreset[] = Object.values(DEVICES).flat();

export function findDevice(id: string): DevicePreset | null {
  return ALL_DEVICES.find((d) => d.id === id) ?? null;
}

/** 切图倍率选项（按平台规范：iOS @1x/@2x/@3x，Android 密度，Web 1x/2x） */
export const EXPORT_SCALES: Record<PlatformId, { value: string; label: string }[]> = {
  ios: [
    { value: '1', label: '1x' },
    { value: '2', label: '2x' },
    { value: '3', label: '3x' },
  ],
  android: [
    { value: '1', label: '1x mdpi' },
    { value: '1.5', label: '1.5x hdpi' },
    { value: '2', label: '2x xhdpi' },
    { value: '3', label: '3x xxhdpi' },
    { value: '4', label: '4x xxxhdpi' },
  ],
  web: [
    { value: '1', label: '1x' },
    { value: '2', label: '2x' },
  ],
};

/** <select> 里的平台分组 <optgroup>（调用方自带默认 option） */
export function DeviceOptionGroups(): ReactNode {
  return (Object.keys(DEVICES) as PlatformId[]).map((pid) => (
    <optgroup key={pid} label={PLATFORM_LABEL[pid]}>
      {DEVICES[pid].map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}（{d.width}×{d.height} {d.unit}）
        </option>
      ))}
    </optgroup>
  ));
}
