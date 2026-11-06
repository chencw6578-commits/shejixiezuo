import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';

interface Team {
  id: string;
  name: string;
  project_count: string;
  created_at?: string;
}

interface Project {
  id: string;
  name: string;
  file_count: string;
  last_file_at: string | null;
  created_at: string;
}

type View = 'projects' | 'teams';

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<View>('projects');
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
      await api.createTeam(teamName.trim());
      setTeamName('');
      loadTeams();
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

  // 团队卡片点击 → 切到项目视图并按该团队过滤
  const openTeam = (id: string) => {
    setActiveTeam(id);
    setView('projects');
  };

  const activeTeamName = teams.find((t) => t.id === activeTeam)?.name;

  return (
    <div className="home-shell">
      {/* 左侧边栏 */}
      <aside className="home-sidebar">
        <div className="home-brand">
          <span className="logo">◈</span>
          <div>
            <strong>设计协作</strong>
            <p>标注 · 切图 · 规范</p>
          </div>
        </div>
        <nav className="side-nav">
          <button
            className={`side-nav-item ${view === 'projects' ? 'active' : ''}`}
            onClick={() => setView('projects')}
          >
            📁 项目
          </button>
          <button
            className={`side-nav-item ${view === 'teams' ? 'active' : ''}`}
            onClick={() => setView('teams')}
          >
            👥 团队
          </button>
        </nav>
        <div className="side-foot">
          设计稿导入 · 画板预览<br />
          评论协作 · 代码片段<br />
          切图下载 · 设计规范
        </div>
      </aside>

      {/* 右侧内容区 */}
      <main className="home-main">
        <div className="home-main-inner">
          {view === 'projects' ? (
            <>
              <header className="view-header">
                <h1>项目{activeTeamName ? ` · ${activeTeamName}` : ''}</h1>
                <p>选择项目进入，查看设计稿、标注与规范</p>
              </header>

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
            </>
          ) : (
            <>
              <header className="view-header">
                <h1>团队</h1>
                <p>按团队组织项目，点击团队卡片查看其下的项目</p>
              </header>

              <form className="inline-form" onSubmit={createTeam}>
                <input
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="输入团队名称"
                  className="compact-input grow"
                />
                <button type="submit" disabled={busy || !teamName.trim()}>＋ 新建团队</button>
              </form>

              <ul className="team-grid">
                {teams.length === 0 && <p className="empty">暂无团队</p>}
                {teams.map((t) => (
                  <li key={t.id}>
                    <button className="file-card project-card team-card" onClick={() => openTeam(t.id)}>
                      <span className="file-name">👥 {t.name}</span>
                      <span className="file-meta">
                        {t.project_count} 个项目
                        {t.created_at ? ` · 创建于 ${new Date(t.created_at).toLocaleDateString('zh-CN')}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {error && <div className="home-error">{error}</div>}
        </div>
      </main>
    </div>
  );
}
