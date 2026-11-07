import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getIdentity, setActiveTeam, type CommentItem } from '../api';
import type { FileDetail, FrameDetail, LayerNode, ProjectFrameRow, ProjectPageRow } from '../types';
import Canvas from '../viewer/Canvas';
import { DeviceOptionGroups, findDevice, type DevicePreset } from '../viewer/devices';
import PropertyPanel from '../viewer/PropertyPanel';
import CommentDrawer from '../viewer/CommentDrawer';
import { useDialogs } from '../components/Dialogs';

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
  // 设备预览（iOS / Android / Web 尺寸规范），记住上次选择
  const [device, setDevice] = useState<DevicePreset | null>(() => {
    try {
      const id = (JSON.parse(localStorage.getItem('designhub-device') ?? 'null') as { id?: string } | null)?.id;
      return id ? findDevice(id) : null;
    } catch {
      return null;
    }
  });
  const pickDevice = (id: string) => {
    const d = id ? findDevice(id) : null;
    setDevice(d);
    if (d) localStorage.setItem('designhub-device', JSON.stringify({ id: d.id }));
    else localStorage.removeItem('designhub-device');
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

  const removePage = async (pg: TreePage) => {
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
      await refreshPages();
      // 解散后画板回到未分组：展开该段，避免看起来“画板消失”
      setOpenPages((s) => new Set(s).add(filePageKey(pg.file_id, null)));
      if (mode === 'content' && list.some((f) => f.id === frameId)) navigate(`/files/${pg.file_id}`);
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

  /** 拖到编组行/设计稿未分组行：追加到该组末尾（只处理同设计稿的画板） */
  const dropOnPage = async (fid: string, pageId: string | null) => {
    const ids = draggingIdsFor(fid);
    if (!ids.length) {
      clearDrag();
      return;
    }
    const rest = pageFrames(fid, pageId).filter((f) => !ids.includes(f.id)).map((f) => f.id);
    try {
      await api.reorderFrames(fid, pageId, [...rest, ...ids]);
      setOpenPages((s) => new Set(s).add(filePageKey(fid, pageId)));
      await refreshPages();
    } catch (e) {
      fail(e);
    }
    clearDrag();
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
    try {
      await api.reorderFrames(fid, pageId, order);
      setOpenPages((s) => new Set(s).add(filePageKey(fid, pageId)));
      await refreshPages();
    } catch (e) {
      fail(e);
    }
    clearDrag();
  };

  // ---------- 侧栏多选：Ctrl/⌘ 切换、Shift 连选、普通点击单选 ----------
  // macOS 上 Ctrl+点击 = 右键，所以 mac 只认 ⌘
  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  const hasToggleModifier = (e: { ctrlKey: boolean; metaKey: boolean }) =>
    isMac ? e.metaKey : e.ctrlKey || e.metaKey;

  /** 左侧整棵树的视觉顺序（设计稿 → 编组 → 未分组），Shift 连选按此顺序，可跨设计稿 */
  const visibleFrameIds = () => {
    const ids: string[] = [];
    for (const fl of files) {
      for (const pg of pagesOfFile(fl.id)) pageFrames(fl.id, pg.id).forEach((f) => ids.push(f.id));
      ungroupedOf(fl.id).forEach((f) => ids.push(f.id));
    }
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
        <Link
          key={f.id}
          role={readOnly ? undefined : 'option'}
          aria-selected={readOnly ? undefined : selectedFrames.has(f.id)}
          className={`frame-item ${f.id === frameId ? 'is-current' : ''} ${
            selectedFrames.has(f.id) ? 'is-selected' : ''
          } ${dropFrameHint?.frameId === f.id ? 'is-drop-target' : ''}`}
          to={`/files/${f.file_id}/frames/${f.id}`}
          title={`${f.name}（双击打开，Ctrl/⌘ 点击多选，Shift 连选，右键编组）`}
          draggable={!readOnly}
          onClick={(e) => {
            if (readOnly) return; // 只读：保持原来的单击直接打开
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
            // 普通单击只选中，不跳转；打开由双击触发
            e.preventDefault();
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
            navigate(`/files/${f.file_id}/frames/${f.id}`);
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
        </Link>
      ))}
      {showEmptyHint && list.length === 0 && (
        <p className="dim small page-empty-hint">拖画板到这里即可移入未分组</p>
      )}
    </div>
  );

  return (
    <div className="viewer">
      <header className="topbar">
        <button
          className="icon-btn mobile-only"
          onClick={() => setDrawer(drawer === 'left' ? 'none' : 'left')}
          title="页面列表"
        >
          ☰
        </button>
        <Link to={file?.project_id ? `/projects/${file.project_id}` : '/'} className="back">← 返回画板</Link>
        <h1>{file?.name ?? '…'}</h1>
        <span className="crumb">{data.frame.page_name} / {data.frame.name}</span>
        {readOnly && <span className="readonly-tag">协作者 · 只读</span>}
        <span className="spacer" />
        <button
          className={`comment-toggle ${commentMode ? 'is-active' : ''}`}
          onClick={() => {
            setCommentMode((v) => !v);
            setDrawer('none');
          }}
          title="评论模式：点击画布或图层添加评论"
        >
          💬 评论{comments.filter((c) => !c.parent_id && !c.resolved).length > 0 && (
            <span className="comment-badge">{comments.filter((c) => !c.parent_id && !c.resolved).length}</span>
          )}
        </button>
        <details className="export-menu">
          <summary className="primary-link">批量切图</summary>
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
          className="device-select"
          value={device?.id ?? ''}
          onChange={(e) => pickDevice(e.target.value)}
          title="设备预览：设计稿按所选设备的尺寸规范显示（屏框内为第一屏可视区）"
        >
          <option value="">设备预览：跟随设计</option>
          {DeviceOptionGroups()}
        </select>
        <span className="dim zoom-label">{Math.round(zoom * 100)}%</span>
        <button
          className="icon-btn mobile-only"
          onClick={() => setDrawer(drawer === 'right' ? 'none' : 'right')}
          title="属性与切图"
        >
          ◧
        </button>
      </header>

      <div className="viewer-body">
        {drawer !== 'none' && (
          <div className="drawer-backdrop mobile-only" onClick={() => setDrawer('none')} />
        )}
        <aside className={`sidebar ${drawer === 'left' ? 'is-open' : ''}`}>
          <div className="sidebar-section sidebar-grow">
            <h3>
              设计稿
              <span className="sidebar-hspacer" />
              <span className="dim small">{frames.length} 个画板</span>
            </h3>
            <div className="page-list">
              {files.map((fl) => {
                const fileOpen = openFiles.has(fl.id);
                const filePages = pagesOfFile(fl.id);
                const ungrouped = ungroupedOf(fl.id);
                const nameKey = `__none:${fl.id}`;
                const droppable = !readOnly && !!dragFrameId && draggingIdsFor(fl.id).length > 0;
                return (
                  <div key={fl.id} className={`file-group ${fl.id === fileId ? 'is-current-file' : ''}`}>
                    <div
                      className="file-row"
                      title={fl.name}
                      onClick={() => toggleFile(fl.id)}
                    >
                      <span className="page-caret">{fileOpen ? '▾' : '▸'}</span>
                      <span className="file-name">{fl.name}</span>
                      <span className="page-count">{framesOfFile(fl.id).length}</span>
                      {!readOnly && (
                        <span className="page-actions" onClick={(e) => e.stopPropagation()}>
                          <button title={`在「${fl.name}」新建空编组`} onClick={() => void addPage(fl.id)}>
                            ＋
                          </button>
                        </span>
                      )}
                    </div>
                    {fileOpen && (
                      <div className="file-children">
                        {filePages.map((pg) => {
                          const list = pageFrames(fl.id, pg.id);
                          const open = openPages.has(pg.id);
                          return (
                            <div key={pg.id} className="page-group">
                              <div
                                className={`page-row ${dropPageId === pg.id ? 'is-droptarget' : ''}`}
                                onClick={() => togglePage(pg.id)}
                                onDragOver={(e) => {
                                  if (droppable) {
                                    e.preventDefault();
                                    setDropPageId(pg.id);
                                    setDropFrameHint(null);
                                  }
                                }}
                                onDragLeave={() => setDropPageId((v) => (v === pg.id ? null : v))}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  if (droppable) void dropOnPage(fl.id, pg.id);
                                }}
                              >
                                <span className="page-caret">{open ? '▾' : '▸'}</span>
                                <span className="page-name" title={pg.name}>{pg.name}</span>
                                <span className="page-count">{list.length}</span>
                                {!readOnly && (
                                  <span className="page-actions" onClick={(e) => e.stopPropagation()}>
                                    <button title="重命名编组" onClick={() => void renamePage(pg)}>✏</button>
                                    <button title="删除编组" onClick={() => void removePage(pg)}>🗑</button>
                                  </span>
                                )}
                              </div>
                              {open && renderFrameList(list, false)}
                            </div>
                          );
                        })}
                        <div className="page-group page-group-unassigned">
                          <div
                            className={`page-row ${dropPageId === nameKey ? 'is-droptarget' : ''}`}
                            onClick={() => togglePage(nameKey)}
                            onDragOver={(e) => {
                              if (droppable) {
                                e.preventDefault();
                                setDropPageId(nameKey);
                                setDropFrameHint(null);
                              }
                            }}
                            onDragLeave={() => setDropPageId((v) => (v === nameKey ? null : v))}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (droppable) void dropOnPage(fl.id, null);
                            }}
                          >
                            <span className="page-caret">{openPages.has(nameKey) ? '▾' : '▸'}</span>
                            <span className="page-name">未分组</span>
                            <span className="page-count">{ungrouped.length}</span>
                          </div>
                          {openPages.has(nameKey) && renderFrameList(ungrouped, true)}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
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
          device={device}
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
