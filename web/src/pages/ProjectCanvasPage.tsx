import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getIdentity, setActiveTeam } from '../api';
import type { FileDetail, ProjectFrameRow, ProjectPageRow } from '../types';
import { DeviceOptionGroups, findDevice } from '../viewer/devices';
import { useDialogs } from '../components/Dialogs';

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending: { text: '排队中', cls: 'status-wait' },
  processing: { text: '解析中', cls: 'status-wait' },
  ready: { text: '就绪', cls: 'status-ok' },
  failed: { text: '失败', cls: 'status-err' },
};

const SOURCE_TAG: Record<string, string> = { sketch: 'Sketch', psd: 'PSD', figma: 'Figma' };

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const GAP_X = 120; // 画板横向间距
const GAP_Y = 150; // 文件行间距
const GROUP_HEADER_H = 40; // 画布上编组标题带高度（世界坐标）

interface Placed {
  f: ProjectFrameRow;
  px: number;
  py: number;
}

/** 画布上的编组行（标题带）：文件 + 编组（pageId=null 为未分组） */
interface GroupBand {
  key: string;
  fileId: string;
  fileName: string;
  pageId: string | null;
  name: string;
  y: number;
  width: number;
  frameIds: string[];
}

export default function ProjectCanvasPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<{ id: string; name: string; team_id: string | null; team_name: string | null } | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const readOnlyRef = useRef(false);
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
  const [error, setError] = useState('');
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const dragMovedRef = useRef(false);
  // 空格按住 = 平移模式（Figma 式）：光标变抓手，松开后才允许点击画板
  const [spacePan, setSpacePan] = useState(false);
  const spaceRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // 画布平移偏移（transform 实现，无需滚动空间，任意方向可拖）
  const [pan, setPanState] = useState({ x: 0, y: 0 });
  const panXYRef = useRef({ x: 0, y: 0 });
  const setPanXY = useCallback((x: number, y: number) => {
    panXYRef.current = { x, y };
    setPanState({ x, y });
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 导入面板
  const [importOpen, setImportOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  // 小屏左侧画板列表抽屉
  const [drawer, setDrawer] = useState<'none' | 'left'>('none');

  const setZoom = useCallback((z: number) => {
    zoomRef.current = clamp(z, MIN_ZOOM, MAX_ZOOM);
    setZoomState(zoomRef.current);
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
    api
      .listProjectFrames(projectId)
      .then((r) => {
        const nextFrames = Array.isArray(r?.frames) ? r.frames : [];
        const nextPages = Array.isArray(r?.pages) ? r.pages : [];
        setFrames(nextFrames);
        setPages(nextPages);
        // 刷新后保持选中，但剔除已被删除的画板
        setSelectedFrames((s) => {
          const valid = new Set(nextFrames.map((f) => f.id));
          const kept = new Set([...s].filter((id) => valid.has(id)));
          return kept.size === s.size ? s : kept;
        });
        // 首次加载展开全部编组；之后只展开新增编组，保留用户折叠状态
        setOpenPages((prev) => {
          const next = new Set(prev);
          if (!knownPagesRef.current.size) next.add('__none');
          for (const pg of nextPages) {
            if (!knownPagesRef.current.has(pg.id)) next.add(pg.id);
            knownPagesRef.current.add(pg.id);
          }
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
      load();
    } catch (e) {
      void dialogs.alert(e instanceof Error ? e.message : '重命名失败');
    }
  };

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
  const groupKey = (pageId: string | null) => pageId ?? '__none';

  /** 左侧「设计稿 → 编组 → 画板」树（组内按 page_sort 排序） */
  const fileTree = useMemo(() => {
    const order: {
      fileId: string;
      fileName: string;
      groups: { key: string; pageId: string | null; name: string; items: ProjectFrameRow[] }[];
    }[] = [];
    for (const f of frames) {
      let file = order.find((x) => x.fileId === f.file_id);
      if (!file) {
        file = { fileId: f.file_id, fileName: f.file_name, groups: [] };
        order.push(file);
        const pgList = pages
          .filter((p) => p.file_id === f.file_id)
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        for (const pg of pgList) file.groups.push({ key: pg.id, pageId: pg.id, name: pg.name, items: [] });
        file.groups.push({ key: '__none', pageId: null, name: '未分组', items: [] });
      }
      const g =
        file.groups.find((x) => (x.pageId ?? null) === (f.page_id ?? null)) ?? file.groups[file.groups.length - 1];
      g.items.push(f);
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
    return order;
  }, [frames, pages]);

  /** 侧栏当前“视觉顺序”里的画板 id：只算展开的编组，未分组排最后 */
  const visibleFrameIds = () => {
    const ids: string[] = [];
    for (const file of fileTree) {
      for (const g of file.groups) {
        if (!openPages.has(g.key)) continue;
        g.items.forEach((f) => ids.push(f.id));
      }
    }
    return ids;
  };

  /** 选中后自动展开所在编组，保证侧栏能看到选中行 */
  const revealSelection = (ids: Iterable<string>) => {
    setOpenPages((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        const f = frameById.get(id);
        if (f) next.add(groupKey(f.page_id ?? null));
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
  const togglePage = (key: string) =>
    setOpenPages((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

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

  const createGroupFromSelection = async () => {
    if (!selectedFrames.size) return;
    const fileId = selectedSingleFile();
    if (!fileId) {
      await dialogs.alert('选中的画板来自多个设计稿，编组只能在同一个设计稿内创建。请分别选择后再建组。');
      return;
    }
    const name = await dialogs.prompt({
      title: `新建编组（${selectedFrames.size} 个画板）`,
      label: '编组名称',
      placeholder: '例如：登录流程',
      maxLength: 50,
      validate: (v) => validatePageName(fileId, v),
    });
    if (!name) return;
    try {
      const pg = await api.createPage(fileId, name);
      await api.moveFramesToPage(fileId, [...selectedFrames], pg.id);
      knownPagesRef.current.add(pg.id);
      setOpenPages((s) => new Set(s).add(pg.id));
      setSelectedFrames(new Set());
      load();
    } catch (e) {
      fail(e);
    }
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
      await api.renamePage(pg.file_id, pg.id, name);
      load();
    } catch (e) {
      fail(e);
    }
  };

  const removePage = async (pg: ProjectPageRow) => {
    const list = pageFrames(pg.file_id, pg.id);
    const mode = await dialogs.choose({
      title: `删除编组「${pg.name}」`,
      message: `该编组内有 ${list.length} 个画板，请选择处理方式：`,
      options: [
        { label: '解散编组，保留内容（画板移入未分组）', value: 'dissolve' },
        { label: '删除编组并删除其中内容', value: 'content', danger: true },
      ],
    });
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
      await api.moveFramesToPage(fileId, [...selectedFrames], pageId);
      setSelectedFrames(new Set());
      if (pageId) setOpenPages((s) => new Set(s).add(pageId));
      load();
    } catch (e) {
      fail(e);
    }
  };

  // ---------- 拖拽：拖进/拖出编组、跨组移动、组内排序 ----------
  const draggingIds = () => {
    const id = dragFrameIdRef.current ?? dragFrameId;
    return id ? (selectedFrames.has(id) ? [...selectedFrames] : [id]) : [];
  };
  const draggingIdsForFile = (fileId: string) =>
    draggingIds().filter((id) => frameById.get(id)?.file_id === fileId);
  const clearDrag = () => {
    dragFrameIdRef.current = null;
    setDragFrameId(null);
    setDropPageId(null);
    setDropFrameHint(null);
  };

  /** 拖到编组标题：追加到该编组末尾（pageId=null 为未分组） */
  const dropOnPage = async (fileId: string, pageId: string | null) => {
    const ids = draggingIdsForFile(fileId);
    if (!ids.length) {
      clearDrag();
      return;
    }
    const rest = pageFrames(fileId, pageId).filter((f) => !ids.includes(f.id)).map((f) => f.id);
    try {
      await api.reorderFrames(fileId, pageId, [...rest, ...ids]);
      if (pageId) setOpenPages((s) => new Set(s).add(pageId));
      load();
    } catch (e) {
      fail(e);
    }
    clearDrag();
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
    try {
      await api.reorderFrames(target.file_id, pageId, order);
      if (pageId) setOpenPages((s) => new Set(s).add(pageId));
      load();
    } catch (e) {
      fail(e);
    }
    clearDrag();
  };

  /** 画板交互：单击选中（Ctrl/⌘ 切换、Shift 连选）；双击进入详情；只读单击仍直接进入 */
  const onFrameClick = (f: ProjectFrameRow, e: React.MouseEvent) => {
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
          showToast('err', err instanceof Error ? err.message : '导入失败');
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
        showToast('err', err instanceof Error ? err.message : '导入失败');
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

  // 画布布局：每份设计稿内按编组分行（组标题在上），画板从左到右排列
  const layout = useMemo(() => {
    const placed: Placed[] = [];
    const bands: GroupBand[] = [];
    let y = 0;
    let worldW = 0;
    for (const file of fileTree) {
      for (const g of file.groups) {
        if (!g.items.length) continue;
        const py = y + GROUP_HEADER_H;
        let x = 0;
        let rowH = 0;
        for (const f of g.items) {
          placed.push({ f, px: x, py });
          x += f.width + GAP_X;
          rowH = Math.max(rowH, f.height);
        }
        const rowW = Math.max(x - GAP_X, 0);
        bands.push({
          key: `${file.fileId}:${g.key}`,
          fileId: file.fileId,
          fileName: file.fileName,
          pageId: g.pageId,
          name: g.name,
          y,
          width: rowW,
          frameIds: g.items.map((f) => f.id),
        });
        worldW = Math.max(worldW, rowW);
        y += GROUP_HEADER_H + rowH + GAP_Y;
      }
    }
    return { placed, bands, worldW, worldH: Math.max(y - GAP_Y, 0) };
  }, [fileTree]);

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || !layout.worldW) return;
    const pad = 100;
    const z = clamp(
      Math.min((el.clientWidth - pad) / layout.worldW, (el.clientHeight - pad) / layout.worldH, 1),
      MIN_ZOOM,
      MAX_ZOOM
    );
    setZoom(z);
    setPanXY(
      (el.clientWidth - layout.worldW * zoomRef.current) / 2,
      (el.clientHeight - layout.worldH * zoomRef.current) / 2
    );
  }, [layout.worldW, layout.worldH, setZoom, setPanXY]);

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

  // ctrl/meta + 滚轮缩放（以光标为锚点）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
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

  // 键盘 + / - 缩放画布（输入框聚焦时不触发）
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === 'Escape') {
        setSelectedFrames(new Set());
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
  }, [zoomCenter]);

  // 空白处拖拽平移
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const move = (e: PointerEvent) => {
      if (!panRef.current) return;
      const dx = e.clientX - panRef.current.x;
      const dy = e.clientY - panRef.current.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMovedRef.current = true;
      const p = panXYRef.current;
      setPanXY(p.x + dx, p.y + dy);
      panRef.current = { x: e.clientX, y: e.clientY };
    };
    const up = () => (panRef.current = null);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', up);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointerleave', up);
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy || !projectId) return;
    setBusy(true);
    setError('');
    try {
      const { id } = await api.importFile(url.trim(), projectId);
      setUrl('');
      setImportOpen(false);
      navigate(`/files/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const parsing = files.filter((f) => f.status === 'pending' || f.status === 'processing').length;

  return (
    <div className="viewer">
      <header className="topbar">
        <button
          className="icon-btn mobile-only"
          onClick={() => setDrawer(drawer === 'left' ? 'none' : 'left')}
          title="画板列表"
        >
          ☰
        </button>
        <Link to="/" className="back">← 返回首页</Link>
        <h1>📁 {project?.name ?? '…'}</h1>
        {project?.team_name && (
          <Link to={`/?team=${project.team_id}`} className="team-crumb">👥 {project.team_name}</Link>
        )}
        <span className="crumb">{frames.length} 个画板</span>
        {parsing > 0 && <span className="status status-wait status-pulse">解析中 {parsing}</span>}
        {readOnly && <span className="readonly-tag">协作者 · 只读</span>}
        <span className="spacer" />
        {!readOnly && (
          <details className="export-menu" open={importOpen} onToggle={(e) => setImportOpen((e.target as HTMLDetailsElement).open)}>
            <summary className="primary-link">＋ 导入设计稿</summary>
          <div className="export-menu-pop import-panel">
            <form className="import-box" onSubmit={submit}>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.figma.com/design/xxxxx/文件名"
              />
              <button type="submit" disabled={busy || !url.trim()}>
                {busy ? '导入中…' : '导入'}
              </button>
            </form>
            <input ref={fileInputRef} type="file" accept=".sketch,.psd" hidden onChange={onUpload} />
            <button className="upload-btn" disabled={!!uploading} onClick={() => fileInputRef.current?.click()}>
              {uploading || '⬆ 上传 Sketch / PSD 文件'}
            </button>
            <div className="paste-device-row">
              <label className="dim small" htmlFor="paste-device">粘贴图片的画板尺寸</label>
              <select
                id="paste-device"
                value={pasteDeviceId}
                onChange={(e) => pickPasteDevice(e.target.value)}
                title="选择设备后，粘贴导入的图片画板将按该设备尺寸规范创建（图片按填充裁切）"
              >
                <option value="">自动（按图片原始尺寸）</option>
                {DeviceOptionGroups()}
              </select>
            </div>
            <div className="file-list">
              <h2>项目内设计稿</h2>
              {files.length === 0 && <p className="empty">还没有设计稿，先导入或上传一份</p>}
              <ul>
                {files.map((f) => {
                  const st = STATUS_LABEL[f.status] ?? { text: f.status, cls: '' };
                  return (
                    <li key={f.id}>
                      <Link to={`/files/${f.id}`} className="file-card">
                        <span className="file-name">{f.name}</span>
                        <span className="file-meta">
                          {(SOURCE_TAG[f.source ?? 'figma'] ?? '') && (
                            <em className="source-tag">{SOURCE_TAG[f.source ?? 'figma']}</em>
                          )}
                          {f.frame_count ?? 0} 个画板
                        </span>
                      </Link>
                      <span className={`status ${st.cls} ${f.status === 'processing' || f.status === 'pending' ? 'status-pulse' : ''}`}>
                        {st.text}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
          </details>
        )}
        <span className="dim zoom-label">{Math.round(zoom * 100)}%</span>
      </header>

      <div className="viewer-body">
        {drawer !== 'none' && (
          <div className="drawer-backdrop mobile-only" onClick={() => setDrawer('none')} />
        )}
        <aside className={`sidebar pcanvas-sidebar ${drawer === 'left' ? 'is-open' : ''}`}>
          <div className="sidebar-section sidebar-grow">
            <h3>画板 · {frames.length}</h3>
            {!readOnly && (
              <div
                className={`page-selection-bar${selectedFrames.size ? '' : ' is-empty'}`}
                aria-hidden={selectedFrames.size === 0}
              >
                <span className="selection-count">已选 {selectedFrames.size}</span>
                <button
                  onClick={() => void createGroupFromSelection()}
                  title={selectedSingleFile() ? '把选中的画板组成新编组' : '选中的画板来自多个设计稿，无法直接建组'}
                >
                  新建编组
                </button>
                <select
                  value=""
                  disabled={!selectedSingleFile()}
                  title={
                    selectedSingleFile()
                      ? '把选中的画板移入编组'
                      : '选中的画板来自多个设计稿，请分别移入各自的编组'
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__none') void moveSelection(null);
                    else if (v) void moveSelection(v);
                  }}
                >
                  <option value="">移入编组…</option>
                  {(() => {
                    const fid = selectedSingleFile();
                    return fid
                      ? pagesOfFile(fid).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))
                      : null;
                  })()}
                  <option value="__none">未分组</option>
                </select>
                <button onClick={() => setSelectedFrames(new Set())}>取消</button>
              </div>
            )}
            <div
              className="pcanvas-frame-list"
              role={readOnly ? undefined : 'listbox'}
              aria-multiselectable={!readOnly}
            >
              {fileTree.map((file) => (
                <div key={file.fileId} className="pcanvas-file-group">
                  <div className="pcanvas-file-name" title={file.fileName}>
                    <span className="pcanvas-file-name-text">{file.fileName}</span>
                    {!readOnly && (
                      <button
                        className="pcanvas-edit-btn"
                        title="重命名设计稿"
                        onClick={() => void renameFile(file.fileId, file.fileName)}
                      >
                        ✏
                      </button>
                    )}
                  </div>
                  {file.groups.map((g) => {
                    const open = openPages.has(g.key);
                    const pg = g.pageId ? pages.find((p) => p.id === g.pageId) ?? null : null;
                    const groupSelected =
                      g.items.length > 0 && g.items.every((f) => selectedFrames.has(f.id));
                    return (
                      <div key={g.key} className={`page-group ${g.pageId ? '' : 'page-group-unassigned'}`}>
                        <div
                          className={`page-row ${dropPageId === g.key ? 'is-droptarget' : ''} ${
                            groupSelected ? 'is-selected' : ''
                          }`}
                          title={
                            readOnly
                              ? `${g.name}（${g.items.length} 个画板）`
                              : `${g.name}（${g.items.length} 个画板）· 点击选中整组，点左侧箭头折叠`
                          }
                          onClick={() => {
                            if (readOnly) {
                              togglePage(g.key);
                              return;
                            }
                            if (g.items.length) selectFrames(g.items.map((f) => f.id));
                            else togglePage(g.key);
                          }}
                          onDragOver={(e) => {
                            if (!readOnly && dragFrameIdRef.current) {
                              e.preventDefault();
                              setDropPageId(g.key);
                              setDropFrameHint(null);
                            }
                          }}
                          onDragLeave={() => setDropPageId((v) => (v === g.key ? null : v))}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (!readOnly && dragFrameIdRef.current) void dropOnPage(file.fileId, g.pageId);
                          }}
                        >
                          <span
                            className="page-caret"
                            onClick={(e) => {
                              e.stopPropagation();
                              togglePage(g.key);
                            }}
                          >
                            {open ? '▾' : '▸'}
                          </span>
                          <span className="page-name" title={g.name}>
                            {g.name}
                          </span>
                          <span className="page-count">{g.items.length}</span>
                          {pg && !readOnly && (
                            <span className="page-actions" onClick={(e) => e.stopPropagation()}>
                              <button title="重命名编组" onClick={() => void renamePage(pg)}>
                                ✏
                              </button>
                              <button title="删除编组" onClick={() => void removePage(pg)}>
                                🗑
                              </button>
                            </span>
                          )}
                        </div>
                        {open && (
                          <div
                            className="page-frames"
                            role={readOnly ? undefined : 'listbox'}
                            aria-multiselectable={!readOnly}
                          >
                            {g.items.length === 0 && (
                              <p className="dim small page-empty-hint">拖画板到这里归入编组</p>
                            )}
                            {g.items.map((f) => (
                              <div
                                key={f.id}
                                role={readOnly ? undefined : 'option'}
                                aria-selected={readOnly ? undefined : selectedFrames.has(f.id)}
                                data-frame-id={f.id}
                                className={`pcanvas-frame-item ${
                                  selectedFrames.has(f.id) ? 'is-selected' : ''
                                } ${dropFrameHint?.frameId === f.id ? 'is-drop-target' : ''}`}
                                title={`${file.fileName} / ${f.name}（双击打开，Ctrl/⌘ 点击多选，Shift 连选）`}
                                draggable={!readOnly}
                                onClick={(e) => {
                                  setDrawer('none');
                                  onFrameClick(f, e);
                                }}
                                onDoubleClick={(e) => onFrameDoubleClick(f, e)}
                                onDragStart={(e) => onFrameDragStart(f, e)}
                                onDragEnd={onFrameDragEnd}
                                onDragOver={(e) => {
                                  if (readOnly || !dragFrameIdRef.current) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  hintFrameDrop(f, e.clientX, e.clientY, 'y');
                                }}
                                onDragLeave={() =>
                                  setDropFrameHint((h) => (h?.frameId === f.id ? null : h))
                                }
                                onDrop={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const position =
                                    dropFrameHint?.frameId === f.id ? dropFrameHint.position : 'before';
                                  void dropOnFrame(f, position);
                                }}
                              >
                                <span className="pcanvas-frame-item-name">{f.name}</span>
                                <em>
                                  {Math.round(f.width)}×{Math.round(f.height)}
                                </em>
                                {!readOnly && (
                                  <span
                                    className="pcanvas-edit-btn"
                                    title="重命名画板"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void renameFrame(f);
                                    }}
                                    onDoubleClick={stopFrameAction}
                                  >
                                    ✏
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
              {frames.length === 0 && <p className="page-empty-hint dim">暂无画板，先导入设计稿</p>}
            </div>
          </div>
        </aside>

        <div
          className={`canvas-container${spacePan ? ' space-pan' : ''}`}
          ref={containerRef}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          panRef.current = { x: e.clientX, y: e.clientY };
          dragMovedRef.current = false;
        }}
        onClick={(e) => {
          // 点击空白区域取消选中；拖拽平移或刚拖过画板时不处理
          if (dragMovedRef.current || draggedRef.current) return;
          const t = e.target as HTMLElement;
          if (t.closest('.pcanvas-frame, .pcanvas-group-band, .zoombar')) return;
          setSelectedFrames(new Set());
        }}
      >
        {frames.length === 0 ? (
          <div className="pcanvas-empty">
            <p>还没有可展示的画板</p>
            <p className="dim">点击右上角「＋ 导入设计稿」，导入 Figma 链接或上传 Sketch / PSD</p>
          </div>
        ) : (
          <div
            className="pcanvas-world"
            style={{
              width: layout.worldW * zoom,
              height: layout.worldH * zoom,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
            }}
            role={readOnly ? undefined : 'listbox'}
            aria-multiselectable={!readOnly}
          >
            {layout.bands.map((b) => (
              <div
                key={b.key}
                className={`pcanvas-group-band ${
                  dropPageId === groupKey(b.pageId) ? 'is-droptarget' : ''
                }`}
                style={{ top: b.y * zoom, minWidth: b.width * zoom }}
                title={`${b.fileName} / ${b.name}（点击选中整组，可拖入画板）`}
                onClick={() => {
                  if (readOnly) return;
                  selectFrames(b.frameIds);
                }}
                onDragOver={(e) => {
                  if (readOnly || !dragFrameIdRef.current) return;
                  e.preventDefault();
                  setDropPageId(groupKey(b.pageId));
                  setDropFrameHint(null);
                }}
                onDragLeave={() => setDropPageId((v) => (v === groupKey(b.pageId) ? null : v))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!readOnly && dragFrameIdRef.current) void dropOnPage(b.fileId, b.pageId);
                }}
              >
                <span className="pcanvas-band-file">{b.fileName}</span>
                <span className="pcanvas-band-sep">/</span>
                <span className="pcanvas-band-name">{b.name}</span>
                <span className="pcanvas-band-count">{b.frameIds.length}</span>
              </div>
            ))}
            {layout.placed.map(({ f, px, py }) => (
              <div
                key={f.id}
                data-frame-id={f.id}
                role={readOnly ? undefined : 'option'}
                aria-selected={readOnly ? undefined : selectedFrames.has(f.id)}
                className={`pcanvas-frame ${selectedFrames.has(f.id) ? 'is-selected' : ''} ${
                  dropFrameHint?.frameId === f.id ? 'is-drop-target' : ''
                }`}
                style={{
                  left: px * zoom,
                  top: py * zoom,
                  width: f.width * zoom,
                  height: f.height * zoom,
                }}
                title={`${f.file_name} / ${f.name}（单击选中，双击打开，Ctrl/⌘ 多选）`}
                draggable={!readOnly}
                onClick={(e) => onFrameClick(f, e)}
                onDoubleClick={(e) => onFrameDoubleClick(f, e)}
                onDragStart={(e) => onFrameDragStart(f, e)}
                onDragEnd={onFrameDragEnd}
                onDragOver={(e) => {
                  if (readOnly || !dragFrameIdRef.current) return;
                  e.preventDefault();
                  e.stopPropagation();
                  hintFrameDrop(f, e.clientX, e.clientY, 'x');
                }}
                onDragLeave={() => setDropFrameHint((h) => (h?.frameId === f.id ? null : h))}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const position = dropFrameHint?.frameId === f.id ? dropFrameHint.position : 'before';
                  void dropOnFrame(f, position);
                }}
              >
                {f.thumb_url ? (
                  <img className="artboard-img" src={f.thumb_url} alt={f.name} draggable={false} />
                ) : (
                  <div className="pcanvas-placeholder" style={{ fontSize: Math.max(12, 14 / zoom) }}>
                    {f.name}
                  </div>
                )}
                <span className="pcanvas-label">
                  <span
                    className={`pcanvas-label-part ${readOnly ? '' : 'is-editable'}`}
                    title={readOnly ? f.file_name : '点击修改设计稿名称'}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (dragMovedRef.current || readOnly) return;
                      void renameFile(f.file_id, f.file_name);
                    }}
                    onDoubleClick={stopFrameAction}
                  >
                    {f.file_name}
                  </span>
                  {' / '}
                  <span
                    className={`pcanvas-label-part ${readOnly ? '' : 'is-editable'}`}
                    title={readOnly ? f.name : '点击修改画板名称'}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (dragMovedRef.current || readOnly) return;
                      void renameFrame(f);
                    }}
                    onDoubleClick={stopFrameAction}
                  >
                    {f.name}
                  </span>
                  <em> {Math.round(f.width)}×{Math.round(f.height)}</em>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="zoombar">
          <button onClick={() => zoomCenter(zoom / 1.25)} title="缩小">−</button>
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomCenter(zoom * 1.25)} title="放大">+</button>
          <button onClick={fit} title="适应画布">适应</button>
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
      {dialogs.element}
    </div>
  );
}
