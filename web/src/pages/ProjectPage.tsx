import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { FileDetail } from '../types';

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending: { text: '排队中', cls: 'status-wait' },
  processing: { text: '解析中', cls: 'status-wait' },
  ready: { text: '就绪', cls: 'status-ok' },
  failed: { text: '失败', cls: 'status-err' },
};

const SOURCE_TAG: Record<string, string> = {
  sketch: 'Sketch',
  psd: 'PSD',
  figma: 'Figma',
};

export default function ProjectPage() {
  const { projectId } = useParams();
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  const [url, setUrl] = useState('');
  const [files, setFiles] = useState<FileDetail[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then(setProject).catch((e) => setError(e.message));
    const load = () => api.listFiles(projectId).then(setFiles).catch((e) => setError(e.message));
    load();
    // 有解析中的稿子时轮询刷新
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [projectId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy || !projectId) return;
    setBusy(true);
    setError('');
    try {
      const { id } = await api.importFile(url.trim(), projectId);
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
      navigate(`/files/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading('');
    }
  };

  return (
    <div className="home">
      <header className="home-header">
        <Link to="/" className="back">← 返回项目列表</Link>
        <h1>📁 {project?.name ?? '…'}</h1>
        <p>在这个项目里导入 Figma 链接或上传 Sketch / PSD 设计稿</p>
      </header>

      <form className="import-box" onSubmit={submit}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.figma.com/design/xxxxx/文件名"
          autoFocus
        />
        <button type="submit" disabled={busy || !url.trim()}>
          {busy ? '导入中…' : '导入'}
        </button>
      </form>
      {error && <div className="home-error">{error}</div>}

      <div className="upload-box">
        <input ref={fileInputRef} type="file" accept=".sketch,.psd" hidden onChange={onUpload} />
        <button className="upload-btn" disabled={!!uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading || '⬆ 上传 Sketch / PSD 文件（无需插件，服务端直接解析）'}
        </button>
      </div>

      <section className="file-list">
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
                    {f.frame_count ?? 0} 个画板 · {new Date(f.created_at).toLocaleString('zh-CN')}
                  </span>
                </Link>
                <span className={`status ${st.cls} ${f.status === 'processing' || f.status === 'pending' ? 'status-pulse' : ''}`}>
                  {st.text}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
