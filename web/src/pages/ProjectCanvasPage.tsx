import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, getIdentity, setActiveTeam } from '../api';
import type { FileDetail, FrameLink, ProjectFrameRow, ProjectPageRow } from '../types';
import { findDevice } from '../viewer/devices';
import { useDialogs } from '../components/Dialogs';
import { canvasBgStyle, useCanvasBg } from '../canvasBg';
import CanvasBgPicker from '../components/CanvasBgPicker';
import RowMenu from '../components/RowMenu';
import {
  AlignFrameBottom,
  AlignFrameHCenter,
  AlignFrameLeft,
  AlignFrameRight,
  AlignFrameTop,
  AlignFrameVCenter,
  ArrowLeft,
  Check,
  ChevronDown,
  CollapseAll,
  ChevronRight,
  Copy,
  DistributeH,
  DistributeV,
  ExternalLink,
  Folder,
  FolderMinus,
  ImageIcon,
  LinkIcon,
  Maximize,
  Minus,
  Plus,
  Share2,
  Trash2,
  X,
} from '../components/icons';

// ---------- 画板连线：几何与命中工具 ----------
type PortSide = 'top' | 'right' | 'bottom' | 'left';
interface CanvasRect { x: number; y: number; w: number; h: number }
interface LinkDraft {
  fromId: string;
  /** 出线边：按目标画板方位自动计算，避免曲线穿过起点画板内容 */
  side: PortSide;
  /** 光标位置（世界坐标） */
  cursor: { x: number; y: number };
  targetId: string | null;
}

/** 按目标相对起点画板的方位挑出线边（宽高归一化，避免画板比例影响判断） */
function pickLinkSide(a: CanvasRect, p: { x: number; y: number }): PortSide {
  const dx = (p.x - (a.x + a.w / 2)) / Math.max(1, a.w / 2);
  const dy = (p.y - (a.y + a.h / 2)) / Math.max(1, a.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** 画板四边中点（世界坐标） */
function portPoint(r: CanvasRect, side: PortSide) {
  if (side === 'top') return { x: r.x + r.w / 2, y: r.y };
  if (side === 'right') return { x: r.x + r.w, y: r.y + r.h / 2 };
  if (side === 'bottom') return { x: r.x + r.w / 2, y: r.y + r.h };
  return { x: r.x, y: r.y + r.h / 2 };
}

/** 两个画板之间的贝塞尔曲线：从用户拖出的那一侧出线，落到目标画板相向的一侧 */
function linkCurve(a: CanvasRect, b: CanvasRect, side: PortSide, z: number, ox: number, oy: number) {
  const p1 = portPoint(a, side);
  let p2: { x: number; y: number };
  let c1: { x: number; y: number };
  let c2: { x: number; y: number };
  if (side === 'right' || side === 'left') {
    const s = side === 'right' ? 1 : -1;
    p2 = { x: s > 0 ? b.x : b.x + b.w, y: b.y + b.h / 2 };
    const bend = Math.max(30, Math.abs(p2.x - p1.x) * 0.42);
    c1 = { x: p1.x + s * bend, y: p1.y };
    c2 = { x: p2.x - s * bend, y: p2.y };
  } else {
    const s = side === 'bottom' ? 1 : -1;
    p2 = { x: b.x + b.w / 2, y: s > 0 ? b.y : b.y + b.h };
    const bend = Math.max(30, Math.abs(p2.y - p1.y) * 0.42);
    c1 = { x: p1.x, y: p1.y + s * bend };
    c2 = { x: p2.x, y: p2.y - s * bend };
  }
  // 世界坐标 → SVG 局部坐标（画布缩放 + SVG 原点偏移）
  const t = (p: { x: number; y: number }) => ({ x: p.x * z - ox, y: p.y * z - oy });
  const P1 = t(p1);
  const C1 = t(c1);
  const C2 = t(c2);
  const P2 = t(p2);
  const d = `M ${P1.x} ${P1.y} C ${C1.x} ${C1.y}, ${C2.x} ${C2.y}, ${P2.x} ${P2.y}`;
  const mid = {
    x: (P1.x + 3 * C1.x + 3 * C2.x + P2.x) / 8,
    y: (P1.y + 3 * C1.y + 3 * C2.y + P2.y) / 8,
  };
  return { d, mid };
}

function worldPointAt(clientX: number, clientY: number, rect: DOMRect, pan: { x: number; y: number }, z: number) {
  return { x: (clientX - rect.left - pan.x) / z, y: (clientY - rect.top - pan.y) / z };
}

/** 光标下最上层的目标画板（跳过连线 SVG 的命中层，排除起点自身） */
function frameIdAtPoint(x: number, y: number, exclude?: string): string | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const frame = (el as HTMLElement).closest?.('.pcanvas-frame[data-frame-id]') as HTMLElement | null;
    if (frame) {
      const id = frame.getAttribute('data-frame-id');
      if (id && id !== exclude) return id;
    }
  }
  return null;
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending: { text: '排队中', cls: 'status-wait' },
  processing: { text: '解析中', cls: 'status-wait' },
  ready: { text: '就绪', cls: 'status-ok' },
  failed: { text: '失败', cls: 'status-err' },
};

const SOURCE_TAG: Record<string, string> = { sketch: 'Sketch', psd: 'PSD', figma: 'Figma', plugin: 'Figma 插件' };

/**
 * 用户可见的错误文案：后端已给出可操作文案时原样展示；
 * JS 原生运行时错误（TypeError 等）只显示可读兜底，不把堆栈细节抛给用户。
 */
function readableError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw) return fallback;
  const nativeRuntime = /is not iterable|cannot read propert|reading '|undefined is not|is not a function|Symbol\(Symbol\.iterator\)|Cannot destructure|of undefined|of null/i;
  return nativeRuntime.test(raw) ? fallback : raw;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
// 画布布局常量（世界坐标）：组线框内边距与空编组尺寸
const GROUP_PAD = 32; // 组线框内边距
const GROUP_HEAD_H = 36; // 组标题占高（线框内顶部）

interface Placed {
  f: ProjectFrameRow;
  px: number;
  py: number;
}

/** 画布上的编组线框（pageId=null 为未分组：只画标题、不画框） */
interface GroupBox {
  key: string;
  fileId: string;
  pageId: string | null;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  frameIds: string[];
}

/** 右键菜单状态（画板卡片上右键：新建/移入/移出编组、取消选中） */
interface CtxMenuState {
  x: number;
  y: number;
  frameId: string;
}

/** 画布上的一次拖动会话（自由坐标） */
interface DragSession {
  startClientX: number;
  startClientY: number;
  moved: boolean;
  ids: string[];
  startPos: Map<string, { x: number; y: number }>;
}

/** 拖动时的对齐参考线（世界坐标） */
interface Guides {
  v: number | null;
  h: number | null;
}

/** 撤销栈条目：自带服务端回滚动作 */
interface HistoryEntry {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

export default function ProjectCanvasPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<{ id: string; name: string; team_id: string | null; team_name: string | null } | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const readOnlyRef = useRef(false);
  // ---------- 画板连线（有向，落库；公开只读分享里只展示不可编辑） ----------
  const [links, setLinks] = useState<FrameLink[]>([]);
  const linksRef = useRef<FrameLink[]>([]);
  // 连线编辑模式：只控制「能否创建/删除连线」，不控制线条显隐（关闭时线条仍完整展示）
  const [linkMode, setLinkMode] = useState(false);
  const linkModeRef = useRef(false);
  linkModeRef.current = linkMode;
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const linkDraftRef = useRef<LinkDraft | null>(null);
  const [hoverLinkId, setHoverLinkId] = useState<string | null>(null);
  const [frames, setFrames] = useState<ProjectFrameRow[]>([]);
  const [pages, setPages] = useState<ProjectPageRow[]>([]);
  const [files, setFiles] = useState<FileDetail[]>([]);
  // ---------- 画布/侧栏多选与编组 ----------
  const [selectedFrames, setSelectedFrames] = useState<Set<string>>(new Set());
  const selectionAnchorRef = useRef<string | null>(null);
  // 是否刚发生画板拖拽：屏蔽拖拽结束后的单击/双击
  const draggedRef = useRef(false);
  const dragFrameIdRef = useRef<string | null>(null);
  const [dragFrameId, setDragFrameId] = useState<string | null>(null);
  const [dropPageId, setDropPageId] = useState<string | null>(null);
  const [dropFrameHint, setDropFrameHint] = useState<{ frameId: string; position: 'before' | 'after' } | null>(null);
  const [openPages, setOpenPages] = useState<Set<string>>(new Set());
  const knownPagesRef = useRef<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  // ---------- 画板名称标签：双击行内重命名 ----------
  const [renamingFrameId, setRenamingFrameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renamingIdRef = useRef<string | null>(null);
  const renameValueRef = useRef('');
  const [error, setError] = useState('');
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  // 左键在空白处按下 = 平移（拖动生效；未移动的单击仍是取消选择）
  const leftPanRef = useRef(false);
  const dragMovedRef = useRef(false);
  // 空格按住 = 平移模式（Figma 式）：光标变抓手，松开后才允许点击画板
  const [spacePan, setSpacePan] = useState(false);
  const spaceRef = useRef(false);
  // ---------- 画布自由坐标（frames.canvas_x / canvas_y） ----------
  const [pos, setPos] = useState<Map<string, { x: number; y: number }>>(new Map());
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const framesRef = useRef<ProjectFrameRow[]>([]);
  const layoutRef = useRef<{ bands: GroupBox[]; minX: number; minY: number; maxX: number; maxY: number }>({
    bands: [],
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
  });
  const dragSessionRef = useRef<DragSession | null>(null);
  // 抓组名/组框拖动 = 整组平移（不改变成员归属）
  const groupDragRef = useRef<{
    startClientX: number;
    startClientY: number;
    ids: string[];
    startPos: Map<string, { x: number; y: number }>;
    moved: boolean;
  } | null>(null);
  const [groupDelta, setGroupDelta] = useState<{ x: number; y: number } | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const marqueeRef = useRef<{
    startClientX: number;
    startClientY: number;
    rect: DOMRect;
    base: Set<string>;
    shift: boolean;
    moved: boolean;
  } | null>(null);
  const [guides, setGuides] = useState<Guides>({ v: null, h: null });
  const saveTimerRef = useRef<number | null>(null);
  // 撤销/重做（每条记录自带服务端回滚动作，上限 50 条）
  const undoStackRef = useRef<HistoryEntry[]>([]);
  const redoStackRef = useRef<HistoryEntry[]>([]);
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<number | null>(null);
  const arrowBurstRef = useRef<{ before: Map<string, { x: number; y: number }>; ids: string[] } | null>(null);
  const arrowTimerRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // 画布平移偏移（transform 实现，无需滚动空间，任意方向可拖）
  const [pan, setPanState] = useState({ x: 0, y: 0 });
  const panXYRef = useRef({ x: 0, y: 0 });
  const setPanXY = useCallback((x: number, y: number) => {
    panXYRef.current = { x, y };
    setPanState({ x, y });
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // ---------- 公开只读分享：顶栏按钮 → 生成/复制/关闭免登录链接 ----------
  const [shareOpen, setShareOpen] = useState(false);
  const [shareState, setShareState] = useState<{ active: boolean; url: string | null }>({ active: false, url: null });
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState('');
  const [shareCopied, setShareCopied] = useState(false);

  const toggleShare = () => {
    const next = !shareOpen;
    setShareOpen(next);
    setShareCopied(false);
    setShareError('');
    if (next && projectId) {
      api.shareStatus(projectId)
        .then(setShareState)
        .catch((e) => setShareError(e instanceof Error ? e.message : '读取分享状态失败'));
    }
  };
  const enableShare = async () => {
    if (!projectId || shareBusy) return;
    setShareBusy(true);
    setShareError('');
    try {
      setShareState(await api.enableShare(projectId));
    } catch (e) {
      setShareError(e instanceof Error ? e.message : '生成分享链接失败');
    } finally {
      setShareBusy(false);
    }
  };
  const disableShare = async () => {
    if (!projectId || shareBusy) return;
    setShareBusy(true);
    setShareError('');
    try {
      setShareState(await api.disableShare(projectId));
      setShareCopied(false);
    } catch (e) {
      setShareError(e instanceof Error ? e.message : '关闭分享失败');
    } finally {
      setShareBusy(false);
    }
  };
  const copyShare = async () => {
    if (!shareState.url) return;
    const full = `${window.location.origin}${shareState.url}`;
    try {
      await navigator.clipboard.writeText(full);
    } catch {
      // 非安全上下文 / 没有剪贴板权限时退回选中复制，输入框本身也可手动复制
      const el = document.createElement('textarea');
      el.value = full;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try { document.execCommand('copy'); } catch { /* 忽略 */ }
      el.remove();
    }
    setShareCopied(true);
  };

  // 导入面板
  const [importOpen, setImportOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  // 导入等待秒数：让「正在读取节点…」有可见进度，而不是干等到超时才发现
  const [busySec, setBusySec] = useState(0);
  useEffect(() => {
    if (!busy) {
      setBusySec(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setBusySec(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const [uploading, setUploading] = useState('');
  // 第二种导入方式：Figma 插件导出的 JSON（粘贴文本或选择 .json 文件）
  const [importMode, setImportMode] = useState<'url' | 'json'>('url');
  const [jsonText, setJsonText] = useState('');
  const [jsonFileName, setJsonFileName] = useState('');
  const [jsonBusy, setJsonBusy] = useState(false);
  const jsonFileRef = useRef<HTMLInputElement>(null);
  // 服务端统一 Figma 令牌是否就绪（null = 探测中/探测失败）
  const [figmaConfigured, setFigmaConfigured] = useState<boolean | null>(null);
  // 高级选项：用户个人令牌（仅本次导入使用，不落库、不写 localStorage）
  const [personalToken, setPersonalToken] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 小屏左侧画板列表抽屉
  const [drawer, setDrawer] = useState<'none' | 'left'>('none');
  // 画布底色（localStorage，按用户，跨项目共用）
  const [canvasBg, pickCanvasBg] = useCanvasBg();
  const bg = canvasBgStyle(canvasBg);

  const setZoom = useCallback((z: number) => {
    zoomRef.current = clamp(z, MIN_ZOOM, MAX_ZOOM);
    setZoomState(zoomRef.current);
  }, []);

  /** 更新画布坐标（同时写 ref，供 pointer 事件实时读取） */
  const updatePositions = useCallback((next: Map<string, { x: number; y: number }>) => {
    posRef.current = next;
    setPos(next);
  }, []);

  const load = useCallback(() => {
    if (!projectId) return;
    api.getProject(projectId).then((p) => {
      setProject(p);
      setActiveTeam(p.team_id ?? null);
      const ro = getIdentity(p.team_id ?? '')?.role === 'collaborator';
      readOnlyRef.current = ro;
      setReadOnly(ro);
    }).catch((e) => setError(e.message));
    // 隧道偶发截断 JSON，解析失败会兜底为 {}，这里强制归一为数组避免 .map 崩溃
    api.listFiles(projectId).then((rows) => setFiles(Array.isArray(rows) ? rows : [])).catch(() => undefined);
    // 连线与画板同批加载；端点画板已删除的连线由后端级联清理，前端渲染时再兜底过滤
    api.listFrameLinks(projectId).then((rows) => {
      const arr = Array.isArray(rows) ? rows : [];
      linksRef.current = arr;
      setLinks(arr);
    }).catch(() => undefined);
    api
      .listProjectFrames(projectId)
      .then((r) => {
        const nextFrames = Array.isArray(r?.frames) ? r.frames : [];
        const nextPages = Array.isArray(r?.pages) ? r.pages : [];
        setFrames(nextFrames);
        setPages(nextPages);
        framesRef.current = nextFrames;
        // 画布坐标：有坐标直接用；历史/新导入没坐标的自动铺一次初始位置并落库（之后完全自由拖动）
        {
          const nextPos = new Map(posRef.current);
          for (const id of [...nextPos.keys()]) {
            if (!nextFrames.some((f) => f.id === id)) nextPos.delete(id);
          }
          const dragging = dragSessionRef.current?.ids ?? [];
          const missing: ProjectFrameRow[] = [];
          for (const f of nextFrames) {
            if (typeof f.canvas_x === 'number' && typeof f.canvas_y === 'number') {
              if (!dragging.includes(f.id)) nextPos.set(f.id, { x: f.canvas_x, y: f.canvas_y });
            } else if (!nextPos.has(f.id)) {
              missing.push(f);
            }
          }
          if (missing.length) {
            let baseY = 0;
            for (const f of nextFrames) {
              const p = nextPos.get(f.id);
              if (p) baseY = Math.max(baseY, p.y + f.height);
            }
            const gap = 56;
            const cols = 4;
            const colW = Math.max(240, ...missing.map((f) => f.width)) + gap;
            const rowH = Math.max(240, ...missing.map((f) => f.height)) + gap;
            missing.forEach((f, i) => {
              nextPos.set(f.id, {
                x: (i % cols) * colW,
                y: baseY + (baseY ? gap : 0) + Math.floor(i / cols) * rowH,
              });
            });
          }
          updatePositions(nextPos);
          if (missing.length && !readOnlyRef.current) {
            const byFile = new Map<string, { id: string; x: number; y: number }[]>();
            for (const f of missing) {
              const p = nextPos.get(f.id)!;
              const arr = byFile.get(f.file_id) ?? [];
              arr.push({ id: f.id, x: Math.round(p.x), y: Math.round(p.y) });
              byFile.set(f.file_id, arr);
            }
            for (const [fileId, entries] of byFile) {
              api.setFramePositions(fileId, entries).catch(() => undefined);
            }
          }
        }
        // 刷新后保持选中，但剔除已被删除的画板
        setSelectedFrames((s) => {
          const valid = new Set(nextFrames.map((f) => f.id));
          const kept = new Set([...s].filter((id) => valid.has(id)));
          return kept.size === s.size ? s : kept;
        });
        // 首次加载：按 localStorage 记忆的折叠状态恢复；之后只展开新增编组
        setOpenPages((prev) => {
          const next = new Set(prev);
          if (!knownPagesRef.current.size) {
            let collapsed = new Set<string>();
            try {
              collapsed = new Set(JSON.parse(localStorage.getItem(`pcanvas:collapsed:${projectId}`) || '[]'));
            } catch {
              collapsed = new Set();
            }
            if (!collapsed.has('__none:global')) next.add('__none:global');
            for (const pg of nextPages) if (!collapsed.has(pg.id)) next.add(pg.id);
          } else {
            for (const pg of nextPages) if (!knownPagesRef.current.has(pg.id)) next.add(pg.id);
          }
          for (const pg of nextPages) knownPagesRef.current.add(pg.id);
          return next;
        });
      })
      .catch((e) => setError(e.message));
  }, [projectId]);

  useEffect(load, [load]);

  // ---------- 重命名：设计稿 / 画板（画布标题与侧栏均可触发） ----------
  const dialogs = useDialogs();
  const renameFile = async (fileId: string, current: string) => {
    const name = await dialogs.prompt({
      title: '修改设计稿名称',
      label: '设计稿名称',
      initialValue: current,
      maxLength: 100,
      validate: (v) =>
        files.some((f) => f.id !== fileId && f.name === v) ? `项目内已存在同名设计稿「${v}」` : null,
    });
    if (!name || name === current) return;
    try {
      await api.renameFile(fileId, name);
      recordHistory({
        label: '重命名设计稿',
        undo: () => api.renameFile(fileId, current).then(() => undefined),
        redo: () => api.renameFile(fileId, name).then(() => undefined),
      });
      load();
    } catch (e) {
      void dialogs.alert(e instanceof Error ? e.message : '重命名失败');
    }
  };
  const renameFrame = async (f: ProjectFrameRow) => {
    const name = await dialogs.prompt({
      title: '修改画板名称',
      label: '画板名称',
      initialValue: f.name,
      maxLength: 100,
      validate: (v) =>
        frames.some((x) => x.id !== f.id && x.file_id === f.file_id && x.name === v)
          ? `该设计稿内已存在同名画板「${v}」`
          : null,
    });
    if (!name || name === f.name) return;
    try {
      await api.renameFrame(f.file_id, f.id, name);
      recordHistory({
        label: '重命名画板',
        undo: () => api.renameFrame(f.file_id, f.id, f.name).then(() => undefined),
        redo: () => api.renameFrame(f.file_id, f.id, name).then(() => undefined),
      });
      load();
    } catch (e) {
      void dialogs.alert(e instanceof Error ? e.message : '重命名失败');
    }
  };
  /** 画板名称标签行内编辑：Enter / 失焦提交，Esc 取消；与对话框重命名共用同名校验与历史记录。 */
  const commitFrameRename = async (f: ProjectFrameRow) => {
    if (renamingIdRef.current !== f.id) return;
    renamingIdRef.current = null;
    setRenamingFrameId(null);
    const name = renameValueRef.current.trim();
    if (!name || name === f.name) return;
    if (frames.some((x) => x.id !== f.id && x.file_id === f.file_id && x.name === name)) {
      void dialogs.alert(`该设计稿内已存在同名画板「${name}」`);
      return;
    }
    try {
      await api.renameFrame(f.file_id, f.id, name);
      recordHistory({
        label: '重命名画板',
        undo: () => api.renameFrame(f.file_id, f.id, f.name).then(() => undefined),
        redo: () => api.renameFrame(f.file_id, f.id, name).then(() => undefined),
      });
      load();
    } catch (e) {
      void dialogs.alert(e instanceof Error ? e.message : '重命名失败');
    }
  };
  /**
   * 删除选中画板：单个、框选批量、跨设计稿统一走这一条链路。
   * 按 file_id 分组调用批量接口（跨稿也支持），全部成功后才清选中并刷新。
   */
  const removeFrames = async (ids: string[]) => {
    if (readOnlyRef.current) return;
    const byId = new Map(frames.map((f) => [f.id, f]));
    const unique = [...new Set(ids)].filter((id) => byId.has(id));
    if (!unique.length) return;
    const byFile = new Map<string, string[]>();
    for (const id of unique) {
      const fileId = byId.get(id)!.file_id;
      byFile.set(fileId, [...(byFile.get(fileId) ?? []), id]);
    }
    const names = unique.map((id) => byId.get(id)!.name);
    const one = unique.length === 1;
    const ok = await dialogs.confirm({
      title: one ? `删除画板「${names[0]}」` : `删除选中的 ${unique.length} 个画板`,
      message: one
        ? '该画板及其图层、评论将被删除，且不可恢复。'
        : `${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''} 及其图层、评论将被删除，且不可恢复。${
            byFile.size > 1 ? `（跨 ${byFile.size} 个设计稿）` : ''
          }`,
      confirmText: one ? '确认删除' : `删除 ${unique.length} 个画板`,
      danger: true,
    });
    if (!ok) return;
    try {
      await Promise.all([...byFile].map(([fileId, group]) => api.deleteFrames(fileId, group)));
      setSelectedFrames((s) => new Set([...s].filter((id) => !unique.includes(id))));
      setCtxMenu(null);
      load();
    } catch (e) {
      void dialogs.alert(e instanceof Error ? e.message : '删除失败');
    }
  };

  /** 删除单个画板（侧栏右键菜单沿用，委托给统一链路） */
  const removeFrame = async (f: ProjectFrameRow) => removeFrames([f.id]);

  // ---------- 编组（页面）语义：与查看器 ViewerPage 一致 ----------
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  const hasToggleModifier = (e: { ctrlKey: boolean; metaKey: boolean }) =>
    isMac ? e.metaKey : e.ctrlKey || e.metaKey;

  const frameById = useMemo(() => new Map(frames.map((f) => [f.id, f])), [frames]);
  const fail = (e: unknown) => void dialogs.alert(e instanceof Error ? e.message : String(e));
  const sortFrames = (list: ProjectFrameRow[]) =>
    [...list].sort(
      (a, b) =>
        (a.page_sort ?? 0) - (b.page_sort ?? 0) ||
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        a.name.localeCompare(b.name)
    );
  const pagesOfFile = (fileId: string) =>
    pages.filter((p) => p.file_id === fileId).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const pageFrames = (fileId: string, pageId: string | null) =>
    sortFrames(frames.filter((f) => f.file_id === fileId && (f.page_id ?? null) === pageId));
  const groupKey = (pageId: string | null) => pageId ?? '__none:global';

  /** 侧栏「设计稿 → 编组 → 画板」树 + 全局未分组（所有设计稿的未归组画板汇总到最底部一处） */
  const { fileTree, ungrouped } = useMemo(() => {
    const order: {
      fileId: string;
      fileName: string;
      groups: { key: string; pageId: string | null; name: string; items: ProjectFrameRow[] }[];
    }[] = [];
    const loose: ProjectFrameRow[] = [];
    const fileOrder: string[] = [];
    for (const f of frames) {
      let file = order.find((x) => x.fileId === f.file_id);
      if (!file) {
        file = { fileId: f.file_id, fileName: f.file_name, groups: [] };
        order.push(file);
        fileOrder.push(f.file_id);
        const pgList = pages
          .filter((p) => p.file_id === f.file_id)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        for (const pg of pgList) file.groups.push({ key: pg.id, pageId: pg.id, name: pg.name, items: [] });
      }
      if (!f.page_id) {
        loose.push(f);
        continue;
      }
      const g = file.groups.find((x) => x.pageId === f.page_id);
      if (g) g.items.push(f);
      else loose.push(f);
    }
    for (const file of order) {
      for (const g of file.groups) {
        g.items.sort(
          (a, b) =>
            (a.page_sort ?? 0) - (b.page_sort ?? 0) ||
            (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
            a.name.localeCompare(b.name)
        );
      }
    }
    loose.sort(
      (a, b) =>
        fileOrder.indexOf(a.file_id) - fileOrder.indexOf(b.file_id) ||
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        a.name.localeCompare(b.name)
    );
    return { fileTree: order, ungrouped: loose };
  }, [frames, pages]);

  /** 侧栏拉平：所有设计稿的编组同层，附带 parent_page_id 供递归渲染（父不存在时按顶层处理） */
  const allGroups = useMemo(() => {
    const ids = new Set(pages.map((p) => p.id));
    return fileTree.flatMap((f) => f.groups.map((g) => {
      const raw = pages.find((p) => p.id === g.pageId)?.parent_page_id ?? null;
      return {
        ...g, fileId: f.fileId, fileName: f.fileName,
        parentPageId: raw && ids.has(raw) ? raw : null,
      };
    }));
  }, [fileTree, pages]);
  /** 顶层编组 + 按父取直接子编组：编组下还能再建编组 */
  const topGroups = useMemo(() => allGroups.filter((g) => !g.parentPageId), [allGroups]);
  const childGroupsOf = (parentId: string | null) =>
    allGroups.filter((g) => parentId && g.parentPageId === parentId);

  /** 侧栏当前“视觉顺序”里的画板 id：递归按 顶层编组 → 子编组 → 画板，全局未分组排最后 */
  const visibleFrameIds = () => {
    const ids: string[] = [];
    const walk = (list: typeof allGroups) => {
      for (const g of list) {
        if (!openPages.has(g.key)) continue;
        g.items.forEach((f) => ids.push(f.id));
        walk(childGroupsOf(g.pageId));
      }
    };
    walk(topGroups);
    if (openPages.has('__none:global')) ungrouped.forEach((f) => ids.push(f.id));
    return ids;
  };

  /** 选中后自动展开所在编组及其全部祖先编组，保证子编组里的画板也可见 */
  const revealSelection = (ids: Iterable<string>) => {
    setOpenPages((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        const f = frameById.get(id);
        if (!f) continue;
        next.add(groupKey(f.page_id ?? null));
        let pid = f.page_id ? pages.find((p) => p.id === f.page_id)?.parent_page_id ?? null : null;
        while (pid) {
          next.add(pid);
          pid = pages.find((p) => p.id === pid)?.parent_page_id ?? null;
        }
      }
      return next;
    });
  };

  const toggleSelect = (id: string) => {
    selectionAnchorRef.current = id;
    revealSelection([id]);
    setSelectedFrames((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const selectRangeTo = (id: string) => {
    const order = visibleFrameIds();
    const anchor = selectionAnchorRef.current;
    const a = anchor ? order.indexOf(anchor) : -1;
    const b = order.indexOf(id);
    if (a < 0 || b < 0) {
      setSelectedFrames(new Set([id]));
      return;
    }
    const [from, to] = a <= b ? [a, b] : [b, a];
    setSelectedFrames(new Set(order.slice(from, to + 1)));
  };
  const plainSelect = (id: string) => {
    selectionAnchorRef.current = id;
    setSelectedFrames(new Set([id]));
    revealSelection([id]);
  };
  const selectFrames = (ids: string[]) => {
    if (!ids.length) {
      setSelectedFrames(new Set());
      return;
    }
    selectionAnchorRef.current = ids[0];
    setSelectedFrames(new Set(ids));
    revealSelection(ids);
  };
  /** 折叠/展开编组，并把折叠状态按项目记到 localStorage（刷新后保持） */
  const togglePage = (key: string) => {
    setOpenPages((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      const allKeys = [...fileTree.flatMap((f) => f.groups.map((g) => g.key)), '__none:global'];
      try {
        localStorage.setItem(
          `pcanvas:collapsed:${projectId}`,
          JSON.stringify(allKeys.filter((k) => !n.has(k)))
        );
      } catch {
        /* 隐私模式下忽略 */
      }
      return n;
    });
  };

  /** 一键收起所有编组（含未分组），并把「全部折叠」记忆到 localStorage（刷新后保持） */
  const collapseAll = () => {
    const allKeys = [...fileTree.flatMap((f) => f.groups.map((g) => g.key)), '__none:global'];
    setOpenPages(new Set());
    try {
      localStorage.setItem(`pcanvas:collapsed:${projectId}`, JSON.stringify(allKeys));
    } catch {
      /* 隐私模式下忽略 */
    }
  };

  /** 拖拽悬停到已折叠的编组时自动展开，避免“放不进去” */
  const autoExpand = (key: string) => {
    setOpenPages((s) => {
      if (s.has(key)) return s;
      const n = new Set(s);
      n.add(key);
      try {
        localStorage.setItem(
          `pcanvas:collapsed:${projectId}`,
          JSON.stringify([...fileTree.flatMap((f) => f.groups.map((g) => g.key)), '__none:global'].filter((k) => !n.has(k)))
        );
      } catch {
        /* ignore */
      }
      return n;
    });
  };

  // 编组属于设计稿：跨稿选择不能直接建组/移入
  const selectedFileIds = () => {
    const ids = new Set<string>();
    for (const id of selectedFrames) {
      const f = frameById.get(id);
      if (f) ids.add(f.file_id);
    }
    return ids;
  };
  const selectedSingleFile = () => {
    const ids = selectedFileIds();
    return ids.size === 1 ? [...ids][0] : null;
  };
  const validatePageName = (fileId: string, value: string, exceptId?: string) =>
    pages.some((p) => p.file_id === fileId && p.id !== exceptId && p.name === value)
      ? `该设计稿内已存在同名编组「${value}」`
      : null;

  /**
   * 右键「新建编组」：parentPageId 有值时创建为该编组的子编组（支持任意深度嵌套），
   * 否则创建顶级编组。撤销时按各画板原所属编组分别还原，避免跨组选择被错误合并。
   */
  const createGroupFromSelection = async (parentPageId: string | null = null) => {
    if (!selectedFrames.size) return;
    const fileId = selectedSingleFile();
    if (!fileId) {
      await dialogs.alert('选中的画板来自多个设计稿，编组只能在同一个设计稿内创建。请分别选择后再建组。');
      return;
    }
    const ids = [...selectedFrames];
    const parent = parentPageId ? pages.find((p) => p.id === parentPageId) : null;
    const name = await dialogs.prompt({
      title: parent
        ? `在「${parent.name}」下创建子编组（${ids.length} 个画板）`
        : `新建编组（${ids.length} 个画板）`,
      label: parent ? '子编组名称' : '编组名称',
      placeholder: '例如：登录流程',
      maxLength: 50,
      validate: (v) => validatePageName(fileId, v),
    });
    if (!name) return;
    const origin = new Map(ids.map((id) => [id, frameById.get(id)?.page_id ?? null]));
    try {
      const pg = await api.createPage(fileId, name, parentPageId);
      await api.moveFramesToPage(fileId, ids, pg.id);
      knownPagesRef.current.add(pg.id);
      setOpenPages((s) => {
        const next = new Set(s).add(pg.id);
        if (parentPageId) {
          next.add(parentPageId);
          let pid = parent?.parent_page_id ?? null;
          while (pid) {
            next.add(pid);
            pid = pages.find((p) => p.id === pid)?.parent_page_id ?? null;
          }
        }
        return next;
      });
      setSelectedFrames(new Set());
      let pageId = pg.id;
      recordHistory({
        label: parent ? '创建子编组' : '新建编组',
        undo: async () => {
          const byParent = new Map<string | null, string[]>();
          for (const id of ids) {
            const p = origin.get(id) ?? null;
            byParent.set(p, [...(byParent.get(p) ?? []), id]);
          }
          for (const [p, group] of byParent) await api.moveFramesToPage(fileId, group, p);
          await api.deletePage(fileId, pageId, 'dissolve');
        },
        redo: async () => {
          pageId = (await api.createPage(fileId, name, parentPageId)).id;
          await api.moveFramesToPage(fileId, ids, pageId);
        },
      });
      load();
    } catch (e) {
      fail(e);
    }
  };

  /** 侧栏顶部「＋」：新建空编组（子编组改由选中画板后右键创建） */
  const addPage = async (fileId: string, fileName: string) => {
    const name = await dialogs.prompt({
      title: `在「${fileName}」下新建编组`,
      label: '编组名称',
      placeholder: '例如：登录流程',
      maxLength: 50,
      validate: (v) => validatePageName(fileId, v),
    });
    if (!name) return;
    try {
      const pg = await api.createPage(fileId, name);
      knownPagesRef.current.add(pg.id);
      setOpenPages((s) => new Set(s).add(pg.id));
      let pageId = pg.id;
      recordHistory({
        label: '新建编组',
        undo: () => api.deletePage(fileId, pageId, 'dissolve').then(() => undefined),
        redo: async () => {
          pageId = (await api.createPage(fileId, name)).id;
        },
      });
      load();
    } catch (e) {
      fail(e);
    }
  };

  /** 侧栏「＋」：在所选画板所属设计稿下建空编组（没有选中时用第一份设计稿） */
  const addEmptyGroup = async () => {
    const fileId = selectedSingleFile() ?? fileTree[0]?.fileId;
    if (!fileId) {
      await dialogs.alert('还没有设计稿，先导入一份再建编组。');
      return;
    }
    const fileName = fileTree.find((f) => f.fileId === fileId)?.fileName ?? '';
    await addPage(fileId, fileName);
  };

  const renamePage = async (pg: ProjectPageRow) => {
    const name = await dialogs.prompt({
      title: '重命名编组',
      label: '编组名称',
      initialValue: pg.name,
      maxLength: 50,
      validate: (v) => validatePageName(pg.file_id, v, pg.id),
    });
    if (!name || name === pg.name) return;
    try {
      const renamed = await api.renamePage(pg.file_id, pg.id, name);
      recordHistory({
        label: '重命名编组',
        undo: () => api.renamePage(pg.file_id, pg.id, pg.name).then(() => undefined),
        redo: () => api.renamePage(pg.file_id, pg.id, name).then(() => undefined),
      });
      void renamed;
      load();
    } catch (e) {
      fail(e);
    }
  };

  const removePage = async (pg: ProjectPageRow, forced?: 'dissolve' | 'content') => {
    const list = pageFrames(pg.file_id, pg.id);
    const parentPg = pg.parent_page_id ? pages.find((p) => p.id === pg.parent_page_id) : null;
    const mode = forced ?? (await dialogs.choose({
      title: `删除编组「${pg.name}」`,
      message: `该编组内有 ${list.length} 个画板，请选择处理方式：`,
      options: [
        { label: parentPg ? `解散编组，保留画板（移入上一级编组「${parentPg.name}」）` : '解散编组，保留内容（画板移入未分组）', value: 'dissolve' },
        { label: '删除编组并删除其中内容', value: 'content', danger: true },
      ],
    }));
    if (!mode) return;
    if (mode === 'content') {
      const ok = await dialogs.confirm({
        title: '再次确认',
        message: `将删除「${pg.name}」及其中的 ${list.length} 个画板、图层和评论，且不可恢复。`,
        confirmText: '确认删除',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.deletePage(pg.file_id, pg.id, mode as 'dissolve' | 'content');
      if (mode === 'dissolve') {
        const ids = list.map((f) => f.id);
        let pageId: string | null = null;
        recordHistory({
          label: '删除编组',
          undo: async () => {
            // 子编组按原父编组重建，画板从上一级编组移回；顶层编组重建后从未分组移回
            pageId = (await api.createPage(pg.file_id, pg.name, pg.parent_page_id ?? null)).id;
            if (ids.length) await api.moveFramesToPage(pg.file_id, ids, pageId);
          },
          redo: async () => {
            if (pageId) await api.deletePage(pg.file_id, pageId, 'dissolve');
          },
        });
      }
      setSelectedFrames((s) => {
        const ids = new Set(list.map((f) => f.id));
        return new Set([...s].filter((id) => !ids.has(id)));
      });
      load();
    } catch (e) {
      fail(e);
    }
  };

  const moveSelection = async (pageId: string | null) => {
    const fileId = selectedSingleFile();
    if (!fileId) {
      await dialogs.alert('选中的画板来自多个设计稿，请先只选同一设计稿内的画板再移入编组。');
      return;
    }
    try {
      const ids = [...selectedFrames];
      await api.moveFramesToPage(fileId, ids, pageId);
      const after = new Map(pagesMap(ids));
      for (const id of ids) after.set(id, pageId);
      recordMembership(pagesMap(ids), after, pageId ? '移入编组' : '移出编组');
      setSelectedFrames(new Set());
      if (pageId) setOpenPages((s) => new Set(s).add(pageId));
      load();
    } catch (e) {
      fail(e);
    }
  };

  // ---------- 对齐 / 等间距（以选区包围盒为基准，一次算一步历史） ----------
  const alignSelection = async (
    kind: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'disth' | 'distv',
    idsArg?: string[]
  ) => {
    const ids = idsArg ?? ctxIds();
    if (ids.length < 2 || readOnlyRef.current) return;
    const items = ids
      .map((id) => {
        const f = framesRef.current.find((x) => x.id === id);
        const p = posRef.current.get(id);
        return f && p ? { id, f, x: p.x, y: p.y, w: f.width, h: f.height } : null;
      })
      .filter((it): it is { id: string; f: ProjectFrameRow; x: number; y: number; w: number; h: number } => !!it);
    if (items.length < 2) return;
    const minX = Math.min(...items.map((i) => i.x));
    const maxX = Math.max(...items.map((i) => i.x + i.w));
    const minY = Math.min(...items.map((i) => i.y));
    const maxY = Math.max(...items.map((i) => i.y + i.h));
    const before = new Map<string, { x: number; y: number }>();
    for (const it of items) before.set(it.id, { x: it.x, y: it.y });
    const next = new Map(posRef.current);
    if (kind === 'disth' || kind === 'distv') {
      if (items.length < 3) return;
      const horizontal = kind === 'disth';
      const sorted = [...items].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      if (horizontal) {
        const span = last.x + last.w - first.x;
        const sizes = sorted.reduce((n, it) => n + it.w, 0);
        const gap = (span - sizes) / (sorted.length - 1);
        let cursor = first.x;
        for (const it of sorted) {
          next.set(it.id, { x: cursor, y: it.y });
          cursor += it.w + gap;
        }
      } else {
        const span = last.y + last.h - first.y;
        const sizes = sorted.reduce((n, it) => n + it.h, 0);
        const gap = (span - sizes) / (sorted.length - 1);
        let cursor = first.y;
        for (const it of sorted) {
          next.set(it.id, { x: it.x, y: cursor });
          cursor += it.h + gap;
        }
      }
    } else {
      for (const it of items) {
        const p = next.get(it.id)!;
        if (kind === 'left') next.set(it.id, { x: minX, y: p.y });
        else if (kind === 'hcenter') next.set(it.id, { x: (minX + maxX) / 2 - it.w / 2, y: p.y });
        else if (kind === 'right') next.set(it.id, { x: maxX - it.w, y: p.y });
        else if (kind === 'top') next.set(it.id, { x: p.x, y: minY });
        else if (kind === 'vcenter') next.set(it.id, { x: p.x, y: (minY + maxY) / 2 - it.h / 2 });
        else next.set(it.id, { x: p.x, y: maxY - it.h });
      }
    }
    updatePositions(next);
    await savePositions(ids);
    recordPositions(ids, before, '对齐画板');
    const label =
      kind === 'left' ? '左对齐' : kind === 'hcenter' ? '水平居中' : kind === 'right' ? '右对齐'
      : kind === 'top' ? '顶部对齐' : kind === 'vcenter' ? '垂直居中' : kind === 'bottom' ? '底部对齐'
      : kind === 'disth' ? '水平等间距' : '垂直等间距';
    flashToast(`已${label}`);
    closeCtxMenu();
  };

  // ---------- 多选浮动对齐工具条：选区包围盒上方浮现（类 Figma），readOnly 不显示 ----------
  const alignBar = useMemo(() => {
    if (readOnly || selectedFrames.size < 2) return null;
    const items = [...selectedFrames]
      .map((id) => {
        const f = frames.find((x) => x.id === id);
        const p = pos.get(id);
        return f && p ? { id, x: p.x, y: p.y, w: f.width, h: f.height } : null;
      })
      .filter((it): it is { id: string; x: number; y: number; w: number; h: number } => !!it);
    if (items.length < 2) return null;
    const minX = Math.min(...items.map((i) => i.x));
    const maxX = Math.max(...items.map((i) => i.x + i.w));
    const minY = Math.min(...items.map((i) => i.y));
    const maxY = Math.max(...items.map((i) => i.y + i.h));
    // 工具条高度固定 40px（屏幕像素，与 zoom 无关），上方留 12px 间距
    const aboveTop = minY * zoom - 52;
    // 选区太靠上放不下时，改到选区下方
    const top = aboveTop >= 4 ? aboveTop : maxY * zoom + 10;
    return {
      ids: items.map((i) => i.id),
      // 只跟随选区中心平移：条宽与按钮尺寸由 CSS 固定，不随选区尺寸 / 画布 zoom 缩放
      left: ((minX + maxX) / 2) * zoom,
      top,
    };
  }, [readOnly, selectedFrames, frames, pos, zoom]);

  // ---------- 右键菜单：轻量编组入口（默认界面不常驻任何工具条） ----------
  const ctxFrame = ctxMenu ? frameById.get(ctxMenu.frameId) : undefined;
  const ctxIds = () =>
    ctxMenu ? (selectedFrames.has(ctxMenu.frameId) ? [...selectedFrames] : [ctxMenu.frameId]) : [];
  const ctxSameFile = () =>
    !!ctxFrame && ctxIds().every((id) => frameById.get(id)?.file_id === ctxFrame.file_id);
  const openCtxMenu = (f: ProjectFrameRow, e: React.MouseEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    if (!selectedFrames.has(f.id)) plainSelect(f.id);
    setCtxMenu({ x: e.clientX, y: e.clientY, frameId: f.id });
  };
  const closeCtxMenu = () => setCtxMenu(null);

  // ---------- 拖拽：拖进/拖出编组、跨组移动、组内排序 ----------
  const draggingIds = () => {
    const id = dragFrameIdRef.current ?? dragFrameId;
    return id ? (selectedFrames.has(id) ? [...selectedFrames] : [id]) : [];
  };
  const draggingIdsForFile = (fileId: string) =>
    draggingIds().filter((id) => frameById.get(id)?.file_id === fileId);
  const pagesMap = (ids: string[]) => {
    const m = new Map<string, string | null>();
    for (const id of ids) m.set(id, frameById.get(id)?.page_id ?? null);
    return m;
  };
  const clearDrag = () => {
    dragFrameIdRef.current = null;
    setDragFrameId(null);
    setDropPageId(null);
    setDropFrameHint(null);
  };

  /**
   * 乐观更新编组归属：拖放落点后立刻本地改 frames（成员数/线框/列表立即生效），
   * 再在后台发一个请求落库；出错才回滚（重新拉一次）。
   */
  const applyMembershipLocal = (fileId: string, pageId: string | null, orderedIds: string[]) => {
    const pageName = pageId ? pages.find((p) => p.id === pageId)?.name ?? null : null;
    setFrames((prev) =>
      prev.map((f) => {
        if (f.file_id !== fileId) return f;
        const idx = orderedIds.indexOf(f.id);
        if (idx < 0) return f;
        return { ...f, page_id: pageId, page_name: pageName, page_sort: idx };
      })
    );
  };
  /** 后台落库失败：提示并重新拉取，回到服务端真实状态 */
  const persistFailed = (e: unknown) => {
    fail(e);
    load();
  };

  /** 拖到编组标题：追加到该编组末尾（pageId=null 为未分组） */
  const dropOnPage = async (fileId: string, pageId: string | null) => {
    const ids = draggingIdsForFile(fileId);
    if (!ids.length) {
      clearDrag();
      return;
    }
    const rest = pageFrames(fileId, pageId).filter((f) => !ids.includes(f.id)).map((f) => f.id);
    const order = [...rest, ...ids];
    const before = pagesMap(ids);
    const after = new Map(before);
    for (const id of ids) after.set(id, pageId);
    // 先本地生效（<100ms），再后台落库
    applyMembershipLocal(fileId, pageId, order);
    recordMembership(before, after, pageId ? '移入编组' : '移出编组');
    setOpenPages((s) => new Set(s).add(pageId ?? '__none:global'));
    clearDrag();
    api.reorderFrames(fileId, pageId, order).catch(persistFailed);
  };

  /** 拖到全局「未分组」：可同时移出多个设计稿的画板（每份设计稿各自追加到未分组末尾） */
  const dropOnUngrouped = async () => {
    const ids = draggingIds();
    if (!ids.length) {
      clearDrag();
      return;
    }
    const before = pagesMap(ids);
    const after = new Map(before);
    for (const id of ids) after.set(id, null);
    const jobs: { fileId: string; order: string[] }[] = [];
    for (const fileId of [...new Set(ids.map((id) => frameById.get(id)?.file_id).filter(Boolean) as string[])]) {
      const fileIds = ids.filter((id) => frameById.get(id)?.file_id === fileId);
      const rest = pageFrames(fileId, null).filter((f) => !fileIds.includes(f.id)).map((f) => f.id);
      const order = [...rest, ...fileIds];
      applyMembershipLocal(fileId, null, order);
      jobs.push({ fileId, order });
    }
    recordMembership(before, after, '移出编组');
    setOpenPages((s) => new Set(s).add('__none:global'));
    clearDrag();
    for (const job of jobs) api.reorderFrames(job.fileId, null, job.order).catch(persistFailed);
  };

  /** 拖到画板：在该画板前/后插入，跨组时一并移入目标组（同设计稿内） */
  const dropOnFrame = async (target: ProjectFrameRow, position: 'before' | 'after') => {
    const ids = draggingIdsForFile(target.file_id);
    if (!ids.length || ids.includes(target.id)) {
      clearDrag();
      return;
    }
    const pageId = target.page_id ?? null;
    const rest = pageFrames(target.file_id, pageId).filter((f) => !ids.includes(f.id));
    const idx = rest.findIndex((f) => f.id === target.id);
    const at = idx < 0 ? rest.length : idx + (position === 'after' ? 1 : 0);
    const order = [...rest.slice(0, at).map((f) => f.id), ...ids, ...rest.slice(at).map((f) => f.id)];
    const before = pagesMap(ids);
    const after = new Map(before);
    for (const id of ids) after.set(id, pageId);
    applyMembershipLocal(target.file_id, pageId, order);
    recordMembership(before, after, '调整编组');
    if (pageId) setOpenPages((s) => new Set(s).add(pageId));
    clearDrag();
    api.reorderFrames(target.file_id, pageId, order).catch(persistFailed);
  };

  /** 画板交互：连线模式下依次点两个画板完成连线；普通模式单击选中（Ctrl/⌘、Shift），双击进详情 */
  const onFrameClick = (f: ProjectFrameRow, e: React.MouseEvent) => {
    // 连线模式开启时，画板点击只用于连线：不选中、不拖动、不进详情
    if (linkMode && !readOnly) {
      e.preventDefault();
      e.stopPropagation();
      const draft = linkDraftRef.current;
      if (draft) {
        if (f.id !== draft.fromId) {
          // 用目标画板中心重算出线边：避免「直接点第二张画板、中间没有 pointermove」时方向不对
          const a = placedByIdRef.current.get(draft.fromId);
          const b = placedByIdRef.current.get(f.id);
          const side = a && b
            ? pickLinkSide(
                { x: a.px, y: a.py, w: a.f.width, h: a.f.height },
                { x: b.px + b.f.width / 2, y: b.py + b.f.height / 2 }
              )
            : draft.side;
          addLinkRef.current(draft.fromId, f.id, side);
        }
        clearLinkDraft();
      } else {
        startLinkFromFrame(f.id, e);
      }
      return;
    }
    if (readOnly) {
      navigate(`/files/${f.file_id}/frames/${f.id}`);
      return;
    }
    if (draggedRef.current || dragMovedRef.current || spaceRef.current) return;
    if (e.shiftKey) {
      e.preventDefault();
      selectRangeTo(f.id);
      return;
    }
    if (hasToggleModifier(e)) {
      e.preventDefault();
      toggleSelect(f.id);
      return;
    }
    e.preventDefault();
    plainSelect(f.id);
  };

  const onFrameDoubleClick = (f: ProjectFrameRow, e: React.MouseEvent) => {
    if (readOnly) return;
    // 修饰键点击、刚拖拽过、空格平移都不算“双击打开”
    if (e.shiftKey || hasToggleModifier(e) || draggedRef.current || dragMovedRef.current || spaceRef.current) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    navigate(`/files/${f.file_id}/frames/${f.id}`);
  };

  const onFrameDragStart = (f: ProjectFrameRow, e: React.DragEvent) => {
    if (readOnly) return;
    draggedRef.current = true;
    dragFrameIdRef.current = f.id;
    setDragFrameId(f.id);
    setDropFrameHint(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', f.id);
  };
  const onFrameDragEnd = () => {
    clearDrag();
    // 拖拽结束后短时间内屏蔽双击判定
    window.setTimeout(() => {
      draggedRef.current = false;
    }, 300);
  };

  /** 拖到画板行：按轴向（侧栏用 y，画布用 x）判断插入到前/后 */
  const hintFrameDrop = (f: ProjectFrameRow, clientX: number, clientY: number, axis: 'x' | 'y') => {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const box = (el?.closest?.(`[data-frame-id="${f.id}"]`) as HTMLElement | null)?.getBoundingClientRect();
    if (!box) return;
    const position =
      axis === 'x'
        ? clientX < box.left + box.width / 2
          ? 'before'
          : 'after'
        : clientY < box.top + box.height / 2
          ? 'before'
          : 'after';
    if (dropFrameHint?.frameId !== f.id || dropFrameHint.position !== position) {
      setDropFrameHint({ frameId: f.id, position });
    }
    setDropPageId(null);
  };

  /** 双击判定排除 ✏/🗑：这些区域 stopPropagation */
  const stopFrameAction = (e: React.MouseEvent | React.DragEvent) => {
    e.stopPropagation();
  };

  // ---------- 剪贴板导入：图片直接成画板；Figma 图层剪贴板解析 figmeta 一键转 API 导入 ----------
  // 粘贴图片的画板尺寸：自动（图片原始尺寸）或按设备规范（iOS/Android/Web）
  const [pasteDeviceId, setPasteDeviceId] = useState('');
  const pasteDeviceRef = useRef('');
  const pickPasteDevice = (id: string) => {
    setPasteDeviceId(id);
    pasteDeviceRef.current = id;
  };
  const [pasteToast, setPasteToast] = useState<{ kind: 'ok' | 'err' | 'figma'; text: string; url?: string } | null>(null);
  const pasteTimer = useRef<number | null>(null);
  const showToast = useCallback((kind: 'ok' | 'err' | 'figma', text: string, url?: string) => {
    setPasteToast({ kind, text, url });
    if (pasteTimer.current) window.clearTimeout(pasteTimer.current);
    if (kind !== 'figma') pasteTimer.current = window.setTimeout(() => setPasteToast(null), 4000);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    const onPaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const dt = e.clipboardData;
      if (!dt) return;
      // 1) 图片粘贴（Figma 里 Copy as PNG / 系统截图 / 聊天工具复制的图片）
      const item = Array.from(dt.items ?? []).find((i) => i.type.startsWith('image/'));
      if (item) {
        if (readOnlyRef.current) {
          showToast('err', '协作者身份为只读，粘贴导入需要管理员权限');
          return;
        }
        const blob = item.getAsFile();
        if (!blob) return;
        e.preventDefault();
        showToast('ok', '正在导入剪贴板图片…');
        try {
          const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
            img.onerror = () => reject(new Error('图片读取失败'));
            img.src = URL.createObjectURL(blob);
          });
          const dev = findDevice(pasteDeviceRef.current);
          const box = dev ? { w: dev.width, h: dev.height } : dims;
          const r = await api.uploadImage(blob, projectId, box.w, box.h);
          showToast(
            'ok',
            `已导入「${r.name}」${dev ? `（${dev.name} ${dev.width}×${dev.height}${dev.unit}）` : ''}，画板已出现在画布`
          );
          load();
        } catch (err) {
          showToast('err', readableError(err, '导入失败：发生未知错误，请稍后重试或反馈给我们'));
        }
        return;
      }
      // 2) Figma 图层剪贴板（在 Figma 中 Ctrl/Cmd+C 复制页面/图层）
      const html = dt.getData('text/html');
      if (html && html.includes('(figmeta)')) {
        e.preventDefault();
        try {
          const meta = await api.parseFigmaClipboard(html);
          showToast(
            'figma',
            `检测到 Figma 剪贴板「${meta.fileName || meta.fileKey}」。图层数据是 Figma 私有格式，无法直接解析——一键用 API 导入完整图层？`,
            meta.url
          );
        } catch (err) {
          showToast('err', err instanceof Error ? err.message : '剪贴板解析失败');
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [projectId, load, showToast]);

  const importFromClipboard = useCallback(
    async (u: string) => {
      setPasteToast(null);
      setBusy(true);
      try {
        const r = await api.importFile(u, projectId ?? undefined);
        showToast('ok', `已导入「${r.name}」`);
        load();
      } catch (err) {
        showToast('err', readableError(err, '导入失败：发生未知错误，请稍后重试或反馈给我们'));
      } finally {
        setBusy(false);
      }
    },
    [projectId, load, showToast]
  );

  // 有解析中的稿子时 3 秒轮询，新画板自动出现在画布上
  useEffect(() => {
    const parsing = files.some((f) => f.status === 'pending' || f.status === 'processing');
    if (!parsing) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [files, load]);

  // 画布布局：完全按 frames.canvas_x/canvas_y 定位；编组线框 = 成员包围盒（被动适应，不反向约束画板）
  const layout = useMemo(() => {
    const placed: Placed[] = [];
    for (const f of frames) {
      const p = pos.get(f.id);
      if (!p) continue;
      placed.push({ f, px: p.x, py: p.y });
    }
    const byId = new Map(placed.map((p) => [p.f.id, p]));
    const bands: GroupBox[] = [];

    for (const file of fileTree) {
      for (const g of file.groups) {
        if (!g.pageId) continue;
        const members = g.items.map((f) => byId.get(f.id)).filter((m): m is Placed => !!m);
        // 空编组只在左侧列表出现，不在画布上画框
        if (!members.length) continue;
        const minX = Math.min(...members.map((m) => m.px));
        const minY = Math.min(...members.map((m) => m.py));
        const maxX = Math.max(...members.map((m) => m.px + m.f.width));
        const maxY = Math.max(...members.map((m) => m.py + m.f.height));
        bands.push({
          key: `${file.fileId}:${g.key}`,
          fileId: file.fileId,
          pageId: g.pageId,
          name: g.name,
          x: minX - GROUP_PAD,
          y: minY - GROUP_PAD - GROUP_HEAD_H,
          w: maxX - minX + GROUP_PAD * 2,
          h: maxY - minY + GROUP_PAD * 2 + GROUP_HEAD_H,
          frameIds: members.map((m) => m.f.id),
        });
      }
    }

    // 全局未分组：画布上不画标题、不画容器，画板直接散落（左侧列表仍保留「未分组」）
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const p of placed) {
      minX = Math.min(minX, p.px);
      minY = Math.min(minY, p.py);
      maxX = Math.max(maxX, p.px + p.f.width);
      maxY = Math.max(maxY, p.py + p.f.height);
    }
    for (const b of bands) {
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    layoutRef.current = { bands, minX, minY, maxX, maxY };
    return { placed, bands, minX, minY, maxX, maxY };
  }, [frames, fileTree, pos, ungrouped]);

  /** 连线渲染用：按 id 快速取画板在画布上的矩形 */
  const placedById = useMemo(() => new Map(layout.placed.map((p) => [p.f.id, p])), [layout.placed]);
  // 全局 pointer 监听需要读最新布局，用 ref 同步，避免每次 render 重绑监听器
  const placedByIdRef = useRef(placedById);
  placedByIdRef.current = placedById;

  /** 把若干画板的最新坐标落库（按设计稿分组批量保存） */
  const savePositions = useCallback(async (ids: string[]) => {
    if (readOnlyRef.current || !ids.length) return;
    const byFile = new Map<string, { id: string; x: number; y: number }[]>();
    for (const id of ids) {
      const f = framesRef.current.find((x) => x.id === id);
      const p = posRef.current.get(id);
      if (!f || !p) continue;
      const arr = byFile.get(f.file_id) ?? [];
      arr.push({ id, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
      byFile.set(f.file_id, arr);
    }
    for (const [fileId, entries] of byFile) {
      await api.setFramePositions(fileId, entries).catch(() => undefined);
    }
  }, []);

  const flashToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(''), 1800);
  };

  const recordHistory = (entry: HistoryEntry) => {
    undoStackRef.current.push(entry);
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    redoStackRef.current = [];
  };

  // ---------- 连线操作 ----------
  // 全局 pointer 监听通过 ref 调用最新闭包，避免每次 render 反复重绑监听器
  const addLinkRef = useRef<(from: string, to: string, side: PortSide) => void>(() => {});
  const addLink = async (from: string, to: string, side: PortSide = 'right') => {
    if (readOnlyRef.current || !projectId || from === to) return;
    if (linksRef.current.some((l) => l.from_frame_id === from && l.to_frame_id === to)) {
      flashToast('这两个画板已经连过线了');
      return;
    }
    try {
      const link = await api.createFrameLink(projectId, from, to, side);
      const next = [...linksRef.current, link];
      linksRef.current = next;
      setLinks(next);
      flashToast('已连线');
      recordHistory({
        label: '新建连线',
        undo: () => api.deleteFrameLink(projectId, link.id).then(() => undefined),
        redo: () => api.createFrameLink(projectId, from, to, side).then(() => undefined),
      });
    } catch (e) {
      fail(e);
    }
  };
  addLinkRef.current = addLink;

  const removeLink = async (link: FrameLink) => {
    if (readOnlyRef.current || !projectId) return;
    const next = linksRef.current.filter((l) => l.id !== link.id);
    linksRef.current = next;
    setLinks(next);
    setHoverLinkId(null);
    try {
      await api.deleteFrameLink(projectId, link.id);
      flashToast('已删除连线');
      recordHistory({
        label: '删除连线',
        undo: () => api.createFrameLink(projectId, link.from_frame_id, link.to_frame_id, link.from_side ?? 'right').then(() => undefined),
        redo: async () => {
          // 撤销重建后 id 会变，按端点重新查当前连线再删
          const cur = (await api.listFrameLinks(projectId)).find(
            (l) => l.from_frame_id === link.from_frame_id && l.to_frame_id === link.to_frame_id
          );
          if (cur) await api.deleteFrameLink(projectId, cur.id);
        },
      });
    } catch (e) {
      fail(e);
      load();
    }
  };

  const clearLinkDraft = () => {
    linkDraftRef.current = null;
    setLinkDraft(null);
  };

  /** 连线模式下点击第一张画板：设为起点，之后点第二张画板即完成连线 */
  const startLinkFromFrame = (frameId: string, e: React.MouseEvent) => {
    if (readOnly || !linkModeRef.current || spaceRef.current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    const a = placedByIdRef.current.get(frameId);
    if (!rect || !a) return;
    const cursor = worldPointAt(e.clientX, e.clientY, rect, panXYRef.current, zoomRef.current);
    const draft: LinkDraft = {
      fromId: frameId,
      side: pickLinkSide({ x: a.px, y: a.py, w: a.f.width, h: a.f.height }, cursor),
      cursor,
      targetId: null,
    };
    linkDraftRef.current = draft;
    setLinkDraft(draft);
  };

  /** 把一组坐标写回前端并落库（撤销/重做共用） */
  const applyPositions = async (vals: Map<string, { x: number; y: number }>) => {
    const next = new Map(posRef.current);
    for (const [id, p] of vals) next.set(id, p);
    updatePositions(next);
    await savePositions([...vals.keys()]);
  };

  /** 记录一次画板移动（含多选 / 方向键微调） */
  const recordPositions = (ids: string[], before: Map<string, { x: number; y: number }>, label = '移动画板') => {
    if (readOnlyRef.current) return;
    const b = new Map<string, { x: number; y: number }>();
    const a = new Map<string, { x: number; y: number }>();
    for (const id of ids) {
      const bp = before.get(id);
      const ap = posRef.current.get(id);
      if (bp) b.set(id, bp);
      if (ap) a.set(id, ap);
    }
    if (!b.size || !a.size) return;
    recordHistory({ label, undo: () => applyPositions(b), redo: () => applyPositions(a) });
  };

  /** 记录编组归属变化（撤销/重做都调用服务端 moveFramesToPage） */
  const recordMembership = (
    before: Map<string, string | null>,
    after: Map<string, string | null>,
    label = '调整编组'
  ) => {
    if (readOnlyRef.current) return;
    const apply = async (map: Map<string, string | null>) => {
      const groups = new Map<string, { fileId: string; pageId: string | null; ids: string[] }>();
      for (const [id, pageId] of map) {
        const f = framesRef.current.find((x) => x.id === id);
        if (!f) continue;
        const key = `${f.file_id}:${pageId ?? ''}`;
        const g = groups.get(key) ?? { fileId: f.file_id, pageId, ids: [] };
        g.ids.push(id);
        groups.set(key, g);
      }
      for (const g of groups.values()) await api.moveFramesToPage(g.fileId, g.ids, g.pageId);
    };
    recordHistory({ label, undo: () => apply(before), redo: () => apply(after) });
  };

  const doUndo = async () => {
    const entry = undoStackRef.current.pop();
    if (!entry) {
      flashToast('没有可撤销的操作');
      return;
    }
    try {
      await entry.undo();
      redoStackRef.current.push(entry);
      flashToast(`已撤销：${entry.label}`);
      load();
    } catch (e) {
      fail(e);
    }
  };

  const doRedo = async () => {
    const entry = redoStackRef.current.pop();
    if (!entry) {
      flashToast('没有可重做的操作');
      return;
    }
    try {
      await entry.redo();
      undoStackRef.current.push(entry);
      flashToast(`已重做：${entry.label}`);
      load();
    } catch (e) {
      fail(e);
    }
  };

  /** 世界坐标点落在哪个编组线框里（只认同设计稿的命名编组；多框重叠时取面积最小的） */
  const pageAtPoint = (x: number, y: number, fileId: string): string | null => {
    let best: { pageId: string; area: number } | null = null;
    for (const b of layoutRef.current.bands) {
      if (!b.pageId || b.fileId !== fileId) continue;
      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
      const area = b.w * b.h;
      if (!best || area < best.area) best = { pageId: b.pageId, area };
    }
    return best?.pageId ?? null;
  };

  /** 拖动时计算参考线吸附（阈值按屏幕像素换算成世界坐标，Alt 关闭） */
  const snapOffset = (ids: string[], dx: number, dy: number) => {
    const z = zoomRef.current;
    const th = 6 / z;
    const moving = ids
      .map((id) => {
        const f = framesRef.current.find((x) => x.id === id);
        const p = dragSessionRef.current?.startPos.get(id);
        if (!f || !p) return null;
        return { x: p.x + dx, y: p.y + dy, w: f.width, h: f.height };
      })
      .filter((r): r is { x: number; y: number; w: number; h: number } => !!r);
    if (!moving.length) return { dx, dy, guides: { v: null, h: null } as Guides };
    const mx0 = Math.min(...moving.map((r) => r.x));
    const my0 = Math.min(...moving.map((r) => r.y));
    const mx1 = Math.max(...moving.map((r) => r.x + r.w));
    const my1 = Math.max(...moving.map((r) => r.y + r.h));
    const others = framesRef.current
      .filter((f) => !ids.includes(f.id))
      .map((f) => ({ p: posRef.current.get(f.id), w: f.width, h: f.height }))
      .filter((o): o is { p: { x: number; y: number }; w: number; h: number } => !!o.p);
    let sx: number | null = null;
    let gv: number | null = null;
    let sy: number | null = null;
    let gh: number | null = null;
    for (const o of others) {
      for (const mv of [mx0, (mx0 + mx1) / 2, mx1]) {
        for (const ov of [o.p.x, o.p.x + o.w / 2, o.p.x + o.w]) {
          const d = ov - mv;
          if (Math.abs(d) <= th && (sx === null || Math.abs(d) < Math.abs(sx))) {
            sx = d;
            gv = ov;
          }
        }
      }
      for (const mv of [my0, (my0 + my1) / 2, my1]) {
        for (const ov of [o.p.y, o.p.y + o.h / 2, o.p.y + o.h]) {
          const d = ov - mv;
          if (Math.abs(d) <= th && (sy === null || Math.abs(d) < Math.abs(sy))) {
            sy = d;
            gh = ov;
          }
        }
      }
    }
    return {
      dx: dx + (sx ?? 0),
      dy: dy + (sy ?? 0),
      guides: { v: gv, h: gh } as Guides,
    };
  };

  /** 画板按下：先选中，再准备拖动（超过 4px 才算拖动，避免点一下就位移） */
  const beginFrameDrag = (f: ProjectFrameRow, e: React.PointerEvent) => {
    if (readOnly || e.button !== 0 || spaceRef.current) return;
    // 连线模式下不选中、不拖动画板，交给随后的 click 完成/取消连线
    // 这里不 preventDefault，确保 pointerdown 之后浏览器仍会派发 click
    if (linkModeRef.current || linkDraftRef.current) return;
    e.preventDefault();
    dragMovedRef.current = false;
    const already = selectedFrames.has(f.id);
    // 修饰键的选择交给随后的 click 处理，避免 pointerdown + click 各切换一次导致“选了又取消”
    const mod = hasToggleModifier(e) || e.shiftKey;
    if (!already && !mod) plainSelect(f.id);
    const ids = mod
      ? [...new Set([...selectedFrames, f.id])]
      : already
        ? [...selectedFrames]
        : [f.id];
    const startPos = new Map<string, { x: number; y: number }>();
    for (const id of ids) {
      const p = posRef.current.get(id);
      if (p) startPos.set(id, { ...p });
    }
    dragSessionRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
      ids,
      startPos,
    };
  };

  /** 抓组名/组框：横条上拖 = 整组平移（只改位置，不改编组归属）；组框空白底拖 = 平移画布 */
  const beginGroupDrag = (b: GroupBox, e: React.PointerEvent) => {
    const inBand = !!(e.target as HTMLElement).closest('.pcanvas-group-band');
    if (!inBand) {
      // 编组线框的空白底（大片紫色区域，视觉上是"空画布"）：左键拖拽 = 平移画布
      if (e.button !== 0 || spaceRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      panRef.current = { x: e.clientX, y: e.clientY };
      dragMovedRef.current = false;
      leftPanRef.current = true;
      return;
    }
    if (readOnly || e.button !== 0 || spaceRef.current || !b.frameIds.length) return;
    e.preventDefault();
    e.stopPropagation();
    draggedRef.current = false;
    const startPos = new Map<string, { x: number; y: number }>();
    for (const id of b.frameIds) {
      const p = posRef.current.get(id);
      if (p) startPos.set(id, { ...p });
    }
    groupDragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      ids: b.frameIds,
      startPos,
      moved: false,
    };
  };

  /** Shift+左键空白拖拽：框选（追加选中） */
  const beginMarquee = (e: React.PointerEvent) => {
    const el = containerRef.current;
    if (!el || readOnly || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('.pcanvas-frame, .pcanvas-group-box, .pcanvas-group-band, .zoombar')) return;
    marqueeRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      rect: el.getBoundingClientRect(),
      base: e.shiftKey ? new Set(selectedFrames) : new Set(),
      shift: e.shiftKey,
      moved: false,
    };
  };

  /** 松开鼠标：坐标落库 + 按“位置决定归属”更新编组 */
  const commitDrag = async () => {
    const s = dragSessionRef.current;
    if (!s) return;
    dragSessionRef.current = null;
    setGuides({ v: null, h: null });
    if (!s.moved) return;
    const ids = s.ids;
    draggedRef.current = true;
    dragMovedRef.current = true;
    window.setTimeout(() => {
      draggedRef.current = false;
      dragMovedRef.current = false;
    }, 300);
    await savePositions(ids);
    recordPositions(ids, s.startPos);
    const beforeMembership = new Map<string, string | null>();
    for (const id of ids) {
      const f = framesRef.current.find((x) => x.id === id);
      if (f) beforeMembership.set(id, f.page_id ?? null);
    }
    const afterMembership = new Map(beforeMembership);
    const changes = new Map<string, { fileId: string; pageId: string | null; ids: string[] }>();
    for (const id of ids) {
      const f = framesRef.current.find((x) => x.id === id);
      const p = posRef.current.get(id);
      if (!f || !p) continue;
      const target = pageAtPoint(p.x + f.width / 2, p.y + f.height / 2, f.file_id);
      afterMembership.set(id, target);
      if ((f.page_id ?? null) !== target) {
        const key = `${f.file_id}:${target ?? ''}`;
        const entry = changes.get(key) ?? { fileId: f.file_id, pageId: target, ids: [] };
        entry.ids.push(id);
        changes.set(key, entry);
      }
    }
    if (!changes.size) return;
    for (const c of changes.values()) {
      const rest = framesRef.current
        .filter((f) => f.file_id === c.fileId && (f.page_id ?? null) === c.pageId && !c.ids.includes(f.id))
        .map((f) => f.id);
      await api.reorderFrames(c.fileId, c.pageId, [...rest, ...c.ids]).catch(() => undefined);
    }
    recordMembership(beforeMembership, afterMembership);
    load();
  };

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { minX, minY, maxX, maxY } = layoutRef.current;
    const w = Math.max(maxX - minX, 300);
    const h = Math.max(maxY - minY, 200);
    const pad = 90;
    const z = clamp(Math.min((el.clientWidth - pad) / w, (el.clientHeight - pad) / h, 1), MIN_ZOOM, MAX_ZOOM);
    zoomRef.current = z;
    setZoomState(z);
    setPanXY((el.clientWidth - w * z) / 2 - minX * z, (el.clientHeight - h * z) / 2 - minY * z);
  }, [setPanXY]);

  /** 以容器中心为锚点缩放（缩放按钮用） */
  const zoomCenter = useCallback(
    (z: number) => {
      const el = containerRef.current;
      const next = clamp(z, MIN_ZOOM, MAX_ZOOM);
      if (!el) return setZoom(next);
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      const old = zoomRef.current;
      const p = panXYRef.current;
      setPanXY(cx - (cx - p.x) * (next / old), cy - (cy - p.y) * (next / old));
      setZoom(next);
    },
    [setZoom, setPanXY]
  );

  // 画板加载后自适应一次
  const fittedRef = useRef('');
  useEffect(() => {
    const key = `${projectId}:${frames.length}`;
    if (frames.length && fittedRef.current !== key) {
      fittedRef.current = key;
      setTimeout(fit, 60);
    }
  }, [frames.length, projectId, fit]);

  // 滚轮 / Cmd(Ctrl)+滚轮 缩放（以光标为锚点，范围 10%–400%）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const old = zoomRef.current;
      const next = clamp(old * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      const p = panXYRef.current;
      setPanXY(cx - (cx - p.x) * (next / old), cy - (cy - p.y) * (next / old));
      setZoom(next);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [setZoom]);

  // 空格按住 = 平移模式
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('.sidebar')) return; // 侧栏里的按钮/组名要用空格
      e.preventDefault();
      spaceRef.current = true;
      setSpacePan(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      setSpacePan(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // 键盘：Esc 取消选中/关闭菜单、+/- 缩放、方向键微调（1px / Shift 10px）
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) void doRedo();
          else void doUndo();
          return;
        }
        if (k === 'y') {
          e.preventDefault();
          void doRedo();
          return;
        }
      }
      if (e.key === 'Escape') {
        if (marqueeRef.current) {
          marqueeRef.current = null;
          setMarquee(null);
          setSelectedFrames(new Set());
          return;
        }
        if (ctxMenu) {
          setCtxMenu(null);
          return;
        }
        setSelectedFrames(new Set());
        return;
      }
      // 框选 / 多选后按 Delete 或 Backspace 批量删除，统一走确认弹窗
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedFrames.size || readOnlyRef.current) return;
        e.preventDefault();
        void removeFrames([...selectedFrames]);
        return;
      }
      const arrow =
        e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown';
      if (arrow) {
        if (!selectedFrames.size || readOnlyRef.current) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const ids = [...selectedFrames];
        const before = new Map<string, { x: number; y: number }>();
        for (const id of ids) {
          const p = posRef.current.get(id);
          if (p) before.set(id, { ...p });
        }
        const next = new Map(posRef.current);
        for (const id of selectedFrames) {
          const p = next.get(id);
          if (p) next.set(id, { x: p.x + dx, y: p.y + dy });
        }
        updatePositions(next);
        // 连续微调合并成一条历史（600ms 内）
        const burst = arrowBurstRef.current;
        if (!burst || burst.ids.join(',') !== ids.join(',')) {
          arrowBurstRef.current = { before, ids };
        }
        if (arrowTimerRef.current) window.clearTimeout(arrowTimerRef.current);
        arrowTimerRef.current = window.setTimeout(() => {
          const b = arrowBurstRef.current;
          arrowBurstRef.current = null;
          if (b) recordPositions(b.ids, b.before, '微调画板');
        }, 600);
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => void savePositions(ids), 500);
        return;
      }
      if (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd') {
        e.preventDefault();
        zoomCenter(zoomRef.current * 1.25);
      } else if (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        zoomCenter(zoomRef.current / 1.25);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomCenter, ctxMenu, selectedFrames, removeFrames, updatePositions, savePositions, recordPositions, doUndo, doRedo]);

  // 指针交互：拖动画板 / Shift 框选 / 平移（左键、空格或中键），按 zoom 换算世界位移
  useEffect(() => {
    const worldPoint = (clientX: number, clientY: number, rect: DOMRect) => {
      const z = zoomRef.current;
      const p = panXYRef.current;
      return { x: (clientX - rect.left - p.x) / z, y: (clientY - rect.top - p.y) / z };
    };
    const move = (e: PointerEvent) => {
      if (panRef.current) {
        const dx = e.clientX - panRef.current.x;
        const dy = e.clientY - panRef.current.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) dragMovedRef.current = true;
        const p = panXYRef.current;
        setPanXY(p.x + dx, p.y + dy);
        panRef.current = { x: e.clientX, y: e.clientY };
        return;
      }
      const m = marqueeRef.current;
      if (m) {
        if (!m.moved && Math.hypot(e.clientX - m.startClientX, e.clientY - m.startClientY) > 4) m.moved = true;
        if (!m.moved) return;
        const a = worldPoint(m.startClientX, m.startClientY, m.rect);
        const b = worldPoint(e.clientX, e.clientY, m.rect);
        const rx = Math.min(a.x, b.x);
        const ry = Math.min(a.y, b.y);
        const rw = Math.abs(b.x - a.x);
        const rh = Math.abs(b.y - a.y);
        setMarquee({ x: rx, y: ry, w: rw, h: rh });
        const hit = framesRef.current
          .filter((f) => {
            const p = posRef.current.get(f.id);
            if (!p) return false;
            return p.x < rx + rw && p.x + f.width > rx && p.y < ry + rh && p.y + f.height > ry;
          })
          .map((f) => f.id);
        setSelectedFrames(new Set(e.shiftKey ? [...m.base, ...hit] : hit));
        return;
      }
      const gd = groupDragRef.current;
      if (gd) {
        const z = zoomRef.current;
        const dx = (e.clientX - gd.startClientX) / z;
        const dy = (e.clientY - gd.startClientY) / z;
        if (!gd.moved && Math.hypot(e.clientX - gd.startClientX, e.clientY - gd.startClientY) > 4) {
          gd.moved = true;
          draggedRef.current = true;
        }
        if (!gd.moved) return;
        const next = new Map(posRef.current);
        for (const id of gd.ids) {
          const p = gd.startPos.get(id);
          if (p) next.set(id, { x: p.x + dx, y: p.y + dy });
        }
        updatePositions(next);
        setGroupDelta({ x: Math.round(dx), y: Math.round(dy) });
        return;
      }
      const s = dragSessionRef.current;
      if (!s) return;
      const z = zoomRef.current;
      const dx = (e.clientX - s.startClientX) / z;
      const dy = (e.clientY - s.startClientY) / z;
      if (!s.moved && Math.hypot(e.clientX - s.startClientX, e.clientY - s.startClientY) > 4) {
        s.moved = true;
        draggedRef.current = true;
        dragMovedRef.current = true;
      }
      if (!s.moved) return;
      let ax = dx;
      let ay = dy;
      let g: Guides = { v: null, h: null };
      if (!e.altKey) {
        const snap = snapOffset(s.ids, dx, dy);
        ax = snap.dx;
        ay = snap.dy;
        g = snap.guides;
      }
      const next = new Map(posRef.current);
      for (const id of s.ids) {
        const p = s.startPos.get(id);
        if (p) next.set(id, { x: p.x + ax, y: p.y + ay });
      }
      updatePositions(next);
      setGuides(g);
    };
    const up = () => {
      // 左键平移松开：拖动了=平移结束；没拖动=空白单击，取消选择
      if (leftPanRef.current) {
        leftPanRef.current = false;
        if (!dragMovedRef.current) setSelectedFrames(new Set());
      }
      panRef.current = null;
      const gd = groupDragRef.current;
      if (gd) {
        groupDragRef.current = null;
        setGroupDelta(null);
        if (gd.moved) {
          void savePositions(gd.ids);
          recordPositions(gd.ids, gd.startPos, '移动编组');
        }
        return;
      }
      const m = marqueeRef.current;
      if (m) {
        marqueeRef.current = null;
        setMarquee(null);
        if (!m.moved && !m.shift) setSelectedFrames(new Set());
      }
      if (dragSessionRef.current) void commitDrag();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [setPanXY, updatePositions, snapOffset, commitDrag, savePositions]);

  // 连线模式：顶栏开关开启后点第一张画板设起点，预览虚线跟随光标并自动朝向目标；点第二张画板 / Esc / 点空白结束
  useEffect(() => {
    const clear = () => {
      linkDraftRef.current = null;
      setLinkDraft(null);
    };
    const move = (e: PointerEvent) => {
      const d = linkDraftRef.current;
      if (!d) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cursor = worldPointAt(e.clientX, e.clientY, rect, panXYRef.current, zoomRef.current);
      const targetId = frameIdAtPoint(e.clientX, e.clientY, d.fromId);
      const a = placedByIdRef.current.get(d.fromId);
      const target = targetId ? placedByIdRef.current.get(targetId) : null;
      // 对准目标时按目标画板中心定向，预览曲线与最终落库曲线完全一致
      const toward = target
        ? { x: target.px + target.f.width / 2, y: target.py + target.f.height / 2 }
        : cursor;
      const next: LinkDraft = {
        ...d,
        cursor,
        targetId,
        side: a ? pickLinkSide({ x: a.px, y: a.py, w: a.f.width, h: a.f.height }, toward) : d.side,
      };
      linkDraftRef.current = next;
      setLinkDraft(next);
    };
    // 点到画布空白（非画板、非顶栏开关）视为放弃；画板由 onFrameClick、开关由自身 onClick 处理
    const click = (e: MouseEvent) => {
      if (!linkDraftRef.current) return;
      const t = e.target as HTMLElement;
      if (t.closest?.('.pcanvas-frame') || t.closest?.('.link-toggle')) return;
      clear();
    };
    const keydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 有起点先取消起点；没有起点则直接退出连线模式（线条始终保留）
      if (linkDraftRef.current) clear();
      else if (linkModeRef.current) setLinkMode(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('click', click);
    window.addEventListener('keydown', keydown);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('click', click);
      window.removeEventListener('keydown', keydown);
    };
  }, []);

  // 打开导入面板时探测服务端是否配置了统一令牌（只拿 true/false，不含令牌）
  useEffect(() => {
    if (!importOpen) return;
    let alive = true;
    api.figmaImportStatus()
      .then((r) => { if (alive) setFigmaConfigured(Boolean(r.configured)); })
      .catch(() => { if (alive) setFigmaConfigured(null); });
    return () => { alive = false; };
  }, [importOpen]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy || !projectId) return;
    if (figmaConfigured === false && !personalToken.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { id } = await api.importFile(url.trim(), projectId, personalToken);
      setUrl('');
      setPersonalToken('');
      setImportOpen(false);
      navigate(`/files/${id}`);
    } catch (err) {
      setError(readableError(err, '导入失败：发生未知错误，请稍后重试或反馈给我们'));
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !projectId) return;
    setError('');
    setUploading(`正在上传并解析 ${f.name}…`);
    try {
      const { id } = await api.uploadDesign(f, projectId);
      setUploading('');
      setImportOpen(false);
      navigate(`/files/${id}`);
    } catch (err) {
      setUploading('');
      setError(readableError(err, '导入失败：发生未知错误，请稍后重试或反馈给我们'));
    }
  };

  /** 导入 Figma 插件导出的 JSON：粘贴文本与选择 .json 文件共用同一后端接口 */
  const submitJson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jsonText.trim() || jsonBusy || !projectId) return;
    if (jsonText.length > 20 * 1024 * 1024) {
      setError('JSON 过大（超过 20MB）：请减少画板数量后重新导出');
      return;
    }
    setJsonBusy(true);
    setError('');
    try {
      const { id } = await api.importFigmaJson(jsonText, projectId);
      setJsonText('');
      setJsonFileName('');
      setImportOpen(false);
      navigate(`/files/${id}`);
    } catch (err) {
      setError(readableError(err, '导入失败：发生未知错误，请稍后重试或反馈给我们'));
    } finally {
      setJsonBusy(false);
    }
  };

  const onJsonFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!/\.json$/i.test(f.name)) {
      setError('请选择 Figma 插件导出的 .json 文件');
      return;
    }
    setError('');
    try {
      setJsonText(await f.text());
      setJsonFileName(f.name);
    } catch {
      setError('读取文件失败：请重新选择 .json 文件，或改用粘贴 JSON');
    }
  };

  const parsing = files.filter((f) => f.status === 'pending' || f.status === 'processing').length;

  /** 侧栏画板行：编组内与全局未分组共用 */
  const renderFrameRow = (f: ProjectFrameRow) => (
    <div
      key={f.id}
      role={readOnly ? undefined : 'option'}
      aria-selected={readOnly ? undefined : selectedFrames.has(f.id)}
      data-frame-id={f.id}
      className={`pcanvas-frame-item ${selectedFrames.has(f.id) ? 'is-selected' : ''} ${
        dropFrameHint?.frameId === f.id ? 'is-drop-target' : ''
      }`}
      title={`${f.file_name} / ${f.name}（双击打开，Ctrl/⌘ 点击多选，Shift 连选，右键创建子编组）`}
      draggable={!readOnly}
      onClick={(e) => {
        setDrawer('none');
        onFrameClick(f, e);
      }}
      onContextMenu={(e) => openCtxMenu(f, e)}
      onDoubleClick={(e) => onFrameDoubleClick(f, e)}
      onDragStart={(e) => onFrameDragStart(f, e)}
      onDragEnd={onFrameDragEnd}
      onDragOver={(e) => {
        if (readOnly || !dragFrameIdRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        hintFrameDrop(f, e.clientX, e.clientY, 'y');
      }}
      onDragLeave={() => setDropFrameHint((h) => (h?.frameId === f.id ? null : h))}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const position = dropFrameHint?.frameId === f.id ? dropFrameHint.position : 'before';
        void dropOnFrame(f, position);
      }}
    >
      <ImageIcon className="frame-thumb-icon" size={14} />
      <span className="pcanvas-frame-item-name">{f.name}</span>
      {!readOnly && (
        <span className="pcanvas-edit-btn" onClick={(e) => e.stopPropagation()} onDoubleClick={stopFrameAction}>
          <RowMenu
            label={`画板 ${f.name}`}
            items={[
              { label: '重命名画板', onClick: () => void renameFrame(f) },
              { label: '删除画板', danger: true, onClick: () => void removeFrame(f) },
            ]}
          />
        </span>
      )}
    </div>
  );

  /**
   * 递归渲染编组树：展开后显示「子编组（可继续嵌套）→ 本组画板」。
   * 子编组不再由常驻按钮创建，改为选中 2 个以上画板后右键创建；与 ViewerPage 保持一致。
   */
  const renderGroup = (g: (typeof allGroups)[number], depth: number): ReactElement => {
    const open = openPages.has(g.key);
    const pg = g.pageId ? pages.find((p) => p.id === g.pageId) ?? null : null;
    const groupSelected = g.items.length > 0 && g.items.every((f) => selectedFrames.has(f.id));
    const children = childGroupsOf(g.pageId);
    return (
      <div key={g.key} className="page-group" style={depth ? { marginLeft: depth * 14 } : undefined}>
        <div
          className={`page-row ${dropPageId === g.key ? 'is-droptarget' : ''} ${
            groupSelected ? 'is-selected' : ''
          }`}
          title={`${g.name}（${g.items.length} 个画板${children.length ? ` · ${children.length} 个子编组` : ''}）· 设计稿：${g.fileName}`}
          onDragOver={(e) => {
            if (!readOnly && dragFrameIdRef.current) {
              e.preventDefault();
              setDropPageId(g.key);
              setDropFrameHint(null);
              autoExpand(g.key);
            }
          }}
          onDragLeave={() => setDropPageId((v) => (v === g.key ? null : v))}
          onDrop={(e) => {
            e.preventDefault();
            if (!readOnly && dragFrameIdRef.current) void dropOnPage(g.fileId, g.pageId);
          }}
        >
          <button
            type="button"
            className="page-caret"
            aria-label={open ? `折叠 ${g.name}` : `展开 ${g.name}`}
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              togglePage(g.key);
            }}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
          </button>
          <span
            className="page-name"
            role="button"
            tabIndex={0}
            aria-expanded={open}
            title={`${g.name} · 所在设计稿：${g.fileName}`}
            onClick={() => {
              togglePage(g.key);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                togglePage(g.key);
              }
            }}
          >
            <Folder className="page-group-icon" size={16} />
            {g.name}
          </span>
          <span className="page-count">{g.items.length}</span>
          {pg && !readOnly && (
            <span className="page-actions" onClick={(e) => e.stopPropagation()}>
              <RowMenu
                label={`编组 ${g.name}`}
                items={[
                  { label: '重命名编组', onClick: () => void renamePage(pg) },
                  {
                    label: pg.parent_page_id
                      ? `解散子编组，画板移入「${pages.find((p) => p.id === pg.parent_page_id)?.name ?? '上一级编组'}」`
                      : '解散编组，画板移入未分组',
                    onClick: () => void removePage(pg, 'dissolve'),
                  },
                  { label: '删除编组及内容', danger: true, onClick: () => void removePage(pg, 'content') },
                ]}
              />
            </span>
          )}
        </div>
        {open && (
          <>
            {children.map((c) => renderGroup(c, depth + 1))}
            <div className="page-frames" role={readOnly ? undefined : 'listbox'} aria-multiselectable={!readOnly}>
              {g.items.map((f) => renderFrameRow(f))}
            </div>
          </>
        )}
      </div>
    );
  };

  // 返回：固定回项目所属团队的项目列表，不再回裸的 /（避免落到默认第一个团队）
  const goBack = () => {
    const teamId = project?.team_id;
    navigate(teamId ? `/projects?team=${teamId}` : '/projects', { replace: true });
  };

  return (
    <div className="viewer">
      <header className={`topbar${bg.dark ? ' is-dark-topbar' : ''}`}>
        <button className="icon-btn" onClick={goBack} title="返回上一页" aria-label="返回上一页">
          <ArrowLeft />
        </button>
        <h1><Folder /> {project?.name ?? '…'}</h1>
        {parsing > 0 && <span className="status status-wait status-pulse">解析中 {parsing}</span>}
        {readOnly && <span className="readonly-tag">协作者 · 只读</span>}
        <span className="spacer" />
        {!readOnly && (
          <button
            type="button"
            className="icon-btn link-toggle"
            data-link-mode={linkMode ? 'on' : 'off'}
            onClick={() => {
              const next = !linkMode;
              setLinkMode(next);
              clearLinkDraft();
              if (next) flashToast('连线模式：依次点击两个画板完成连线，Esc 退出');
            }}
            title={linkMode ? '退出连线模式（线条始终显示）' : '开启连线模式：依次点击两个画板即可连线'}
            aria-pressed={linkMode}
          >
            <LinkIcon /> <span>连线</span>
          </button>
        )}
        <div className="share-wrap">
          <button
            type="button"
            className={`icon-btn share-btn${shareOpen ? ' is-active' : ''}`}
            onClick={toggleShare}
            title="分享项目（拿到链接的人无需登录即可查看）"
            aria-label="分享项目"
            aria-expanded={shareOpen}
          >
            <Share2 /> <span>分享</span>
          </button>
          {shareOpen && (
            <div className="share-popover">
              <div className="share-popover-head">
                <strong>分享项目</strong>
                <button type="button" className="share-pop-close" onClick={() => setShareOpen(false)} aria-label="关闭">
                  <X />
                </button>
              </div>
              <p className="share-pop-tip">拿到链接的人无需登录即可查看全部画板，仅可查看、不能编辑。</p>
              {shareError && <p className="share-pop-error">{shareError}</p>}
              {shareState.active && shareState.url ? (
                <>
                  <div className="share-link-row">
                    <input
                      readOnly
                      value={`${window.location.origin}${shareState.url}`}
                      onFocus={(e) => e.currentTarget.select()}
                      aria-label="分享链接"
                    />
                    <button type="button" className="share-copy-btn" onClick={() => void copyShare()}>
                      {shareCopied ? <Check /> : <Copy />} {shareCopied ? '已复制' : '复制'}
                    </button>
                  </div>
                  <div className="share-pop-actions">
                    <a href={shareState.url} target="_blank" rel="noreferrer">新标签打开 <ExternalLink /></a>
                    <button type="button" onClick={() => void disableShare()} disabled={shareBusy}>关闭分享</button>
                  </div>
                </>
              ) : (
                <button type="button" className="share-enable-btn" onClick={() => void enableShare()} disabled={shareBusy}>
                  {shareBusy ? '生成中…' : '生成分享链接'}
                </button>
              )}
            </div>
          )}
        </div>

      </header>

      <div className="viewer-body">
        {drawer !== 'none' && (
          <div className="drawer-backdrop mobile-only" onClick={() => setDrawer('none')} />
        )}
        <aside className={`sidebar pcanvas-sidebar ${drawer === 'left' ? 'is-open' : ''}`}>
          <div className="sidebar-section sidebar-grow">
            <div className="sidebar-head">
              <h3>画板 · {frames.length}</h3>
              <button
                className="pcanvas-edit-btn sidebar-collapse-all"
                title="收起所有编组"
                aria-label="收起所有编组"
                onClick={collapseAll}
              >
                <CollapseAll />
              </button>
              {!readOnly && (
                <button
                  className="pcanvas-edit-btn sidebar-add-group"
                  title="新建空编组（建好后把画板拖进去）"
                  onClick={() => void addEmptyGroup()}
                >
                  <Plus />
                </button>
              )}
            </div>
            <div
              className="pcanvas-frame-list"
              role={readOnly ? undefined : 'listbox'}
              aria-multiselectable={!readOnly}
            >
              {topGroups.map((g) => renderGroup(g, 0))}
              {frames.length > 0 && (
                <div className="page-group page-group-unassigned is-global">
                  <div
                    className={`page-row ${
                      dropPageId === '__none:global' ? 'is-droptarget' : ''
                    }`}
                    title={
                      readOnly
                        ? `未分组（${ungrouped.length} 个画板）`
                        : `未分组（${ungrouped.length} 个画板）· 全部设计稿未归组的画板都在这里，可拖入/拖出`
                    }
                    onClick={() => {
                      // 「未分组」只是容器：点击只折叠/展开，不选中成员、不显示选中态
                      togglePage('__none:global');
                    }}
                    onDragOver={(e) => {
                      if (!readOnly && dragFrameIdRef.current) {
                        e.preventDefault();
                        setDropPageId('__none:global');
                        setDropFrameHint(null);
                        autoExpand('__none:global');
                      }
                    }}
                    onDragLeave={() => setDropPageId((v) => (v === '__none:global' ? null : v))}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!readOnly && dragFrameIdRef.current) void dropOnUngrouped();
                    }}
                  >
                    <button
                      type="button"
                      className="page-caret"
                      aria-label={openPages.has('__none:global') ? '折叠 未分组' : '展开 未分组'}
                      aria-expanded={openPages.has('__none:global')}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePage('__none:global');
                      }}
                    >
                      {openPages.has('__none:global') ? <ChevronDown /> : <ChevronRight />}
                    </button>
                    <span
                      className="page-name"
                      role="button"
                      tabIndex={0}
                      aria-expanded={openPages.has('__none:global')}
                      title={`未分组（${ungrouped.length} 个画板）· 点击折叠/展开`}
                      onClick={(e) => {
                        // 父 .page-row 也有展开逻辑：不阻断冒泡会连续 toggle 两次而互相抵消
                        e.stopPropagation();
                        togglePage('__none:global');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          togglePage('__none:global');
                        }
                      }}
                    >
                      <Folder className="page-group-icon" size={16} />
                      未分组
                    </span>
                    <span className="page-count">{ungrouped.length}</span>
                  </div>
                  {openPages.has('__none:global') && (
                    <div className="page-frames" role={readOnly ? undefined : 'listbox'} aria-multiselectable={!readOnly}>
                      {ungrouped.length === 0 ? (
                        <p className="dim small page-empty-hint">从编组拖出，或把画板拖到这里移出编组</p>
                      ) : (
                        ungrouped.map((f) => renderFrameRow(f))
                      )}
                    </div>
                  )}
                </div>
              )}
              {frames.length === 0 && <p className="page-empty-hint dim">暂无画板，先导入设计稿</p>}
            </div>
          </div>
        </aside>

        <div
          className={`canvas-container pcanvas-stage${spacePan ? ' space-pan' : ''} ${bg.className}`}
          ref={containerRef}
          style={bg.style}
          onPointerDown={(e) => {
            // 空格 / 中键平移；左键空白处：Shift=框选，普通按下=平移（拖动生效）
            if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
              e.preventDefault();
              panRef.current = { x: e.clientX, y: e.clientY };
              dragMovedRef.current = false;
              return;
            }
            if (e.button !== 0) return;
            // 只处理真正的空白处：画板/编组/缩放条上的按下冒泡到容器时直接忽略
            if ((e.target as HTMLElement).closest('.pcanvas-frame, .pcanvas-group-box, .pcanvas-group-band, .zoombar')) return;
            if (e.shiftKey) {
              beginMarquee(e);
              return;
            }
            e.preventDefault();
            panRef.current = { x: e.clientX, y: e.clientY };
            dragMovedRef.current = false;
            leftPanRef.current = true;
          }}
          onContextMenu={(e) => {
            // 画板自身已 stopPropagation；这里只处理「框选后在空白处右键」，
            // 让批量删除不必再精确右键到某一个画板上
            if (readOnly || !selectedFrames.size) return;
            e.preventDefault();
            const firstId = [...selectedFrames][0];
            setCtxMenu({ x: e.clientX, y: e.clientY, frameId: firstId });
          }}
          onDragOver={(e) => {
            if (!readOnly && dragFrameIdRef.current) e.preventDefault();
          }}
          onDrop={(e) => {
            // 从侧栏拖到画布空白 → 移出编组（回到全局未分组）
            e.preventDefault();
            if (readOnly || !dragFrameIdRef.current) return;
            void dropOnUngrouped();
          }}
        >
        {frames.length === 0 ? (
          <div className="pcanvas-empty">
            <p>还没有可展示的画板</p>
            <p className="dim">在页面内粘贴（Ctrl/⌘ + V）图片或 Figma 图层即可导入画板</p>
          </div>
        ) : (
          <div
            className="pcanvas-world"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
            role={readOnly ? undefined : 'listbox'}
            aria-multiselectable={!readOnly}
          >
            {/* 连线层：始终显示，顶栏开关只控制能否操作；与画板同处 world 坐标系，随缩放/平移实时重算 */}
            {(links.length > 0 || linkDraft) && (() => {
              const ox = (layout.minX - 240) * zoom;
              const oy = (layout.minY - 240) * zoom;
              const w = (layout.maxX - layout.minX + 480) * zoom;
              const h = (layout.maxY - layout.minY + 480) * zoom;
              const toSvg = (p: { x: number; y: number }) => ({ x: p.x * zoom - ox, y: p.y * zoom - oy });
              return (
                <svg
                  className={`pcanvas-link-layer${linkMode ? '' : ' is-readonly'}`}
                  data-link-layer="1"
                  style={{ left: ox, top: oy, width: w, height: h }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <defs>
                    <marker
                      id="pcanvas-link-arrow"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="9"
                      markerHeight="9"
                      orient="auto"
                      markerUnits="userSpaceOnUse"
                    >
                      <path className="pcanvas-link-arrow" d="M0 0 L10 5 L0 10 Z" />
                    </marker>
                  </defs>
                  {links.map((link) => {
                    const a = placedById.get(link.from_frame_id);
                    const b = placedById.get(link.to_frame_id);
                    if (!a || !b) return null;
                    const g = linkCurve(
                      { x: a.px, y: a.py, w: a.f.width, h: a.f.height },
                      { x: b.px, y: b.py, w: b.f.width, h: b.f.height },
                      link.from_side ?? 'right',
                      zoom, ox, oy
                    );
                    const hot = hoverLinkId === link.id;
                    return (
                      <g
                        key={link.id}
                        data-link-id={link.id}
                        className={`pcanvas-link ${hot ? 'is-hot' : ''}`}
                        onPointerEnter={() => setHoverLinkId(link.id)}
                        onPointerLeave={() => setHoverLinkId(null)}
                      >
                        <path className="pcanvas-link-hit" d={g.d} />
                        <path className="pcanvas-link-line" d={g.d} markerEnd="url(#pcanvas-link-arrow)" />
                        {!readOnly && linkMode && hot && (
                          <g
                            className="pcanvas-link-del"
                            data-link-del={link.id}
                            transform={`translate(${g.mid.x}, ${g.mid.y})`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              void removeLink(link);
                            }}
                          >
                            <circle r="9" />
                            <path d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5" />
                          </g>
                        )}
                      </g>
                    );
                  })}
                  {linkDraft && (() => {
                    const a = placedById.get(linkDraft.fromId);
                    if (!a) return null;
                    const rectA = { x: a.px, y: a.py, w: a.f.width, h: a.f.height };
                    const p1 = toSvg(portPoint(rectA, linkDraft.side));
                    const target = linkDraft.targetId ? placedById.get(linkDraft.targetId) : null;
                    // 已对准目标画板时，预览曲线与最终落库后的曲线完全一致
                    const curve = target
                      ? linkCurve(
                          rectA,
                          { x: target.px, y: target.py, w: target.f.width, h: target.f.height },
                          linkDraft.side, zoom, ox, oy
                        )
                      : null;
                    const p2 = toSvg(linkDraft.cursor);
                    return (
                      <g className="pcanvas-link-preview">
                        <path d={curve ? curve.d : `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`} />
                      </g>
                    );
                  })()}
                </svg>
              );
            })()}
            {layout.bands.map((b) => {
              const key = groupKey(b.pageId);
              const hot = dropPageId === key;
              const isUn = b.pageId === null;
              return (
                <Fragment key={b.key}>
                  <div
                    className={`pcanvas-group-band ${isUn ? 'is-ungrouped' : ''} ${
                      hot ? 'is-droptarget' : ''
                    }`}
                    style={{ left: b.x * zoom, top: b.y * zoom - 28 }}
                    data-group-name={b.name}
                    data-page-id={b.pageId ?? ''}
                    title={
                      isUn
                        ? `未分组（${b.frameIds.length} 个画板）· 画板拖出编组后回到这里`
                        : `${b.name}（${b.frameIds.length} 个画板）· 点击选中整组，可拖入画板`
                    }
                    onClick={() => {
                      if (!readOnly && b.frameIds.length) selectFrames(b.frameIds);
                    }}
                    onPointerDown={(e) => beginGroupDrag(b, e)}
                    onDragOver={(e) => {
                      if (readOnly || !dragFrameIdRef.current) return;
                      e.preventDefault();
                      setDropPageId(key);
                      setDropFrameHint(null);
                      if (isUn) setOpenPages((s) => new Set(s).add('__none:global'));
                    }}
                    onDragLeave={() => setDropPageId((v) => (v === key ? null : v))}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (readOnly || !dragFrameIdRef.current) return;
                      if (isUn) void dropOnUngrouped();
                      else void dropOnPage(b.fileId, b.pageId);
                    }}
                  >
                    <span className="pcanvas-band-name">{b.name}</span>
                    <span className="pcanvas-band-count">{b.frameIds.length}</span>
                    {groupDelta && groupDragRef.current?.ids[0] === b.frameIds[0] && (
                      <span className="pcanvas-band-delta">
                        Δx {groupDelta.x}, Δy {groupDelta.y}
                      </span>
                    )}
                  </div>
                  {!isUn && (
                    <div
                      className={`pcanvas-group-box ${hot ? 'is-droptarget' : ''}`}
                      style={{
                        left: b.x * zoom,
                        top: b.y * zoom,
                        width: b.w * zoom,
                        height: b.h * zoom,
                      }}
                      title={readOnly ? b.name : `${b.name} · 可把画板拖进这个编组（空白处拖动 = 平移画布，拖顶部横条 = 移动整组）`}
                      data-group-name={b.name}
                      data-page-id={b.pageId ?? ''}
                      onClick={() => {
                        if (!readOnly && b.frameIds.length) selectFrames(b.frameIds);
                      }}
                      onPointerDown={(e) => {
                        if (e.target === e.currentTarget) beginGroupDrag(b, e);
                      }}
                      onDragOver={(e) => {
                        if (readOnly || !dragFrameIdRef.current) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setDropPageId(key);
                        setDropFrameHint(null);
                      }}
                      onDragLeave={(e) => {
                        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                        setDropPageId((v) => (v === key ? null : v));
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (readOnly || !dragFrameIdRef.current) return;
                        void dropOnPage(b.fileId, b.pageId);
                      }}
                    >
                      {b.frameIds.length === 0 && <span className="pcanvas-group-empty" aria-hidden="true" />}
                    </div>
                  )}
                </Fragment>
              );
            })}
            {layout.placed.map(({ f, px, py }) => (
              <div
                key={f.id}
                data-frame-id={f.id}
                role={readOnly ? undefined : 'option'}
                aria-selected={readOnly ? undefined : selectedFrames.has(f.id)}
                className={`pcanvas-frame ${selectedFrames.has(f.id) ? 'is-selected' : ''} ${
                  dropFrameHint?.frameId === f.id ? 'is-drop-target' : ''
                } ${linkDraft?.targetId === f.id ? 'is-link-target' : ''} ${
                  linkDraft?.fromId === f.id ? 'is-link-source' : ''
                }`}
                style={{
                  left: px * zoom,
                  top: py * zoom,
                  width: f.width * zoom,
                  height: f.height * zoom,
                }}
                title={`${f.file_name} / ${f.name}（拖动可任意摆放，双击打开，Ctrl/⌘ 多选，方向键微调，框选后按 Delete 删除）`}
                onPointerDown={(e) => beginFrameDrag(f, e)}
                onClick={(e) => onFrameClick(f, e)}
                onContextMenu={(e) => openCtxMenu(f, e)}
                onDoubleClick={(e) => onFrameDoubleClick(f, e)}
              >
                {renamingFrameId === f.id ? (
                  <input
                    className="pcanvas-frame-name-input"
                    value={renameValue}
                    autoFocus
                    maxLength={100}
                    style={{ fontSize: Math.max(11, Math.round(12 * Math.min(zoom, 2))) }}
                    onChange={(e) => {
                      setRenameValue(e.target.value);
                      renameValueRef.current = e.target.value;
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void commitFrameRename(f);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        renamingIdRef.current = null;
                        setRenamingFrameId(null);
                      }
                    }}
                    onBlur={() => void commitFrameRename(f)}
                  />
                ) : (
                  <span
                    className="pcanvas-frame-name"
                    style={{ fontSize: Math.max(11, Math.round(12 * Math.min(zoom, 2))) }}
                    title={`${f.name}（双击重命名）`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      if (readOnly) return;
                      renamingIdRef.current = f.id;
                      renameValueRef.current = f.name;
                      setRenameValue(f.name);
                      setRenamingFrameId(f.id);
                    }}
                  >
                    {f.name}
                  </span>
                )}
                {dropFrameHint?.frameId === f.id && (
                  <span className={`pcanvas-drop-line is-${dropFrameHint.position}`} />
                )}
                {f.thumb_url ? (
                  <img className="artboard-img" src={f.thumb_url} alt={f.name} draggable={false} />
                ) : (
                  <div className="pcanvas-placeholder" style={{ fontSize: Math.max(12, 14 / zoom) }}>
                    {f.name}
                  </div>
                )}
              </div>
            ))}
            {alignBar && (
              <div
                className="pcanvas-alignbar"
                style={{ left: alignBar.left, top: alignBar.top }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button title="左对齐" onClick={() => void alignSelection('left', alignBar.ids)}><AlignFrameLeft /></button>
                <button title="水平居中对齐" onClick={() => void alignSelection('hcenter', alignBar.ids)}><AlignFrameHCenter /></button>
                <button title="右对齐" onClick={() => void alignSelection('right', alignBar.ids)}><AlignFrameRight /></button>
                <button title="顶部对齐" onClick={() => void alignSelection('top', alignBar.ids)}><AlignFrameTop /></button>
                <button title="垂直居中对齐" onClick={() => void alignSelection('vcenter', alignBar.ids)}><AlignFrameVCenter /></button>
                <button title="底部对齐" onClick={() => void alignSelection('bottom', alignBar.ids)}><AlignFrameBottom /></button>
                <span className="pcanvas-alignbar-sep" />
                <button
                  title="水平等间距"
                  disabled={alignBar.ids.length < 3}
                  onClick={() => void alignSelection('disth', alignBar.ids)}
                >
                  <DistributeH />
                </button>
                <button
                  title="垂直等间距"
                  disabled={alignBar.ids.length < 3}
                  onClick={() => void alignSelection('distv', alignBar.ids)}
                >
                  <DistributeV />
                </button>
              </div>
            )}
          </div>
        )}

        {marquee && (
          <div
            className="pcanvas-marquee"
            style={{
              left: pan.x + marquee.x * zoom,
              top: pan.y + marquee.y * zoom,
              width: marquee.w * zoom,
              height: marquee.h * zoom,
            }}
          />
        )}
        {guides.v !== null && <div className="pcanvas-guide is-v" style={{ left: pan.x + guides.v * zoom }} />}
        {guides.h !== null && <div className="pcanvas-guide is-h" style={{ top: pan.y + guides.h * zoom }} />}

        <div className="zoombar">
          <button onClick={() => zoomCenter(zoom / 1.25)} title="缩小" aria-label="缩小"><Minus /></button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomCenter(zoom * 1.25)} title="放大" aria-label="放大"><Plus /></button>
          <button onClick={fit} title="适应画布"><Maximize /><span>适应</span></button>
          <button onClick={() => zoomCenter(1)} title="缩放回到 100%">100%</button>
          <CanvasBgPicker token={canvasBg} onPick={pickCanvasBg} />
        </div>
        </div>
      </div>

      {pasteToast && (
        <div className={`paste-toast ${pasteToast.kind}`}>
          <span>{pasteToast.text}</span>
          {pasteToast.kind === 'figma' && pasteToast.url && (
            <>
              <button onClick={() => void importFromClipboard(pasteToast.url!)}>一键导入</button>
              <button className="ghost" onClick={() => setPasteToast(null)}>忽略</button>
            </>
          )}
        </div>
      )}
      {ctxMenu && ctxFrame && !readOnly && (
        <>
          <div
            className="ctx-backdrop"
            onClick={closeCtxMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeCtxMenu();
            }}
          />
          <div
            className="ctx-menu"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 250),
              top: Math.min(ctxMenu.y, window.innerHeight - 380),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ctx-title">已选 {ctxIds().length} 个画板</div>
            {!ctxSameFile() && <div className="ctx-hint">跨设计稿选择不能编组或移动，请取消后重选</div>}
            <button disabled={!ctxSameFile()} onClick={() => { closeCtxMenu(); void createGroupFromSelection(ctxFrame.page_id); }}>
              <Plus /> {ctxFrame.page_id
                ? `在「${pages.find((p) => p.id === ctxFrame.page_id)?.name ?? '编组'}」内新建子编组…`
                : '新建编组…'}
            </button>
            {ctxFrame.page_id && (
              <button disabled={!ctxSameFile()} onClick={() => { closeCtxMenu(); void moveSelection(null); }}>
                <FolderMinus /> 移出编组
              </button>
            )}
            <div className="ctx-sep" />
            <div className="ctx-label"><Folder /> 移入编组</div>
            {pagesOfFile(ctxFrame.file_id).filter((p) => p.id !== ctxFrame.page_id).length === 0 && (
              <div className="ctx-hint">该设计稿还没有其它编组</div>
            )}
            {pagesOfFile(ctxFrame.file_id)
              .filter((p) => p.id !== ctxFrame.page_id)
              .map((pg) => (
                <button key={pg.id} disabled={!ctxSameFile()} onClick={() => { closeCtxMenu(); void moveSelection(pg.id); }}>
                  <Check /> {pg.name}
                </button>
              ))}
            <div className="ctx-sep" />
            <button onClick={() => { setSelectedFrames(new Set()); closeCtxMenu(); }}><X /> 取消选中</button>
            <button
              className="is-danger"
              onClick={() => { closeCtxMenu(); void removeFrames(ctxIds()); }}
            >
              <Trash2 /> {ctxIds().length > 1 ? `删除选中的 ${ctxIds().length} 个画板` : '删除画板'}
            </button>
          </div>
        </>
      )}
      {toast && (
        <div className="paste-toast" role="status">
          {toast}
        </div>
      )}
      {dialogs.element}
    </div>
  );
}
