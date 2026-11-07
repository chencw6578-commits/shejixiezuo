import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, getIdentity, setActiveTeam, type CommentItem } from '../api';
import type { FrameDetail, FrameRow, LayerNode, PageRow } from '../types';
import Canvas from '../viewer/Canvas';
import { DeviceOptionGroups, findDevice, type DevicePreset } from '../viewer/devices';
import LayerTree from '../viewer/LayerTree';
import PropertyPanel from '../viewer/PropertyPanel';
import CommentDrawer from '../viewer/CommentDrawer';

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
  const [zipBusy, setZipBusy] = useState('');
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

  const addPage = async () => {
    const name = window.prompt('新页面名称');
    if (!name?.trim()) return;
    try {
      const pg = await api.createPage(fileId, name.trim());
      await refreshPages();
      setOpenPages((s) => new Set(s).add(pg.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const renamePage = async (pg: PageRow) => {
    const name = window.prompt('重命名页面', pg.name);
    if (!name?.trim() || name.trim() === pg.name) return;
    try {
      await api.renamePage(fileId, pg.id, name.trim());
      await refreshPages();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const removePage = async (pg: PageRow) => {
    if (!window.confirm(`删除页面「${pg.name}」？其中的画板将变为未分组。`)) return;
    try {
      await api.deletePage(fileId, pg.id);
      await refreshPages();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  const moveFrame = async (fid: string, pageId: string | null) => {
    try {
      await api.moveFrameToPage(fileId, fid, pageId);
      await refreshPages();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
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
      alert(e instanceof Error ? e.message : String(e));
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

  return (
    <div className="viewer">
      <header className="topbar">
        <button
          className="icon-btn mobile-only"
          onClick={() => setDrawer(drawer === 'left' ? 'none' : 'left')}
          title="画板与图层"
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
          <div className="sidebar-section">
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
              {pages.map((pg) => {
                const list = frames.filter((f) => f.page_id === pg.id);
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
                        }
                      }}
                      onDragLeave={() => setDropPageId((v) => (v === pg.id ? null : v))}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDropPageId(null);
                        if (droppable && dragFrameId) void moveFrame(dragFrameId, pg.id);
                        setDragFrameId(null);
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
                    {open && (
                      <div className="page-frames">
                        {list.map((f) => (
                          <Link
                            key={f.id}
                            className={`frame-item ${f.id === frameId ? 'is-current' : ''}`}
                            to={`/files/${fileId}/frames/${f.id}`}
                            title={f.name}
                            draggable={!readOnly}
                            onDragStart={() => setDragFrameId(f.id)}
                            onDragEnd={() => setDragFrameId(null)}
                          >
                            {f.name}
                          </Link>
                        ))}
                        {list.length === 0 && (
                          <p className="dim small page-empty-hint">拖画板到这里归入页面</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {(() => {
                const list = frames.filter((f) => !f.page_id);
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
                        }
                      }}
                      onDragLeave={() => setDropPageId((v) => (v === key ? null : v))}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDropPageId(null);
                        if (droppable && dragFrameId) void moveFrame(dragFrameId, null);
                        setDragFrameId(null);
                      }}
                    >
                      <span className="page-caret">{open ? '▾' : '▸'}</span>
                      <span className="page-name">未分组</span>
                      <span className="page-count">{list.length}</span>
                    </div>
                    {open && (
                      <div className="page-frames">
                        {list.map((f) => (
                          <Link
                            key={f.id}
                            className={`frame-item ${f.id === frameId ? 'is-current' : ''}`}
                            to={`/files/${fileId}/frames/${f.id}`}
                            title={f.name}
                            draggable={!readOnly}
                            onDragStart={() => setDragFrameId(f.id)}
                            onDragEnd={() => setDragFrameId(null)}
                          >
                            {f.name}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
          <div className="sidebar-section sidebar-grow">
            <h3>图层层树</h3>
            <LayerTree
              nodes={data.nodes}
              frameNodeId={data.frame.node_id}
              selectedId={selectedId}
              hoverId={hoverId}
              onSelect={onSelect}
              onHover={onHover}
            />
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
            fileId={fileId}
            readOnly={readOnly}
          />
        </aside>
      </div>
    </div>
  );
}
