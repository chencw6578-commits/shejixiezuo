import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getIdentity, setActiveTeam, type CommentItem } from '../api';
import type { FileDetail, FrameDetail, LayerNode, ProjectFrameRow, ProjectPageRow } from '../types';
import Canvas from '../viewer/Canvas';
import PropertyPanel from '../viewer/PropertyPanel';
import CommentDrawer from '../viewer/CommentDrawer';
import { useDialogs } from '../components/Dialogs';
import RowMenu from '../components/RowMenu';
import { readUnit, saveUnit, unitForPlatform, type Unit } from '../unit';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  Menu,
  MessageSquare,
  PanelRight,
  Plus,
} from '../components/icons';

/** 侧栏树：设计稿 → 编组 → 画板（跨设计稿时都带 file_id） */
interface TreePage extends ProjectPageRow {
  file_name?: string;
}
interface FileNode {
  id: string;
  name: string;
}
interface CtxMenuState {
  x: number;
  y: number;
  frameId: string;
}

export default function ViewerPage() {
  const { fileId = '', frameId = '' } = useParams();
  const [file, setFile] = useState<{ name: string; project_id: string | null; team_id: string | null } | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const [data, setData] = useState<FrameDetail | null>(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // 小屏下左右面板抽屉化
  const [drawer, setDrawer] = useState<'none' | 'left' | 'right'>('none');
  // 评论协作
  const [commentMode, setCommentMode] = useState(false);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [author, setAuthor] = useState(() => localStorage.getItem('designhub-author') ?? '');
  const authorRef = useRef(author);
  authorRef.current = author;

  useEffect(() => {
    localStorage.setItem('designhub-author', author);
  }, [author]);

  const refreshComments = useCallback(() => {
    api.getComments(frameId).then(setComments).catch(() => undefined);
  }, [frameId]);

  useEffect(refreshComments, [refreshComments]);
  // 每 6 秒轮询新评论（内部工具 MVP，不引入 WebSocket）
  useEffect(() => {
    const t = setInterval(refreshComments, 6000);
    return () => clearInterval(t);
  }, [refreshComments]);

  useEffect(() => {
    setData(null);
    setSelectedId(null);
    api
      .getFrame(fileId, frameId)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [fileId, frameId]);

  // 单位默认值跟随导入平台（iOS→pt / Android→dp / Web→px）；用户手动切换后优先用户选择
  useEffect(() => {
    if (!data || unitPickedRef.current) return;
    setUnitState(unitForPlatform(data.frame.platform));
  }, [data]);

  // Esc 取消选中 / 关闭右键菜单
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedId(null);
        setCtxMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [frames, setFrames] = useState<ProjectFrameRow[]>([]);
  const [pages, setPages] = useState<TreePage[]>([]);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [openPages, setOpenPages] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  // 首轮加载才展开全部文件/编组，之后保留用户折叠状态
  const treeInitializedRef = useRef(false);
  const [dragFrameId, setDragFrameId] = useState<string | null>(null);
  const [dropPageId, setDropPageId] = useState<string | null>(null);
  const [dropFrameHint, setDropFrameHint] = useState<{ frameId: string; position: 'before' | 'after' } | null>(null);
  const [selectedFrames, setSelectedFrames] = useState<Set<string>>(new Set());
  // 区间连选（Shift）的起点：上一次点击的画板
  const selectionAnchorRef = useRef<string | null>(null);
  // 是否刚发生过拖拽：用于屏蔽拖拽结束后的双击打开
  const draggedRef = useRef(false);
  const [zipBusy, setZipBusy] = useState('');
  const dialogs = useDialogs();
  const navigate = useNavigate();
  // 单位切换：只影响数值后缀/标注，绝不改变画板尺寸与已存数据
  const [unit, setUnitState] = useState<Unit>(() => readUnit());
  // 用户手动切过单位后，本次会话不再被平台默认值覆盖
  const unitPickedRef = useRef(false);
  const pickUnit = (u: Unit) => {
    unitPickedRef.current = true;
    setUnitState(u);
    saveUnit(u);
  };
  /** 拉取当前项目下所有设计稿的画板与编组，组装成 设计稿 → 编组 → 画板 三层树 */
  const applyTree = async (f: FileDetail) => {
    let treeFrames: ProjectFrameRow[];
    let treePages: TreePage[];
    const fileMap = new Map<string, string>();
    if (f.project_id) {
      const res = await api.listProjectFrames(f.project_id);
      treeFrames = res.frames;
      treePages = res.pages as TreePage[];
      res.frames.forEach((x) => fileMap.set(x.file_id, x.file_name));
      treePages.forEach((p) => {
        if (!fileMap.has(p.file_id)) fileMap.set(p.file_id, p.file_name ?? p.file_id);
      });
    } else {
      treeFrames = (f.frames ?? []).map((x) => ({
        ...x,
        file_id: f.id,
        file_name: f.name,
        source: f.source ?? 'figma',
        page_id: x.page_id ?? null,
      }));
      treePages = (f.pages ?? []).map((p) => ({ ...p, file_id: f.id, file_name: f.name }));
      fileMap.set(f.id, f.name);
    }
    if (!fileMap.has(f.id)) fileMap.set(f.id, f.name);
    const fileNodes: FileNode[] = [...fileMap].map(([id, name]) => ({ id, name }));
    setFrames(treeFrames);
    setPages(treePages);
    setFiles(fileNodes);

    if (!treeInitializedRef.current) {
      treeInitializedRef.current = true;
      setOpenFiles(new Set(fileNodes.map((x) => x.id)));
      const keys = new Set<string>();
      treePages.forEach((p) => keys.add(p.id));
      treeFrames.filter((x) => !x.page_id).forEach((x) => keys.add(`__none:${x.file_id}`));
      setOpenPages(keys);
    } else {
      setOpenFiles((s) => new Set([...s, ...fileNodes.map((x) => x.id)]));
    }
    // 当前查看的画板所在设计稿/编组始终展开
    setOpenFiles((s) => new Set(s).add(f.id));
    const cur = treeFrames.find((x) => x.id === frameId);
    if (cur) setOpenPages((s) => new Set(s).add(cur.page_id ?? `__none:${cur.file_id}`));
  };

  useEffect(() => {
    api
      .getFile(fileId)
      .then((f) => {
        setFile({ name: f.name, project_id: f.project_id ?? null, team_id: f.team_id ?? null });
        setActiveTeam(f.team_id ?? null);
        setReadOnly(getIdentity(f.team_id ?? '')?.role === 'collaborator');
        return applyTree(f);
      })
      .catch((e) => setError(e.message));
  }, [fileId, frameId]);

  const refreshPages = async () => {
    const f = await api.getFile(fileId).catch(() => null);
    if (f) await applyTree(f).catch(() => undefined);
  };

  // ---------- 页面（编组）编辑：新建 / 重命名 / 删除 / 成员调整 ----------
  const fail = (e: unknown) => void dialogs.alert(e instanceof Error ? e.message : String(e));

  const sortFrames = (list: ProjectFrameRow[]) =>
    [...list].sort(
      (a, b) =>
        (a.page_sort ?? 0) - (b.page_sort ?? 0) ||
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        a.name.localeCompare(b.name)
    );
  const framesOfFile = (fid: string) => frames.filter((f) => f.file_id === fid);
  const pagesOfFile = (fid: string) =>
    [...pages].filter((p) => p.file_id === fid).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const pageFrames = (fid: string, pageId: string | null) =>
    sortFrames(framesOfFile(fid).filter((f) => (f.page_id ?? null) === pageId));
  const ungroupedOf = (fid: string) => pageFrames(fid, null);
  /** 侧栏拉平：所有设计稿的编组同层展示（归属保留，悬浮提示可查） */
  const flatGroups = useMemo(
    () => files.flatMap((fl) => pagesOfFile(fl.id).map((pg) => ({ pg, fileId: fl.id, fileName: fl.name }))),
    [files, pages]
  );
  /** 唯一全局未分组：所有设计稿里没归组的画板 */
  const globalUngrouped = useMemo(() => {
    const list = frames.filter((f) => !f.page_id);
    return [...list].sort(
      (a, b) =>
        a.file_name.localeCompare(b.file_name) ||
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        a.name.localeCompare(b.name)
    );
  }, [frames]);
  const filePageKey = (fid: string, pageId: string | null) => pageId ?? `__none:${fid}`;
  const draggingIds = () =>
    dragFrameId ? (selectedFrames.has(dragFrameId) ? [...selectedFrames] : [dragFrameId]) : [];
  const draggingIdsFor = (fid: string) =>
    draggingIds().filter((id) => frames.find((f) => f.id === id)?.file_id === fid);
  const clearDrag = () => {
    setDragFrameId(null);
    setDropPageId(null);
    setDropFrameHint(null);
  };
  const validatePageName = (fid: string, value: string, exceptId?: string) =>
    pages.some((p) => p.file_id === fid && p.id !== exceptId && p.name === value)
      ? `该设计稿下已存在同名编组「${value}」`
      : null;

  const addPage = async (fid: string) => {
    const name = await dialogs.prompt({
      title: '新建编组',
      label: '编组名称',
      placeholder: '例如：登录流程',
      maxLength: 50,
      validate: (v) => validatePageName(fid, v),
    });
    if (!name) return;
    try {
      const pg = await api.createPage(fid, name);
      await refreshPages();
      setOpenPages((s) => new Set(s).add(pg.id));
    } catch (e) {
      fail(e);
    }
  };

  const createGroupFromSelection = async (fid: string) => {
    const ids = [...selectedFrames].filter((id) => frames.find((f) => f.id === id)?.file_id === fid);
    if (!ids.length) return;
    const name = await dialogs.prompt({
      title: `新建编组（${ids.length} 个画板）`,
      label: '编组名称',
      placeholder: '例如：登录流程',
      maxLength: 50,
      validate: (v) => validatePageName(fid, v),
    });
    if (!name) return;
    try {
      const pg = await api.createPage(fid, name);
      await api.moveFramesToPage(fid, ids, pg.id);
      setSelectedFrames(new Set());
      await refreshPages();
      setOpenPages((s) => new Set(s).add(pg.id));
    } catch (e) {
      fail(e);
    }
  };

  const renamePage = async (pg: TreePage) => {
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
      await refreshPages();
    } catch (e) {
      fail(e);
    }
  };

  const removePage = async (pg: TreePage, forced?: 'dissolve' | 'content') => {
    const list = pageFrames(pg.file_id, pg.id);
    const mode = forced ?? (await dialogs.choose({
      title: `删除编组「${pg.name}」`,
      message: `该编组内有 ${list.length} 个画板，请选择处理方式：`,
      options: [
        { label: '解散编组，保留内容（画板移入未分组）', value: 'dissolve' },
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
      setSelectedFrames((s) => {
        const ids = new Set(list.map((f) => f.id));
        return new Set([...s].filter((id) => !ids.has(id)));
      });
      await refreshPages();
      // 解散后画板回到未分组：展开该段，避免看起来“画板消失”
      setOpenPages((s) => new Set(s).add(filePageKey(pg.file_id, null)));
      if (mode === 'content' && list.some((f) => f.id === frameId)) navigate(`/files/${pg.file_id}`);
    } catch (e) {
      fail(e);
    }
  };

  /** 重命名画板（侧栏 ⋯ 菜单） */
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
      await refreshPages();
      if (f.id === frameId) setData(await api.getFrame(f.file_id, f.id));
    } catch (e) {
      fail(e);
    }
  };

  /** 删除画板（侧栏 ⋯ 菜单，不可恢复） */
  const removeFrame = async (f: ProjectFrameRow) => {
    const ok = await dialogs.confirm({
      title: `删除画板「${f.name}」`,
      message: '该画板及其图层、评论将被删除，且不可恢复。',
      confirmText: '确认删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteFrame(f.file_id, f.id);
      setSelectedFrames((s) => new Set([...s].filter((id) => id !== f.id)));
      if (f.id === frameId) navigate(`/files/${f.file_id}`);
      await refreshPages();
    } catch (e) {
      fail(e);
    }
  };

  const moveSelection = async (fid: string, pageId: string | null) => {
    const ids = [...selectedFrames].filter((id) => frames.find((f) => f.id === id)?.file_id === fid);
    if (!ids.length) return;
    try {
      await api.moveFramesToPage(fid, ids, pageId);
      setSelectedFrames(new Set());
      setOpenPages((s) => new Set(s).add(filePageKey(fid, pageId)));
      await refreshPages();
    } catch (e) {
      fail(e);
    }
  };

  /** 乐观更新编组归属：松手后立即本地改状态（列表/成员数立刻生效），后台落库 */
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

  /** 拖到编组行/设计稿未分组行：追加到该组末尾（只处理同设计稿的画板） */
  const dropOnPage = async (fid: string, pageId: string | null) => {
    const ids = draggingIdsFor(fid);
    if (!ids.length) {
      clearDrag();
      return;
    }
    const rest = pageFrames(fid, pageId).filter((f) => !ids.includes(f.id)).map((f) => f.id);
    const order = [...rest, ...ids];
    setOpenPages((s) => new Set(s).add(filePageKey(fid, pageId)));
    applyMembershipLocal(fid, pageId, order);
    clearDrag();
    api.reorderFrames(fid, pageId, order).catch((e) => {
      fail(e);
      void refreshPages();
    });
  };

  /** 拖到全局未分组：跨设计稿的画板一起移出编组 */
  const dropOutToUngrouped = async () => {
    const ids = draggingIds();
    if (!ids.length) {
      clearDrag();
      return;
    }
    const byFile = new Map<string, string[]>();
    for (const id of ids) {
      const f = frames.find((x) => x.id === id);
      if (!f) continue;
      const arr = byFile.get(f.file_id) ?? [];
      arr.push(id);
      byFile.set(f.file_id, arr);
    }
    const jobs: { fid: string; order: string[] }[] = [];
    for (const [fid, list] of byFile) {
      const rest = pageFrames(fid, null).filter((f) => !list.includes(f.id)).map((f) => f.id);
      const order = [...rest, ...list];
      applyMembershipLocal(fid, null, order);
      jobs.push({ fid, order });
    }
    setOpenPages((s) => new Set(s).add('__none:global'));
    clearDrag();
    for (const job of jobs) {
      api.reorderFrames(job.fid, null, job.order).catch((e) => {
        fail(e);
        void refreshPages();
      });
    }
  };

  /** 拖到画板行：在该画板前/后插入，跨组时一并移入目标组 */
  const dropOnFrame = async (target: ProjectFrameRow, position: 'before' | 'after') => {
    const fid = target.file_id;
    const ids = draggingIdsFor(fid);
    if (!ids.length || ids.includes(target.id)) {
      clearDrag();
      return;
    }
    const pageId = target.page_id ?? null;
    const rest = pageFrames(fid, pageId).filter((f) => !ids.includes(f.id));
    const idx = rest.findIndex((f) => f.id === target.id);
    const at = idx < 0 ? rest.length : idx + (position === 'after' ? 1 : 0);
    const order = [...rest.slice(0, at).map((f) => f.id), ...ids, ...rest.slice(at).map((f) => f.id)];
    setOpenPages((s) => new Set(s).add(filePageKey(fid, pageId)));
    applyMembershipLocal(fid, pageId, order);
    clearDrag();
    api.reorderFrames(fid, pageId, order).catch((e) => {
      fail(e);
      void refreshPages();
    });
  };

  // ---------- 侧栏多选：Ctrl/⌘ 切换、Shift 连选、普通点击单选 ----------
  // macOS 上 Ctrl+点击 = 右键，所以 mac 只认 ⌘
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  const hasToggleModifier = (e: { ctrlKey: boolean; metaKey: boolean }) =>
    isMac ? e.metaKey : e.ctrlKey || e.metaKey;

  /** 左侧列表的视觉顺序（所有编组按设计稿顺序，最后是全局未分组），Shift 连选按此顺序 */
  const visibleFrameIds = () => {
    const ids: string[] = [];
    for (const fl of files) for (const pg of pagesOfFile(fl.id)) pageFrames(fl.id, pg.id).forEach((f) => ids.push(f.id));
    globalUngrouped.forEach((f) => ids.push(f.id));
    return ids;
  };

  const toggleSelect = (id: string) => {
    selectionAnchorRef.current = id;
    setSelectedFrames((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  /** Shift：从锚点到当前项的区间（按可见顺序，可跨编组）；替换原有选择 */
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

  /** 普通单击：只选中当前这张（清空其它），不打开画板 */
  const plainSelect = (id: string) => {
    selectionAnchorRef.current = id;
    setSelectedFrames(new Set([id]));
  };

  const togglePage = (key: string) =>
    setOpenPages((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const toggleFile = (id: string) =>
    setOpenFiles((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // ---------- 右键菜单：轻量编组入口（替代常驻工具条） ----------
  const ctxFrame = ctxMenu ? frames.find((f) => f.id === ctxMenu.frameId) : undefined;
  const ctxFileId = ctxFrame?.file_id ?? '';
  const ctxIds = () =>
    ctxMenu ? (selectedFrames.has(ctxMenu.frameId) ? [...selectedFrames] : [ctxMenu.frameId]) : [];
  const ctxSameFile = () =>
    !!ctxFrame && ctxIds().every((id) => frames.find((f) => f.id === id)?.file_id === ctxFrame.file_id);
  const openCtxMenu = (f: ProjectFrameRow, e: React.MouseEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    if (!selectedFrames.has(f.id)) plainSelect(f.id);
    setCtxMenu({ x: e.clientX, y: e.clientY, frameId: f.id });
  };
  const closeCtxMenu = () => setCtxMenu(null);

  const doExportZip = async () => {
    setZipBusy('presets');
    try {
      await api.exportZip({ fileId, frameId, mode: 'presets' });
    } catch (e) {
      fail(e);
    } finally {
      setZipBusy('');
    }
  };

  const onSelect = useCallback((id: string | null) => setSelectedId(id), []);
  const onHover = useCallback((id: string | null) => setHoverId(id), []);

  const onAddComment = useCallback(
    async (draft: { x: number; y: number; nodeId?: string }, body: string) => {
      await api.addComment(frameId, {
        author: authorRef.current.trim() || '匿名',
        body,
        nodeId: draft.nodeId,
        x: draft.x,
        y: draft.y,
      });
      refreshComments();
    },
    [frameId, refreshComments]
  );

  const onReply = useCallback(
    async (rootId: string, body: string) => {
      await api.replyComment(rootId, { author: authorRef.current.trim() || '匿名', body });
      refreshComments();
    },
    [refreshComments]
  );

  const onResolve = useCallback(
    async (id: string, resolved: boolean) => {
      await api.resolveComment(id, resolved);
      refreshComments();
    },
    [refreshComments]
  );

  const onDelete = useCallback(
    async (id: string) => {
      await api.deleteComment(id);
      refreshComments();
    },
    [refreshComments]
  );

  if (error) return <div className="page-msg">错误：{error} <Link to="/">返回首页</Link></div>;
  if (!data) return <div className="page-msg">加载中…</div>;

  const nodeById = new Map(data.nodes.map((n: LayerNode) => [n.node_id, n]));
  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;
  // 图层坐标：库里的 x/y 已归一为「相对画板左上角」，相对父级则再减去父级原点
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const parent = selected?.parent_id ? nodeById.get(selected.parent_id) : undefined;
  const selectedCoords = selected
    ? {
        absolute: { x: selected.x, y: selected.y },
        relative: parent
          ? { x: round2(selected.x - parent.x), y: round2(selected.y - parent.y) }
          : { x: selected.x, y: selected.y },
        parentName: parent?.name ?? null,
      }
    : null;

  // 页面（编组）内的画板列表：支持多选、拖拽排序、跨组移动
  const renderFrameList = (list: ProjectFrameRow[], showEmptyHint: boolean) => (
    <div className="page-frames" role={readOnly ? undefined : 'listbox'} aria-multiselectable={!readOnly}>
      {list.map((f) => (
        <div
          key={f.id}
          role={readOnly ? undefined : 'option'}
          aria-selected={readOnly ? undefined : selectedFrames.has(f.id)}
          className={`frame-item ${f.id === frameId ? 'is-current' : ''} ${
            selectedFrames.has(f.id) ? 'is-selected' : ''
          } ${dropFrameHint?.frameId === f.id ? 'is-drop-target' : ''}`}
          title={`${f.name}（双击打开，Ctrl/⌘ 点击多选，Shift 连选，右键编组）`}
          draggable={!readOnly}
          onClick={(e) => {
            if (readOnly) {
              // 查看器内切换画板用 replace：不往历史里堆画板详情，浏览器后退可回项目页
              navigate(`/files/${f.file_id}/frames/${f.id}`, { replace: true });
              return;
            }
            if (e.shiftKey) {
              selectRangeTo(f.id);
              return;
            }
            if (hasToggleModifier(e)) {
              toggleSelect(f.id);
              return;
            }
            // 普通单击只选中，不跳转；打开由双击触发
            plainSelect(f.id);
          }}
          onContextMenu={(e) => openCtxMenu(f, e)}
          onDoubleClick={(e) => {
            if (readOnly) return;
            // 修饰键点击、刚拖拽过都不算“双击打开”
            if (e.shiftKey || hasToggleModifier(e) || draggedRef.current) {
              e.preventDefault();
              return;
            }
            e.preventDefault();
            navigate(`/files/${f.file_id}/frames/${f.id}`, { replace: true });
          }}
          onDragStart={(e) => {
            draggedRef.current = true;
            setDragFrameId(f.id);
            setDropFrameHint(null);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', f.id);
          }}
          onDragEnd={() => {
            clearDrag();
            // 拖拽结束后短时间内屏蔽双击判定
            window.setTimeout(() => {
              draggedRef.current = false;
            }, 300);
          }}
          onDragOver={(e) => {
            if (readOnly || !dragFrameId) return;
            e.preventDefault();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
            if (dropFrameHint?.frameId !== f.id || dropFrameHint.position !== position) {
              setDropFrameHint({ frameId: f.id, position });
            }
            setDropPageId(null);
          }}
          onDragLeave={() => setDropFrameHint((h) => (h?.frameId === f.id ? null : h))}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const position = dropFrameHint?.frameId === f.id ? dropFrameHint.position : 'before';
            void dropOnFrame(f, position);
          }}
        >
          <span className="frame-item-name">{f.name}</span>
          {!readOnly && (
            <span className="frame-item-actions" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
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
      ))}
      {showEmptyHint && list.length === 0 && (
        <p className="dim small page-empty-hint">拖画板到这里即可移入未分组</p>
      )}
    </div>
  );

  // 返回：固定回当前项目的画板列表页，不走历史栈（历史里可能是一串画板详情）
  const goBack = () => {
    const projectId = file?.project_id;
    if (!projectId) {
      navigate('/', { replace: true });
      return;
    }
    navigate(`/projects/${projectId}`, { replace: true });
  };

  return (
    <div className="viewer">
      <header className="topbar">
        <button className="icon-btn" onClick={goBack} title="返回项目画板列表" aria-label="返回项目画板列表">
          <ArrowLeft />
        </button>
        <h1><Folder /> {file?.name ?? '…'}</h1>
        <span className="crumb">{data.frame.page_name} / {data.frame.name}</span>
        {readOnly && <span className="readonly-tag">协作者 · 只读</span>}
        <span className="spacer" />
        <button
          className="icon-btn mobile-only"
          onClick={() => setDrawer(drawer === 'left' ? 'none' : 'left')}
          title="页面列表"
          aria-label="页面列表"
        >
          <Menu />
        </button>
        <button
          className={`comment-toggle ${commentMode ? 'is-active' : ''}`}
          onClick={() => {
            setCommentMode((v) => !v);
            setDrawer('none');
          }}
          title="评论模式：点击画布或图层添加评论"
        >
          <MessageSquare /> 评论{comments.filter((c) => !c.parent_id && !c.resolved).length > 0 && (
            <span className="comment-badge">{comments.filter((c) => !c.parent_id && !c.resolved).length}</span>
          )}
        </button>
        <details className="export-menu">
          <summary className="primary-link"><Download /> 批量切图</summary>
          <div className="export-menu-pop">
            <button disabled={!!zipBusy} onClick={() => void doExportZip()}>
              {zipBusy ? '导出中…' : '按设计标记导出切图 zip'}
            </button>
            <p className="dim small">
              仅导出在 Figma 中标记了导出预设（Export）的图层，各自按标记的格式与倍数导出；打包 zip 下载（上限 600 项）。
              未标记图层仅可查看尺寸、坐标与文本属性。
            </p>
          </div>
        </details>
        <select
          className="device-select unit-select"
          value={unit}
          onChange={(e) => pickUnit(e.target.value as Unit)}
          title="切换尺寸单位：只改数值后缀，不改变画板尺寸或已存数据"
        >
          <option value="px">单位：px（Web）</option>
          <option value="pt">单位：pt（iOS）</option>
          <option value="dp">单位：dp（Android）</option>
        </select>
        <span className="dim zoom-label">{Math.round(zoom * 100)}%</span>
        <button
          className="icon-btn mobile-only"
          onClick={() => setDrawer(drawer === 'right' ? 'none' : 'right')}
          title="属性与切图"
        >
          <PanelRight />
        </button>
      </header>

      <div className="viewer-body">
        {drawer !== 'none' && (
          <div className="drawer-backdrop mobile-only" onClick={() => setDrawer('none')} />
        )}
        <aside className={`sidebar ${drawer === 'left' ? 'is-open' : ''}`}>
          <div className="sidebar-section sidebar-grow">
            <h3>
              画板
              <span className="sidebar-hspacer" />
              <span className="dim small">{frames.length} 个画板</span>
              {!readOnly && (
                <button
                  className="pcanvas-edit-btn sidebar-add-group"
                  title="新建空编组（建好后把画板拖进去）"
                  onClick={() => void addPage(fileId)}
                >
                  <Plus />
                </button>
              )}
            </h3>
            <div className="page-list">
              {flatGroups.map(({ pg, fileId: fid, fileName }) => {
                const list = pageFrames(fid, pg.id);
                const open = openPages.has(pg.id);
                const droppable = !readOnly && !!dragFrameId && draggingIdsFor(fid).length > 0;
                return (
                  <div key={pg.id} className="page-group">
                    <div
                      className={`page-row ${dropPageId === pg.id ? 'is-droptarget' : ''}`}
                      title={`${pg.name}（${list.length} 个画板）· 设计稿：${fileName}`}
                      onDragOver={(e) => {
                        if (droppable) {
                          e.preventDefault();
                          setDropPageId(pg.id);
                          setDropFrameHint(null);
                          if (!open) setOpenPages((s) => new Set(s).add(pg.id));
                        }
                      }}
                      onDragLeave={() => setDropPageId((v) => (v === pg.id ? null : v))}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (droppable) void dropOnPage(fid, pg.id);
                      }}
                    >
                      <button
                        type="button"
                        className="page-caret"
                        aria-label={open ? `折叠 ${pg.name}` : `展开 ${pg.name}`}
                        aria-expanded={open}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePage(pg.id);
                        }}
                      >
                        {open ? <ChevronDown /> : <ChevronRight />}
                      </button>
                      <span
                        className="page-name"
                        role="button"
                        tabIndex={0}
                        aria-expanded={open}
                        onClick={() => {
                          if (!readOnly && list.length) setSelectedFrames(new Set(list.map((f) => f.id)));
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            togglePage(pg.id);
                          }
                        }}
                      >
                        {pg.name}
                      </span>
                      <span className="page-count">{list.length}</span>
                      {!readOnly && (
                        <span className="page-actions" onClick={(e) => e.stopPropagation()}>
                          <RowMenu
                            label={`编组 ${pg.name}`}
                            items={[
                              { label: '重命名编组', onClick: () => void renamePage(pg) },
                              { label: '解散编组（保留画板）', onClick: () => void removePage(pg, 'dissolve') },
                              { label: '删除编组及内容', danger: true, onClick: () => void removePage(pg, 'content') },
                            ]}
                          />
                        </span>
                      )}
                    </div>
                    {open && renderFrameList(list, false)}
                  </div>
                );
              })}
              <div className="page-group page-group-unassigned is-global">
                <div
                  className={`page-row ${dropPageId === '__none:global' ? 'is-droptarget' : ''}`}
                  title="所有设计稿里未归入编组的画板"
                  onDragOver={(e) => {
                    if (!readOnly && dragFrameId) {
                      e.preventDefault();
                      setDropPageId('__none:global');
                      setDropFrameHint(null);
                      if (!openPages.has('__none:global')) setOpenPages((s) => new Set(s).add('__none:global'));
                    }
                  }}
                  onDragLeave={() => setDropPageId((v) => (v === '__none:global' ? null : v))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!readOnly && dragFrameId) void dropOutToUngrouped();
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
                    onClick={() => {
                      if (!readOnly && globalUngrouped.length) {
                        setSelectedFrames(new Set(globalUngrouped.map((f) => f.id)));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        togglePage('__none:global');
                      }
                    }}
                  >
                    未分组
                  </span>
                  <span className="page-count">{globalUngrouped.length}</span>
                </div>
                {openPages.has('__none:global') && renderFrameList(globalUngrouped, true)}
              </div>
            </div>
          </div>
        </aside>

        <Canvas
          frame={data.frame}
          nodes={data.nodes}
          selectedId={selectedId}
          hoverId={hoverId}
          onSelect={onSelect}
          onHover={onHover}
          onZoomChange={setZoom}
          unit={unit}
          comments={comments}
          commentMode={commentMode}
          onAddComment={onAddComment}
          onOpenComment={(id) => setActiveCommentId(id)}
        />

        {commentMode && (
          <CommentDrawer
            comments={comments}
            activeId={activeCommentId}
            author={author}
            nodeNames={new Map(data.nodes.map((n: LayerNode) => [n.node_id, n.name]))}
            onAuthorChange={setAuthor}
            onClose={() => setCommentMode(false)}
            onReply={onReply}
            onResolve={onResolve}
            onDelete={onDelete}
          />
        )}

        <aside className={`inspector ${drawer === 'right' ? 'is-open' : ''}`}>
          <PropertyPanel
            frame={data.frame}
            nodeCount={data.nodes.length}
            selected={selected}
            coords={selectedCoords}
            fileId={fileId}
            readOnly={readOnly}
            unit={unit}
            onNodeUpdated={() => {
              api.getFrame(fileId, frameId).then(setData).catch(() => undefined);
            }}
          />
        </aside>
      </div>
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
              top: Math.min(ctxMenu.y, window.innerHeight - 340),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ctx-title">已选 {ctxIds().length} 个画板</div>
            {!ctxSameFile() && <div className="ctx-hint">跨设计稿选择不能编组或移动，请取消后重选</div>}
            <button
              disabled={!ctxSameFile()}
              onClick={() => {
                closeCtxMenu();
                void createGroupFromSelection(ctxFileId);
              }}
            >
              新建编组…
            </button>
            {ctxFrame.page_id && (
              <button
                disabled={!ctxSameFile()}
                onClick={() => {
                  closeCtxMenu();
                  void moveSelection(ctxFileId, null);
                }}
              >
                移出编组
              </button>
            )}
            <div className="ctx-sep" />
            <div className="ctx-label">移入编组</div>
            {pagesOfFile(ctxFileId).filter((p) => p.id !== ctxFrame.page_id).length === 0 && (
              <div className="ctx-hint">该设计稿还没有其它编组</div>
            )}
            {pagesOfFile(ctxFileId)
              .filter((p) => p.id !== ctxFrame.page_id)
              .map((pg) => (
                <button
                  key={pg.id}
                  disabled={!ctxSameFile()}
                  onClick={() => {
                    closeCtxMenu();
                    void moveSelection(ctxFileId, pg.id);
                  }}
                >
                  {pg.name}
                </button>
              ))}
            <div className="ctx-sep" />
            <button
              onClick={() => {
                setSelectedFrames(new Set());
                closeCtxMenu();
              }}
            >
              取消选中
            </button>
          </div>
        </>
      )}
      {dialogs.element}
    </div>
  );
}
