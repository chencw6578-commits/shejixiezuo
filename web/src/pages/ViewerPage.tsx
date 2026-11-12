import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
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
  CollapseAll,
  ChevronRight,
  Download,
  Folder,
  ImageIcon,
  MessageSquare,
  Plus,
  Sip,
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
  // 吸管取色：吸取设计稿任意像素的颜色（HEX 自动复制）
  const [eyedropper, setEyedropper] = useState(false);
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
        setSelectedFrameIds(new Set());
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
  // 侧栏画板多选：Ctrl/⌘ 点选、Shift 连选，用于右键「创建子编组」
  const [selectedFrameIds, setSelectedFrameIds] = useState<Set<string>>(new Set());
  const frameSelectionAnchorRef = useRef<string | null>(null);
  // 首轮加载才展开全部文件/编组，之后保留用户折叠状态
  const treeInitializedRef = useRef(false);
  const [dragFrameId, setDragFrameId] = useState<string | null>(null);
  const [dropPageId, setDropPageId] = useState<string | null>(null);
  const [dropFrameHint, setDropFrameHint] = useState<{ frameId: string; position: 'before' | 'after' } | null>(null);
  // 是否刚发生过拖拽：用于屏蔽拖拽结束后的双击打开
  const draggedRef = useRef(false);
  const [zipBusy, setZipBusy] = useState('');
  // 批量「全部图层」模式：自选格式与倍率（按设计标记模式仍用 Figma 里的预设）
  const [zipFormat, setZipFormat] = useState('PNG');
  const [zipScale, setZipScale] = useState('2');
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
    // 当前查看的画板所在编组及其所有祖先编组始终展开（子编组必须连父一起展开才可见）
    setOpenFiles((s) => new Set(s).add(f.id));
    const cur = treeFrames.find((x) => x.id === frameId);
    if (cur) {
      const byId = new Map(treePages.map((p) => [p.id, p]));
      const chain: string[] = [];
      let p = cur.page_id ? byId.get(cur.page_id) : undefined;
      while (p) {
        chain.push(p.id);
        p = p.parent_page_id ? byId.get(p.parent_page_id) : undefined;
      }
      if (!cur.page_id) chain.push(`__none:${cur.file_id}`);
      if (chain.length) setOpenPages((s) => new Set([...s, ...chain]));
    }
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
  /** 顶层编组（无父编组）；子编组由 renderGroup 递归挂在父编组展开区内 */
  const topGroups = useMemo(
    () => files.flatMap((fl) =>
      pagesOfFile(fl.id)
        .filter((pg) => !pg.parent_page_id)
        .map((pg) => ({ pg, fileId: fl.id, fileName: fl.name }))
    ),
    [files, pages]
  );
  /** 子编组：按 parent_page_id 取直接子级，保持 sort_order */
  const childPagesOf = (parentId: string): TreePage[] =>
    [...pages].filter((p) => p.parent_page_id === parentId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
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
  const draggingIds = () => (dragFrameId ? [dragFrameId] : []);
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

  /** 侧栏顶部「＋」：新建空编组（子编组改由选中画板后右键创建） */
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

  /** 从所选画板新建编组；parentPageId 有值时创建为该编组的子编组 */
  const createGroupFromSelection = async (fid: string, ids: string[], parentPageId: string | null = null) => {
    if (!ids.length) return;
    const parent = parentPageId ? pages.find((p) => p.id === parentPageId) : null;
    const name = await dialogs.prompt({
      title: parent ? `在「${parent.name}」下创建子编组（${ids.length} 个画板）` : `新建编组（${ids.length} 个画板）`,
      label: parent ? '子编组名称' : '编组名称',
      placeholder: '例如：登录流程',
      maxLength: 50,
      validate: (v) => validatePageName(fid, v),
    });
    if (!name) return;
    try {
      const pg = await api.createPage(fid, name, parentPageId);
      await api.moveFramesToPage(fid, ids, pg.id);
      await refreshPages();
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
      setSelectedFrameIds(new Set());
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
      await refreshPages();
      // 解散后画板去向：子编组 → 上一级编组（连带展开祖先，保证可见）；顶层编组 → 未分组
      if (mode === 'dissolve' && parentPg) {
        setOpenPages((s) => {
          const next = new Set(s).add(parentPg.id);
          let pid = parentPg.parent_page_id ?? null;
          while (pid) {
            next.add(pid);
            pid = pages.find((p) => p.id === pid)?.parent_page_id ?? null;
          }
          return next;
        });
      } else if (mode === 'dissolve') {
        setOpenPages((s) => new Set(s).add(filePageKey(pg.file_id, null)));
      }
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
      if (f.id === frameId) navigate(`/files/${f.file_id}`);
      await refreshPages();
    } catch (e) {
      fail(e);
    }
  };

  const moveSelection = async (fid: string, ids: string[], pageId: string | null) => {
    if (!ids.length) return;
    try {
      await api.moveFramesToPage(fid, ids, pageId);
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

  // ---------- 侧栏只跟随当前画板：不做 Ctrl/⌘ 多选与 Shift 连选 ----------
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

  // ---------- 右键菜单：支持侧栏多选（选中 2 个以上画板可创建子编组） ----------
  const ctxFrame = ctxMenu ? frames.find((f) => f.id === ctxMenu.frameId) : undefined;
  const ctxFileId = ctxFrame?.file_id ?? '';
  const ctxIds = () =>
    ctxMenu
      ? (selectedFrameIds.has(ctxMenu.frameId) ? [...selectedFrameIds] : [ctxMenu.frameId])
      : [];
  const ctxSameFile = () =>
    !!ctxFrame && ctxIds().every((id) => frames.find((f) => f.id === id)?.file_id === ctxFrame.file_id);
  const openCtxMenu = (f: ProjectFrameRow, e: React.MouseEvent) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    if (!selectedFrameIds.has(f.id)) {
      frameSelectionAnchorRef.current = f.id;
      setSelectedFrameIds(new Set([f.id]));
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, frameId: f.id });
  };
  const closeCtxMenu = () => setCtxMenu(null);

  const doExportZip = async (mode: 'presets' | 'all') => {
    setZipBusy(mode);
    try {
      await api.exportZip({
        fileId,
        frameId,
        mode,
        ...(mode === 'all' ? { format: zipFormat, scale: Number(zipScale) } : {}),
      });
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

  if (error) return <div className="page-msg">错误：{error} <Link to="/projects">返回项目列表</Link></div>;
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

  // 页面（编组）内的画板列表：单击打开画板，Ctrl/⌘ 点选 / Shift 连选可多选，用于右键创建子编组
  const renderFrameList = (list: ProjectFrameRow[], showEmptyHint: boolean) => (
    <div className="page-frames" role={readOnly ? undefined : 'listbox'} aria-multiselectable={!readOnly}>
      {list.map((f) => (
        <div
          key={f.id}
          data-frame-id={f.id}
          role={readOnly ? undefined : 'option'}
          aria-selected={readOnly ? undefined : selectedFrameIds.has(f.id) || f.id === frameId}
          className={`frame-item ${f.id === frameId ? 'is-current' : ''} ${
            selectedFrameIds.has(f.id) ? 'is-selected' : ''
          } ${dropFrameHint?.frameId === f.id ? 'is-drop-target' : ''}`}
          title={`${f.name}（单击打开，Ctrl/⌘ 或 Shift 多选，右键创建子编组）`}
          draggable={!readOnly}
          onClick={(e) => {
            // 查看器内切换画板用 replace：不往历史里堆画板详情，浏览器后退可回项目页
            if (draggedRef.current) return;
            if (!readOnly && (e.ctrlKey || e.metaKey || e.shiftKey)) {
              e.stopPropagation();
              const anchor = frameSelectionAnchorRef.current;
              const a = e.shiftKey && anchor ? list.findIndex((x) => x.id === anchor) : -1;
              const b = list.findIndex((x) => x.id === f.id);
              if (a >= 0 && b >= 0) {
                const [from, to] = a <= b ? [a, b] : [b, a];
                setSelectedFrameIds(new Set(list.slice(from, to + 1).map((x) => x.id)));
                return;
              }
              frameSelectionAnchorRef.current = f.id;
              setSelectedFrameIds((s) => {
                const n = new Set(s);
                if (n.has(f.id)) n.delete(f.id);
                else n.add(f.id);
                return n;
              });
              return;
            }
            setSelectedFrameIds(new Set());
            navigate(`/files/${f.file_id}/frames/${f.id}`, { replace: true });
          }}
          onContextMenu={(e) => openCtxMenu(f, e)}
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
          <ImageIcon className="frame-thumb-icon" size={14} />
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

  /**
   * 递归渲染编组树：一个编组展开后显示「子编组（可继续嵌套）→ 本组画板」。
   * 子编组改由选中 2 个以上画板后右键创建；与顶层编组共用同一套拖拽/重命名/删除逻辑。
   */
  const renderGroup = (pg: TreePage, fid: string, fileName: string, depth: number): ReactElement => {
    const list = pageFrames(fid, pg.id);
    const open = openPages.has(pg.id);
    const droppable = !readOnly && !!dragFrameId && draggingIdsFor(fid).length > 0;
    const children = childPagesOf(pg.id);
    return (
      <div key={pg.id} className="page-group" style={depth ? { marginLeft: depth * 14 } : undefined}>
        <div
          className={`page-row ${dropPageId === pg.id ? 'is-droptarget' : ''}`}
          title={`${pg.name}（${list.length} 个画板${children.length ? ` · ${children.length} 个子编组` : ''}）· 设计稿：${fileName}`}
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
            onClick={() => { togglePage(pg.id); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                togglePage(pg.id);
              }
            }}
          >
            <Folder className="page-group-icon" size={16} />
            {pg.name}
          </span>
          <span className="page-count">{list.length}</span>
          {!readOnly && (
            <span className="page-actions" onClick={(e) => e.stopPropagation()}>
              <RowMenu
                label={`编组 ${pg.name}`}
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
            {children.map((child) => renderGroup(child, fid, fileName, depth + 1))}
            {renderFrameList(list, false)}
          </>
        )}
      </div>
    );
  };

  // 返回：上一级是本项目画布页（/projects/:projectId）；缺失 project_id 时才退回团队项目列表
  const goBack = () => {
    if (file?.project_id) {
      navigate(`/projects/${file.project_id}`);
      return;
    }
    const teamId = file?.team_id;
    navigate(teamId ? `/projects?team=${teamId}` : '/projects', { replace: true });
  };

  return (
    <div className="viewer">
      <header className="topbar">
        <button className="icon-btn" onClick={goBack} title="返回画布" aria-label="返回画布">
          <ArrowLeft />
        </button>
        <h1><ImageIcon /> {data.frame.name}</h1>
        {readOnly && <span className="readonly-tag">协作者 · 只读</span>}
        <span className="spacer" />
        <button
          className={`icon-btn eyedropper-toggle ${eyedropper ? 'is-active' : ''}`}
          data-eyedropper-toggle
          onClick={() => setEyedropper((v) => !v)}
          title="吸管取色：点击画布吸取颜色，HEX 自动复制"
          aria-label="吸管取色"
        >
          <Sip />
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
          <summary><Download /> 批量切图</summary>
          <div className="export-menu-pop">
            <button disabled={!!zipBusy} onClick={() => void doExportZip('presets')}>
              {zipBusy === 'presets' ? '导出中…' : '按设计标记导出 zip'}
            </button>
            <div className="export-scale">
              <span>格式</span>
              <select value={zipFormat} onChange={(e) => setZipFormat(e.target.value)}>
                <option>PNG</option><option>SVG</option><option>JPG</option>
              </select>
            </div>
            <div className="export-scale">
              <span>倍率</span>
              <select value={zipScale} onChange={(e) => setZipScale(e.target.value)}>
                <option value="0.5">0.5x</option><option value="1">1x</option>
                <option value="2">2x</option><option value="3">3x</option><option value="4">4x</option>
              </select>
            </div>
            <button disabled={!!zipBusy} onClick={() => void doExportZip('all')}>
              {zipBusy === 'all' ? '导出中…' : '导出全部图层 zip'}
            </button>
            <p className="dim small">
              「按设计标记」按 Figma 里设置的格式与倍率逐个导出；「全部图层」按上方所选格式 / 倍率导出当前画板所有图层。
              两者均打包 zip 下载（上限 600 项）。服务端渲染，复杂图形 / 渐变可能失真。
            </p>
          </div>
        </details>
        <span className="unit-select-wrap">
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
          <ChevronDown />
        </span>
      </header>

      <div className="viewer-body">
        {drawer !== 'none' && (
          <div className="drawer-backdrop mobile-only" onClick={() => setDrawer('none')} />
        )}
        <aside className={`sidebar viewer-sidebar ${drawer === 'left' ? 'is-open' : ''}`}>
          <div className="sidebar-section sidebar-grow">
            {/* 与项目画布页同一结构：sidebar-head（标题左 + 收起/加号右），计数格式统一为「画板 · N」 */}
            <div className="sidebar-head">
              <h3>画板 · {frames.length}</h3>
              <button
                className="pcanvas-edit-btn sidebar-collapse-all"
                title="收起所有编组"
                aria-label="收起所有编组"
                onClick={() => setOpenPages(new Set())}
              >
                <CollapseAll />
              </button>
              {!readOnly && (
                <button
                  className="pcanvas-edit-btn sidebar-add-group"
                  title="新建空编组（建好后把画板拖进去）"
                  onClick={() => void addPage(fileId)}
                >
                  <Plus />
                </button>
              )}
            </div>
            <div className="page-list">
              {topGroups.map(({ pg, fileId: fid, fileName }) => renderGroup(pg, fid, fileName, 0))}
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
                    onClick={(e) => {
                      // 与画板页保持一致：只由文字自身切换一次，避免冒泡造成双重 toggle
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
          eyedropper={eyedropper}
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
              top: Math.min(ctxMenu.y, window.innerHeight - 380),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ctx-title">已选 {ctxIds().length} 个画板</div>
            {!ctxSameFile() && <div className="ctx-hint">跨设计稿选择不能编组或移动，请取消后重选</div>}
            <button
              disabled={!ctxSameFile()}
              onClick={() => {
                closeCtxMenu();
                void createGroupFromSelection(ctxFileId, ctxIds(), ctxFrame.page_id);
              }}
            >
              <Plus /> {ctxFrame.page_id
                ? `在「${pages.find((p) => p.id === ctxFrame.page_id)?.name ?? '编组'}」内新建子编组…`
                : '新建编组…'}
            </button>
            {ctxFrame.page_id && (
              <button
                disabled={!ctxSameFile()}
                onClick={() => {
                  closeCtxMenu();
                  void moveSelection(ctxFileId, ctxIds(), null);
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
                    void moveSelection(ctxFileId, ctxIds(), pg.id);
                  }}
                >
                  {pg.name}
                </button>
              ))}
            <div className="ctx-sep" />
            <button onClick={() => { setSelectedFrameIds(new Set()); closeCtxMenu(); }}>取消选中</button>
          </div>
        </>
      )}
      {dialogs.element}
    </div>
  );
}
