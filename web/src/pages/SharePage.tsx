import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type SharedFrame, type SharedProject } from '../api';
import { Folder, Share2, X } from '../components/icons';

/**
 * 公开只读分享页（/share/:token）。
 * 这一页故意不套登录守卫、不调用 /api/auth/me、不读取本地身份：
 * 拿到链接的人（含未登录、无 cookie 的浏览器）都能直接查看项目画板。
 * 页面只展示项目名与画板缩略图/尺寸，没有任何编辑、评论、导出入口。
 */
export default function SharePage() {
  const { token = '' } = useParams();
  const [data, setData] = useState<SharedProject | null>(null);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<SharedFrame | null>(null);

  useEffect(() => {
    let alive = true;
    if (!token) {
      setError('分享链接不完整');
      return;
    }
    api
      .getSharedProject(token)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : '分享链接无法打开');
      });
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActive(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  const markFailed = (id: string) => setFailed((prev) => new Set(prev).add(id));
  const imgOk = (f: SharedFrame) => !!f.thumb_url && !failed.has(f.id);

  return (
    <div className="share-page">
      <header className="topbar share-topbar">
        <h1><Folder /> {data?.project.name ?? '项目分享'}</h1>
        <span className="share-badge"><Share2 /> 只读分享 · 无需登录</span>
        <span className="spacer" />
        {data && <span className="crumb">{data.frames.length} 个画板</span>}
      </header>

      <main className="share-stage">
        {error && (
          <div className="share-state">
            <h2>链接已失效</h2>
            <p>{error}</p>
            <p className="dim">请向项目成员索取新的分享链接。</p>
          </div>
        )}
        {!error && !data && <div className="share-state">加载中…</div>}
        {data && data.frames.length === 0 && (
          <div className="share-state">
            <h2>暂无画板</h2>
            <p className="dim">该项目还没有可查看的设计稿。</p>
          </div>
        )}
        {data && data.frames.length > 0 && (
          <div className="share-canvas">
            <div className="share-board-row">
              {data.frames.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="share-board"
                  style={{ aspectRatio: `${f.width} / ${f.height}` }}
                  title={f.name}
                  onClick={() => setActive(f)}
                >
                  {imgOk(f) ? (
                    <img src={f.thumb_url!} alt={f.name} loading="lazy" onError={() => markFailed(f.id)} />
                  ) : (
                    <span className="share-board-fallback">{f.name}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      {active && (
        <div className="share-lightbox" role="dialog" aria-modal="true" onClick={() => setActive(null)}>
          <div className="share-lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <div className="share-lightbox-head">
              <div className="share-lightbox-title">
                <strong>{active.name}</strong>
                <span className="dim"> {active.file_name} · {Math.round(active.width)}×{Math.round(active.height)}</span>
              </div>
              <button type="button" className="icon-btn" onClick={() => setActive(null)} aria-label="关闭预览" title="关闭预览">
                <X />
              </button>
            </div>
            <div className="share-lightbox-body">
              {imgOk(active) ? (
                <img src={active.thumb_url!} alt={active.name} onError={() => markFailed(active.id)} />
              ) : (
                <div className="share-lightbox-fallback">
                  <p>{active.name}</p>
                  <p className="dim">{Math.round(active.width)} × {Math.round(active.height)} · 缩略图暂不可用</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
