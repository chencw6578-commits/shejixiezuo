import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';

interface Team {
  id: string;
  name: string;
  project_count: string;
}

interface Project {
  id: string;
  name: string;
  file_count: string;
  last_file_at: string | null;
  created_at: string;
}

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const [teams, setTeams] = useState<Team[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeTeam, setActiveTeam] = useState<string>(searchParams.get('team') ?? ''); // '' = 全部
  const [teamName, setTeamName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const loadTeams = useCallback(() => {
    api.listTeams().then(setTeams).catch((e) => setError(e.message));
  }, []);

  const loadProjects = useCallback(() => {
    api.listProjects(activeTeam || undefined).then(setProjects).catch((e) => setError(e.message));
  }, [activeTeam]);

  useEffect(loadTeams, [loadTeams]);
  useEffect(loadProjects, [loadProjects]);

  const createTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const t = await api.createTeam(teamName.trim());
      setTeamName('');
      loadTeams();
      setActiveTeam(t.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectName.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const p = await api.createProject(projectName.trim(), activeTeam || undefined);
      setProjectName('');
      navigate(`/projects/${p.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const activeTeamName = teams.find((t) => t.id === activeTeam)?.name;

  return (
    <div className="home">
      <header className="home-header">
        <span className="logo">◈</span>
        <h1>设计协作</h1>
        <p>团队 → 项目 → 设计稿 · 查看规范 / 评论协作 / 下载切图</p>
      </header>

      {/* 团队 */}
      <section className="section-block">
        <h2>团队</h2>
        <div className="team-row">
          <button
            className={`team-chip ${activeTeam === '' ? 'active' : ''}`}
            onClick={() => setActiveTeam('')}
          >
            全部
          </button>
          {teams.map((t) => (
            <button
              key={t.id}
              className={`team-chip ${activeTeam === t.id ? 'active' : ''}`}
              onClick={() => setActiveTeam(t.id)}
            >
              👥 {t.name}
              <em>{t.project_count}</em>
            </button>
          ))}
        </div>
        <form className="inline-form" onSubmit={createTeam}>
          <input
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            placeholder="输入团队名称"
            className="compact-input"
          />
          <button type="submit" disabled={busy || !teamName.trim()}>＋ 新建团队</button>
        </form>
      </section>

      {/* 项目 */}
      <section className="section-block">
        <h2>项目{activeTeamName ? ` · ${activeTeamName}` : ''}</h2>
        <form className="inline-form" onSubmit={createProject}>
          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder={activeTeamName ? `在「${activeTeamName}」中新建项目` : '输入项目名称（可先选择团队）'}
            className="compact-input grow"
          />
          <button type="submit" disabled={busy || !projectName.trim()}>＋ 新建项目</button>
        </form>

        <ul className="project-grid">
          {projects.length === 0 && <p className="empty">暂无项目</p>}
          {projects.map((p) => (
            <li key={p.id}>
              <button className="file-card project-card" onClick={() => navigate(`/projects/${p.id}`)}>
                <span className="file-name">📁 {p.name}</span>
                <span className="file-meta">
                  {p.file_count} 份设计稿 · 最后更新{' '}
                  {p.last_file_at
                    ? new Date(p.last_file_at).toLocaleString('zh-CN')
                    : new Date(p.created_at).toLocaleString('zh-CN')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {error && <div className="home-error">{error}</div>}
    </div>
  );
}
