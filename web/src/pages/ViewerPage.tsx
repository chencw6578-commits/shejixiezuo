import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getIdentity, setActiveTeam, type CommentItem } from '../api';
import type { FrameDetail, FrameRow, LayerNode, PageRow } from '../types';
import Canvas from '../viewer/Canvas';
import { DeviceOptionGroups, findDevice, type DevicePreset } from '../viewer/devices';
import PropertyPanel from '../viewer/PropertyPanel';
import CommentDrawer from '../viewer/CommentDrawer';
import { useDialogs } from '../components/Dialogs';

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

  // Esc 取消选中
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [frames, setFrames] = useState<FrameRow[]>([]);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [openPages, setOpenPages] = useState<Set<string>>(new Set());
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
  useEffect(() => {
    api
      .getFile(fileId)
      .then((f) => {
        setFile({ name: f.name, project_id: f.project_id ?? null, team_id: f.team_id ?? null });
        setActiveTeam(f.team_id ?? null);
        setReadOnly(getIdentity(f.team_id ?? '')?.role === 'collaborator');
        setFrames(f.frames ?? []);
        setPages(f.pages ?? []);
        // 默认展开当前画板所在页面（未分组用 '__none' 占位）
        const cur = (f.frames ?? []).find((x) => x.id === frameId);
        setOpenPages(new Set([cur?.page_id ?? '__none']));
      })
      .catch((e) => setError(e.message));
  }, [fileId, frameId]);

  const refreshPages = useCallback(
    () =>
      api
        .getFile(fileId)
        .then((f) => {
          setFrames(f.frames ?? []);
          setPages(f.pages ?? []);
        })
        .catch(() => undefined),
    [fileId]
  );

  // ---------- 页面（编组）编辑：新建 / 重命名 / 删除 / 成员调整 ----------
  const fail = (e: unknown) => void dialogs.alert(e instanceof Error ? e.message : String(e));

  const sortFrames = (list: FrameRow[]) =>
    [...list].sort(
      (a, b) =>
        (a.page_sort ?? 0) - (b.page_sort ?? 0) ||
        a.sort_order - b.sort_order ||
        a.name.localeCompare(b.name)
    );
  const pageFrames = (pageId: string | null) =>
    sortFrames(frames.filter((f) => (f.page_id ?? null) === pageId));
  const draggingIds = () =>
    dragFrameId ? (selectedFrames.has(dragFrameId) ? [...selectedFrames] : [dragFrameId]) : [];
  const clearDrag = () => {
    setDragFrameId(null);
    setDropPageId(null);
    setDropFrameHint(null);
  };
  const validatePageName = (value: string, exceptId?: string) =>
    pages.some((p) => p.id !== exceptId && p.name === value) ? `已存在同名页面「${value}」` : null;

  const addPage = async () => {
    const name = await dialogs.prompt({
      title: '新建页面（编组）',
      label: '页面名称',
      placeholder: '例如：登录流程',
      maxLength: 50,
      validate: (v) => validatePageName(v),
    });
    if (!name) return;
    try {
      const pg = await api.createPage(fileId, name);
      await refreshPages();
      setOpenPages((s) => new Set(s).add(pg.id));
    } catch (e) {
      fail(e);
    }
  };

  const createGroupFromSelection = async () => {
    if (!selectedFrames.size) return;
    const name = await dialogs.prompt({
      title: `新建编组（${selectedFrames.size} 个画板）`,
      label: '页面名称',
      placeholder: '例如：登录流程',
      maxLength: 50,
      validate: (v) => validatePageName(v),
    });
    if (!name) return;
    try {
      const pg = await api.createPage(fileId, name);
      await api.moveFramesToPage(fileId, [...selectedFrames], pg.id);
      setSelectedFrames(new Set());
      await refreshPages();
      setOpenPages((s) => new Set(s).add(pg.id));
    } catch (e) {
      fail(e);
    }
  };

  const renamePage = async (pg: PageRow) => {
    const name = await dialogs.prompt({
      title: '重命名页面',
      label: '页面名称',
      initialValue: pg.name,
      maxLength: 50,
      validate: (v) => validatePageName(v, pg.id),
    });
    if (!name || name === pg.name) return;
    try {
      await api.renamePage(fileId, pg.id, name);
      await refreshPages();
    } catch (e) {
      fail(e);
    }
  };

  const removePage = async (pg: PageRow) => {
    const list = pageFrames(pg.id);
    const mode = await dialogs.choose({
      title: `删除页面「${pg.name}」`,
      message: `该页面（编组）内有 ${list.length} 个画板，请选择处理方式：`,
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
      await api.deletePage(fileId, pg.id, mode as 'dissolve' | 'content');
      setSelectedFrames((s) => {
        const ids = new Set(list.map((f) => f.id));
        return new Set([...s].filter((id) => !ids.has(id)));
      });
      await refreshPages();
      if (mode === 'content' && list.some((f) => f.id === frameId)) navigate(`/files/${fileId}`);
    } catch (e) {
      fail(e);
    }
  };

  const moveSelection = async (pageId: string | null) => {
    const ids = [...selectedFrames];
    if (!ids.length) return;
    try {
      await api.moveFramesToPage(fileId, ids, pageId);
      setSelectedFrames(new Set());
      if (pageId) setOpenPages((s) => new Set(s).add(pageId));
      await refreshPages();
    } catch (e) {
      fail(e);
    }
  };

  /** 拖到页面行：追加到该页面末尾（pageId=null 为未分组） */
  const dropOnPage = async (pageId: string | null) => {
    const ids = draggingIds();
    if (!ids.length) return;
    const rest = pageFrames(pageId).filter((f) => !ids.includes(f.id)).map((f) => f.id);
    try {
      await api.reorderFrames(fileId, pageId, [...rest, ...ids]);
      if (pageId) setOpenPages((s) => new Set(s).add(pageId));
      await refreshPages();
    } catch (e) {
      fail(e);
    }
    clearDrag();
  };

  /** 拖到画板行：在该画板前/后插入，跨组时一并移入目标组 */
  const dropOnFrame = async (target: FrameRow, position: 'before' | 'after') => {
    const ids = draggingIds();
    if (!ids.length || ids.includes(target.id)) {
      clearDrag();
      return;
    }
    const pageId = target.page_id ?? null;
    const rest = pageFrames(pageId).filter((f) => !ids.includes(f.id));
    const idx = rest.findIndex((f) => f.id === target.id);
    const at = idx < 0 ? rest.length : idx + (position === 'after' ? 1 : 0);
    const order = [...rest.slice(0, at).map((f) => f.id), ...ids, ...rest.slice(at).map((f) => f.id)];
    try {
      await api.reorderFrames(fileId, pageId, order);
      if (pageId) setOpenPages((s) => new Set(s).add(pageId));
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

  /** 侧栏当前“视觉顺序”里的画板 id：只算展开的编组，未分组排最后 */
  const visibleFrameIds = () => {
    const ids: string[] = [];
    for (const pg of pages) {
      if (!openPages.has(pg.id)) continue;
      pageFrames(pg.id).forEach((f) => ids.push(f.id));
    }
    if (openPages.has('__none')) pageFrames(null).forEach((f) => ids.push(f.id));
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
  const renderFrameList = (list: FrameRow[], showEmptyHint: boolean) => (
    <div className="page-frames">
      {list.map((f) => (
        <Link
          key={f.id}
          className={`frame-item ${f.id === frameId ? 'is-current' : ''} ${
            selectedFrames.has(f.id) ? 'is-selected' : ''
          } ${dropFrameHint?.frameId === f.id ? 'is-drop-target' : ''}`}
          to={`/files/${fileId}/frames/${f.id}`}
          title={`${f.name}（双击打开，Ctrl/⌘ 点击多选，Shift 连选）`}
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
          onDoubleClick={(e) => {
            if (readOnly) return;
            // 修饰键点击、刚拖拽过都不算“双击打开”
            if (e.shiftKey || hasToggleModifier(e) || draggedRef.current) {
              e.preventDefault();
              return;
            }
            e.preventDefault();
            navigate(`/files/${fileId}/frames/${f.id}`);
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
          {!readOnly && (
            <input
              type="checkbox"
              className="page-frame-check"
              checked={selectedFrames.has(f.id)}
              draggable={false}
              title="选中该画板，可用于批量编组"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleSelect(f.id);
              }}
              onDoubleClick={(e) => {
                // 双击复选框只做两次切换，不触发画板打开
                e.preventDefault();
                e.stopPropagation();
              }}
            />
          )}
          <span className="frame-item-name">{f.name}</span>
        </Link>
      ))}
      {showEmptyHint && list.length === 0 && (
        <p className="dim small page-empty-hint">拖画板到这里归入页面</p>
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
              页面
              <span className="sidebar-hspacer" />
              {!readOnly && (
                <button className="page-add-btn" title="新建页面" onClick={() => void addPage()}>
                  ＋
                </button>
              )}
            </h3>
            <div className="page-list">
              {!readOnly && (
                <div
                  className={`page-selection-bar${selectedFrames.size ? '' : ' is-empty'}`}
                  aria-hidden={selectedFrames.size === 0}
                >
                  <span className="selection-count">已选 {selectedFrames.size}</span>
                  <button onClick={() => void createGroupFromSelection()}>新建编组</button>
                  <select
                    value=""
                    title="把选中的画板移入页面（编组）"
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '__none') void moveSelection(null);
                      else if (v) void moveSelection(v);
                    }}
                  >
                    <option value="">移入页面…</option>
                    {pages.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                    <option value="__none">未分组</option>
                  </select>
                  <button onClick={() => setSelectedFrames(new Set())}>取消</button>
                </div>
              )}
              {pages.map((pg) => {
                const list = pageFrames(pg.id);
                const open = openPages.has(pg.id);
                const droppable = !readOnly && !!dragFrameId;
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
                        if (droppable) void dropOnPage(pg.id);
                      }}
                    >
                      <span className="page-caret">{open ? '▾' : '▸'}</span>
                      <span className="page-name" title={pg.name}>{pg.name}</span>
                      <span className="page-count">{list.length}</span>
                      {!readOnly && (
                        <span className="page-actions" onClick={(e) => e.stopPropagation()}>
                          <button title="重命名页面" onClick={() => void renamePage(pg)}>✏</button>
                          <button title="删除页面" onClick={() => void removePage(pg)}>🗑</button>
                        </span>
                      )}
                    </div>
                    {open && renderFrameList(list, true)}
                  </div>
                );
              })}
              {(() => {
                const list = pageFrames(null);
                if (list.length === 0) return null;
                const key = '__none';
                const open = openPages.has(key);
                const droppable = !readOnly && !!dragFrameId;
                return (
                  <div className="page-group page-group-unassigned">
                    <div
                      className={`page-row ${dropPageId === key ? 'is-droptarget' : ''}`}
                      onClick={() => togglePage(key)}
                      onDragOver={(e) => {
                        if (droppable) {
                          e.preventDefault();
                          setDropPageId(key);
                          setDropFrameHint(null);
                        }
                      }}
                      onDragLeave={() => setDropPageId((v) => (v === key ? null : v))}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (droppable) void dropOnPage(null);
                      }}
                    >
                      <span className="page-caret">{open ? '▾' : '▸'}</span>
                      <span className="page-name">未分组</span>
                      <span className="page-count">{list.length}</span>
                    </div>
                    {open && renderFrameList(list, false)}
                  </div>
                );
              })()}
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
      {dialogs.element}
    </div>
  );
}
