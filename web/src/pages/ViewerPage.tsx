import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { FrameDetail, LayerNode } from '../types';
import Canvas from '../viewer/Canvas';
import LayerTree from '../viewer/LayerTree';
import PropertyPanel from '../viewer/PropertyPanel';

export default function ViewerPage() {
  const { fileId = '', frameId = '' } = useParams();
  const [file, setFile] = useState<{ name: string } | null>(null);
  const [data, setData] = useState<FrameDetail | null>(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    api.getFile(fileId).then((f) => setFile({ name: f.name })).catch((e) => setError(e.message));
  }, [fileId]);

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

  // 画板列表
  const [frames, setFrames] = useState<{ id: string; name: string; page_name: string | null }[]>([]);
  useEffect(() => {
    api.getFile(fileId).then((f) => setFrames(f.frames ?? [])).catch(() => undefined);
  }, [fileId]);

  const onSelect = useCallback((id: string | null) => setSelectedId(id), []);
  const onHover = useCallback((id: string | null) => setHoverId(id), []);

  if (error) return <div className="page-msg">错误：{error} <Link to="/">返回首页</Link></div>;
  if (!data) return <div className="page-msg">加载中…</div>;

  const nodeById = new Map(data.nodes.map((n: LayerNode) => [n.node_id, n]));
  const selected = selectedId ? nodeById.get(selectedId) ?? null : null;

  return (
    <div className="viewer">
      <header className="topbar">
        <Link to={`/files/${fileId}`} className="back">← 画板列表</Link>
        <h1>{file?.name ?? '…'}</h1>
        <span className="crumb">{data.frame.page_name} / {data.frame.name}</span>
        <span className="spacer" />
        <span className="dim">{Math.round(zoom * 100)}%</span>
      </header>

      <div className="viewer-body">
        <aside className="sidebar">
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
        />

        <aside className="inspector">
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
