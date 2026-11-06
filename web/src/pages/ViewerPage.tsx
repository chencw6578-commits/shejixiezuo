import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type CommentItem } from '../api';
import type { FrameDetail, LayerNode } from '../types';
import Canvas from '../viewer/Canvas';
import LayerTree from '../viewer/LayerTree';
import PropertyPanel from '../viewer/PropertyPanel';
import CommentDrawer from '../viewer/CommentDrawer';

export default function ViewerPage() {
  const { fileId = '', frameId = '' } = useParams();
  const [file, setFile] = useState<{ name: string; project_id: string | null } | null>(null);
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

  const [frames, setFrames] = useState<{ id: string; name: string; page_name: string | null }[]>([]);
  const [zipBusy, setZipBusy] = useState('');
  useEffect(() => {
    api
      .getFile(fileId)
      .then((f) => {
        setFile({ name: f.name, project_id: f.project_id ?? null });
        setFrames(f.frames ?? []);
      })
      .catch((e) => setError(e.message));
  }, [fileId]);

  const doExportZip = async (mode: 'presets' | 'all') => {
    setZipBusy(mode);
    try {
      await api.exportZip({ fileId, frameId, mode, format: 'PNG', scale: 2 });
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
            <button disabled={!!zipBusy} onClick={() => doExportZip('presets')}>
              {zipBusy === 'presets' ? '导出中…' : '按设计标记的导出预设'}
            </button>
            <button disabled={!!zipBusy} onClick={() => doExportZip('all')}>
              {zipBusy === 'all' ? '导出中…' : '全部图层 PNG @2x'}
            </button>
            <p className="dim small">打包为 zip 下载（上限 600 项）</p>
          </div>
        </details>
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
            <h3>画板</h3>
            <div className="frame-list">
              {frames.map((f) => (
                <Link
                  key={f.id}
                  className={`frame-item ${f.id === frameId ? 'is-current' : ''}`}
                  to={`/files/${fileId}/frames/${f.id}`}
                  title={f.name}
                >
                  {f.name}
                </Link>
              ))}
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
          />
        </aside>
      </div>
    </div>
  );
}
