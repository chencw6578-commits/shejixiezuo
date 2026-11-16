import type { SVGProps } from 'react';
import {
  AlignCenterHorizontal as AlignCenterHorizontalLucide,
  AlignCenterVertical as AlignCenterVerticalLucide,
  AlignEndHorizontal as AlignEndHorizontalLucide,
  AlignEndVertical as AlignEndVerticalLucide,
  AlignHorizontalDistributeCenter as AlignHorizontalDistributeCenterLucide,
  AlignStartHorizontal as AlignStartHorizontalLucide,
  AlignStartVertical as AlignStartVerticalLucide,
  AlignVerticalDistributeCenter as AlignVerticalDistributeCenterLucide,
  ArrowLeft as ArrowLeftLucide,
  ArrowLeftRight as ArrowLeftRightLucide,
  Check as CheckLucide,
  ChevronDown as ChevronDownLucide,
  ChevronRight as ChevronRightLucide,
  ChevronsUpDown as ChevronsUpDownLucide,
  Copy as CopyLucide,
  Download as DownloadLucide,
  ExternalLink as ExternalLinkLucide,
  FileText as FileTextLucide,
  Folder as FolderLucide,
  FolderClosed as FolderClosedLucide,
  FolderMinus as FolderMinusLucide,
  FolderPlus as FolderPlusLucide,
  Image as ImageLucide,
  KeyRound as KeyRoundLucide,
  Layers as LayersLucide,
  Link as LinkLucide,
  LogOut as LogOutLucide,
  Mail as MailLucide,
  Maximize as MaximizeLucide,
  Menu as MenuLucide,
  MessageSquare as MessageSquareLucide,
  Minus as MinusLucide,
  MoreHorizontal as MoreHorizontalLucide,
  Palette as PaletteLucide,
  PanelRight as PanelRightLucide,
  Pencil as PencilLucide,
  Pipette as PipetteLucide,
  Plus as PlusLucide,
  Scissors as ScissorsLucide,
  Search as SearchLucide,
  Share2 as Share2Lucide,
  Trash2 as Trash2Lucide,
  Upload as UploadLucide,
  Users as UsersLucide,
  X as XLucide,
  type LucideIcon,
} from 'lucide-react';

/**
 * 全站图标统一走 lucide（https://lucide.dev）——线性 stroke 风格，ISC 许可。
 * 这一层保持旧有的 46 个导出名不变，使 7 个消费文件 79 处使用点零改动。
 * 所有组件都接受 size + 标准 SVG props，与旧 API 一致；size 默认 16（lucide 默认 24）。
 * 对齐/分布图标在 lucide 中无完全同名物，采用语义最近的 Align* 系列映射。
 */
interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
}

const wrap = (Comp: LucideIcon) =>
  function Icon(props: IconProps) {
    return <Comp size={16} {...props} />;
  };

/* ---------- 常规 UI 图标 ---------- */
export const LinkIcon = wrap(LinkLucide);
export const ImageIcon = wrap(ImageLucide);
export const Sip = wrap(PipetteLucide);
export const ChevronRight = wrap(ChevronRightLucide);
export const ChevronDown = wrap(ChevronDownLucide);
export const CollapseAll = wrap(ChevronsUpDownLucide);
export const Search = wrap(SearchLucide);
export const Pencil = wrap(PencilLucide);
export const MoreHorizontal = wrap(MoreHorizontalLucide);
export const Trash2 = wrap(Trash2Lucide);
export const Plus = wrap(PlusLucide);
export const Minus = wrap(MinusLucide);
export const Maximize = wrap(MaximizeLucide);
export const Menu = wrap(MenuLucide);
export const ArrowLeft = wrap(ArrowLeftLucide);
export const PanelRight = wrap(PanelRightLucide);
export const Folder = wrap(FolderLucide);
export const FolderFilled = wrap(FolderClosedLucide);
export const FolderMinus = wrap(FolderMinusLucide);
export const FolderAdd = wrap(FolderPlusLucide);
export const FileText = wrap(FileTextLucide);
export const Scissors = wrap(ScissorsLucide);
export const KeyRound = wrap(KeyRoundLucide);
export const Users = wrap(UsersLucide);
export const Upload = wrap(UploadLucide);
export const Download = wrap(DownloadLucide);
export const MessageSquare = wrap(MessageSquareLucide);
export const Palette = wrap(PaletteLucide);
export const Check = wrap(CheckLucide);
export const X = wrap(XLucide);
export const AlignLeft = wrap(AlignStartHorizontalLucide);
export const Mail = wrap(MailLucide);
export const Layers = wrap(LayersLucide);
export const LogOut = wrap(LogOutLucide);
export const ArrowLeftRight = wrap(ArrowLeftRightLucide);
export const Share2 = wrap(Share2Lucide);
export const Copy = wrap(CopyLucide);
export const ExternalLink = wrap(ExternalLinkLucide);

/* ---------- 多选画板对齐 / 等间距 ----------
   lucide 无与 Remix align-item-* 完全同名者，语义映射：
   左/水平居中/右 → AlignStart/Center/EndHorizontal
   上/垂直居中/下 → AlignStart/Center/EndVertical
   等距（水平/垂直）→ AlignHorizontalDistributeCenter / AlignVerticalDistributeCenter */
export const AlignFrameLeft = wrap(AlignStartHorizontalLucide);
export const AlignFrameHCenter = wrap(AlignCenterHorizontalLucide);
export const AlignFrameRight = wrap(AlignEndHorizontalLucide);
export const AlignFrameTop = wrap(AlignStartVerticalLucide);
export const AlignFrameVCenter = wrap(AlignCenterVerticalLucide);
export const AlignFrameBottom = wrap(AlignEndVerticalLucide);
export const DistributeH = wrap(AlignHorizontalDistributeCenterLucide);
export const DistributeV = wrap(AlignVerticalDistributeCenterLucide);
