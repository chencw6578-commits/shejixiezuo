/**
 * 站点品牌「拾像素」——现代简约文艺风。
 *
 * 图形语义：开放的细线取景框里散落着几粒像素，右上角一枚暖赭色像素被轻轻「拾」起，
 * 微微倾斜，留白与一段极淡的虚线弧构成俯身拾取的动作。像素是设计的最小单位，
 * 「拾」是把散落的灵感一一拣起来。
 * 纯 SVG、无外部字体与图片依赖，16px（favicon）到 64px（登录页）都清晰。
 */
export const BRAND_NAME = '拾像素';
export const BRAND_TAGLINE = '设计协作与交付平台';

/** 品牌色：墨蓝灰用于骨架与像素，暖赭只用于被拾起的那一粒，米白为纸感底色 */
export const BRAND_INK = '#2C3A43';
export const BRAND_ACCENT = '#C2795B';
export const BRAND_PAPER = '#FAF9F6';

export function BrandMark({
  size = 44,
  className = '',
  title,
}: {
  size?: number;
  className?: string;
  /** 传入时图形作为可访问图片（带名称）；默认纯装饰，配合旁边的文字使用 */
  title?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* 开放取景框：右上留缺口，让被拾起的像素有出处 */}
      <path
        d="M12 46 V22 a6 6 0 0 1 6 -6 h12"
        fill="none" stroke={BRAND_INK} strokeWidth="1.6" strokeLinecap="round"
      />
      <path
        d="M12 46 h24 a6 6 0 0 0 6 -6"
        fill="none" stroke={BRAND_INK} strokeWidth="1.6" strokeLinecap="round"
      />
      {/* 框内散落的像素：由深到浅，留出呼吸感 */}
      <rect x="20" y="26" width="6" height="6" rx="1.2" fill={BRAND_INK} opacity="0.38" />
      <rect x="30" y="26" width="6" height="6" rx="1.2" fill={BRAND_INK} opacity="0.20" />
      <rect x="20" y="36" width="6" height="6" rx="1.2" fill={BRAND_INK} opacity="0.20" />
      {/* 拾起的轨迹：一段若有若无的虚线弧 */}
      <path
        d="M38 21 Q41 14 45 13"
        fill="none" stroke={BRAND_ACCENT} strokeWidth="1"
        strokeDasharray="2 3" opacity="0.55"
      />
      {/* 被拾起的那一粒：微微倾斜，全图唯一暖色 */}
      <rect
        x="42" y="7" width="10" height="10" rx="2"
        fill={BRAND_ACCENT} transform="rotate(12 47 12)"
      />
    </svg>
  );
}
