import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { FileDetail, ProjectFrameRow } from '../types';

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

interface Placed {
  f: ProjectFrameRow;
  px: number;
  py: number;
}

export default function ProjectCanvasPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<{ id: string; name: string; team_id: string | null; team_name: string | null } | null>(null);
  const [frames, setFrames] = useState<ProjectFrameRow[]>([]);
  const [files, setFiles] = useState<FileDetail[]>([]);
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

  const setZoom = useCallback((z: number) => {
    zoomRef.current = clamp(z, MIN_ZOOM, MAX_ZOOM);
    setZoomState(zoomRef.current);
  }, []);

  const load = useCallback(() => {
    if (!projectId) return;
    api.getProject(projectId).then(setProject).catch((e) => setError(e.message));
    // 隧道偶发截断 JSON，解析失败会兜底为 {}，这里强制归一为数组避免 .map 崩溃
    api.listFiles(projectId).then((rows) => setFiles(Array.isArray(rows) ? rows : [])).catch(() => undefined);
    api
      .listProjectFrames(projectId)
      .then((rows) => setFrames(Array.isArray(rows) ? rows : []))
      .catch((e) => setError(e.message));
  }, [projectId]);

  useEffect(load, [load]);

  // 有解析中的稿子时 3 秒轮询，新画板自动出现在画布上
  useEffect(() => {
    const parsing = files.some((f) => f.status === 'pending' || f.status === 'processing');
    if (!parsing) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [files, load]);

  // 按设计稿分组平铺：每份稿子占一行，画板从左到右排列
  const layout = useMemo(() => {
    const placed: Placed[] = [];
    let x = 0;
    let y = 0;
    let rowH = 0;
    let currentFile: string | null = null;
    for (const f of frames) {
      if (f.file_id !== currentFile) {
        if (currentFile !== null) {
          y += rowH + GAP_Y;
          x = 0;
          rowH = 0;
        }
        currentFile = f.file_id;
      }
      placed.push({ f, px: x, py: y });
      x += f.width + GAP_X;
      rowH = Math.max(rowH, f.height);
    }
    return { placed, worldW: Math.max(x - GAP_X, 0), worldH: Math.max(y + rowH, 0) };
  }, [frames]);

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
        <Link to="/" className="back">← 返回首页</Link>
        <h1>📁 {project?.name ?? '…'}</h1>
        {project?.team_name && (
          <Link to={`/?team=${project.team_id}`} className="team-crumb">👥 {project.team_name}</Link>
        )}
        <span className="crumb">{frames.length} 个画板</span>
        {parsing > 0 && <span className="status status-wait status-pulse">解析中 {parsing}</span>}
        <span className="spacer" />
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
        <span className="dim zoom-label">{Math.round(zoom * 100)}%</span>
      </header>

      <div
        className={`canvas-container${spacePan ? ' space-pan' : ''}`}
        ref={containerRef}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          panRef.current = { x: e.clientX, y: e.clientY };
          dragMovedRef.current = false;
        }}
        onClick={(e) => {
          // 点击空白区域：不做任何事（预留），仅吞掉拖拽后的 click
          void e;
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
          >
            {layout.placed.map(({ f, px, py }) => (
              <div
                key={f.id}
                className="pcanvas-frame"
                style={{
                  left: px * zoom,
                  top: py * zoom,
                  width: f.width * zoom,
                  height: f.height * zoom,
                }}
                title={`${f.file_name} / ${f.name} · 点击打开画板详情`}
                onClick={() => {
                  // 拖拽平移或空格模式下松开鼠标，不进入画板详情
                  if (dragMovedRef.current || spaceRef.current) return;
                  navigate(`/files/${f.file_id}/frames/${f.id}`);
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
                  {f.file_name} / {f.name}
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
  );
}
