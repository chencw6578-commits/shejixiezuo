import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { FileDetail, FrameRow } from '../types';

export default function FilePage() {
  const { fileId = '' } = useParams();
  const [file, setFile] = useState<FileDetail | null>(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const load = useCallback(() => {
    api
      .getFile(fileId)
      .then(setFile)
      .catch((e) => setError(e.message));
  }, [fileId]);

  useEffect(load, [load]);

  // 未就绪时轮询
  useEffect(() => {
    if (!file || file.status === 'ready' || file.status === 'failed') return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [file, load]);

  if (error) return <div className="page-msg">错误：{error} <Link to="/">返回</Link></div>;
  if (!file) return <div className="page-msg">加载中…</div>;

  const frames = file.frames ?? [];
  const loading = file.status === 'pending' || file.status === 'processing';

  return (
    <div className="file-page">
      <header className="topbar">
        <Link to="/" className="back">← 返回</Link>
        <h1>{file.name}</h1>
        <span className={`status ${file.status === 'ready' ? 'status-ok' : file.status === 'failed' ? 'status-err' : 'status-wait status-pulse'}`}>
          {file.status === 'ready' ? `共 ${frames.length} 个画板` : file.status === 'failed' ? '解析失败' : '解析中…'}
        </span>
        <span className="spacer" />
        {syncMsg && <span className={`small ${syncMsg.includes('已') && !syncMsg.includes('失败') ? 'ok' : 'dim'}`}>{syncMsg}</span>}
        <button
          className="ghost-btn"
          disabled={syncing || loading}
          onClick={async () => {
            setSyncing(true);
            setSyncMsg('');
            try {
              const r = await api.syncFile(fileId);
              setSyncMsg(r.updated ? '发现新版本，正在重新导入' : '已是最新版本');
            } catch (e) {
              setSyncMsg(`同步失败：${e instanceof Error ? e.message : e}`);
            } finally {
              setSyncing(false);
              load();
            }
          }}
        >
          {syncing ? '同步中…' : '重新同步'}
        </button>
        {file.status === 'ready' && frames.length > 0 && (
          <Link className="primary-link" to={`/files/${fileId}/spec`}>设计规范</Link>
        )}
        <button
          className="ghost-btn"
          onClick={async () => {
            if (confirm('删除该设计稿？')) {
              await api.deleteFile(fileId);
              location.href = '/';
            }
          }}
        >
          删除
        </button>
      </header>

      {file.error && <div className="page-msg err">{file.error}</div>}
      {loading && (
        <div className="page-msg">
          正在从 Figma 拉取文件并解析图层，画板越多耗时越久，可稍后刷新…
        </div>
      )}

      {!loading && frames.length === 0 && <div className="page-msg">该文件没有可展示的画板</div>}

      <div className="frame-grid">
        {frames.map((f: FrameRow) => (
          <Link key={f.id} className="frame-card" to={`/files/${fileId}/frames/${f.id}`}>
            <div className="frame-thumb">
              {f.thumb_url ? (
                <img src={f.thumb_url} alt={f.name} loading="lazy" />
              ) : (
                <span className="no-thumb">无预览</span>
              )}
            </div>
            <div className="frame-info">
              <span className="frame-name" title={f.name}>{f.name}</span>
              <span className="frame-size">{Math.round(f.width)} × {Math.round(f.height)}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
