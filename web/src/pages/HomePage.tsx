import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function HomePage() {
  const [projects, setProjects] = useState<{ id: string; name: string; file_count: string; created_at: string; last_file_at: string | null }[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const load = () => {
    api.listProjects().then(setProjects).catch((e) => setError(e.message));
  };

  useEffect(load, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const p = await api.createProject(name.trim());
      setName('');
      navigate(`/projects/${p.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <header className="home-header">
        <span className="logo">◈</span>
        <h1>设计协作</h1>
        <p>创建项目 → 导入设计稿 → 查看规范 / 评论协作 / 下载切图</p>
      </header>

      <form className="import-box" onSubmit={create}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="输入项目名称，如「某某 App 3.0」"
          autoFocus
        />
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? '创建中…' : '＋ 创建项目'}
        </button>
      </form>
      {error && <div className="home-error">{error}</div>}

      <section className="file-list">
        <h2>我的项目</h2>
        {projects.length === 0 && <p className="empty">还没有项目，先创建一个吧</p>}
        <ul>
          {projects.map((p) => (
            <li key={p.id}>
              <button className="file-card" onClick={() => navigate(`/projects/${p.id}`)} style={{ textAlign: 'left', border: 'none', background: 'transparent' }}>
                <span className="file-name">📁 {p.name}</span>
                <span className="file-meta">
                  {p.file_count} 份设计稿 · 最后更新 {p.last_file_at ? new Date(p.last_file_at).toLocaleString('zh-CN') : new Date(p.created_at).toLocaleString('zh-CN')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
