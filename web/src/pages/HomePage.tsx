import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';

interface Team {
  id: string;
  name: string;
  project_count: string;
  created_at?: string;
}

interface Member {
  id: string;
  team_id: string;
  name: string;
  created_at: string;
}

interface Project {
  id: string;
  name: string;
  file_count: string;
  last_file_at: string | null;
  created_at: string;
}

type View = 'projects' | 'members';

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<View>('projects');
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeTeam, setActiveTeam] = useState<string>(searchParams.get('team') ?? ''); // '' = 全部
  const [teamName, setTeamName] = useState('');
  const [memberName, setMemberName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [switchOpen, setSwitchOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const loadTeams = useCallback(() => {
    api.listTeams().then((rows) => setTeams(Array.isArray(rows) ? rows : [])).catch((e) => setError(e.message));
  }, []);

  const loadProjects = useCallback(() => {
    api
      .listProjects(activeTeam || undefined)
      .then((rows) => setProjects(Array.isArray(rows) ? rows : []))
      .catch((e) => setError(e.message));
  }, [activeTeam]);

  useEffect(loadTeams, [loadTeams]);
  useEffect(loadProjects, [loadProjects]);

  // 当前团队的成员列表
  useEffect(() => {
    if (!activeTeam) {
      setMembers([]);
      return;
    }
    api
      .listMembers(activeTeam)
      .then((rows) => setMembers(Array.isArray(rows) ? rows : []))
      .catch(() => setMembers([]));
  }, [activeTeam]);

  const createTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const t = await api.createTeam(teamName.trim());
      setTeamName('');
      setSwitchOpen(false);
      loadTeams();
      setActiveTeam(t.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memberName.trim() || busy || !activeTeam) return;
    setBusy(true);
    setError('');
    try {
      await api.addMember(activeTeam, memberName.trim());
      setMemberName('');
      const rows = await api.listMembers(activeTeam);
      setMembers(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (id: string) => {
    if (!activeTeam) return;
    try {
      await api.removeMember(activeTeam, id);
      setMembers((ms) => ms.filter((m) => m.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    <div className="home-shell">
      {/* 左侧边栏：左上角团队切换下拉框 + 导航 */}
      <aside className="home-sidebar">
        <details
          className="team-switch"
          open={switchOpen}
          onToggle={(e) => setSwitchOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary title="切换团队">
            <span className="logo">◈</span>
            <span className="team-switch-name">{activeTeamName ?? '全部团队'}</span>
            <span className="caret">▾</span>
          </summary>
          <div className="team-switch-pop">
            <button
              className={`team-switch-item ${activeTeam === '' ? 'active' : ''}`}
              onClick={() => {
                setActiveTeam('');
                setSwitchOpen(false);
              }}
            >
              👥 全部团队
            </button>
            {teams.map((t) => (
              <button
                key={t.id}
                className={`team-switch-item ${activeTeam === t.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveTeam(t.id);
                  setSwitchOpen(false);
                }}
              >
                {t.name}
                <em>{t.project_count}</em>
              </button>
            ))}
            <form className="team-switch-create" onSubmit={createTeam}>
              <input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="新团队名称"
                className="compact-input"
              />
              <button type="submit" disabled={busy || !teamName.trim()}>＋ 创建</button>
            </form>
          </div>
        </details>

        <nav className="side-nav">
          <button
            className={`side-nav-item ${view === 'projects' ? 'active' : ''}`}
            onClick={() => setView('projects')}
          >
            📁 项目
          </button>
          <button
            className={`side-nav-item ${view === 'members' ? 'active' : ''}`}
            onClick={() => setView('members')}
          >
            👤 团队成员
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

              <form className="inline-form" onSubmit={createProject}>
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder={activeTeamName ? `在「${activeTeamName}」中新建项目` : '输入项目名称（可先在左上角选择团队）'}
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
          ) : activeTeamName ? (
            <>
              <header className="view-header">
                <h1>团队成员 · {activeTeamName}</h1>
                <p>维护该团队的成员名单，成员可参与项目评论协作</p>
              </header>

              <form className="inline-form" onSubmit={addMember}>
                <input
                  value={memberName}
                  onChange={(e) => setMemberName(e.target.value)}
                  placeholder="输入成员姓名"
                  className="compact-input grow"
                />
                <button type="submit" disabled={busy || !memberName.trim()}>＋ 添加成员</button>
              </form>

              <ul className="member-list">
                {members.length === 0 && <p className="empty">还没有成员，先添加一个</p>}
                {members.map((m) => (
                  <li key={m.id} className="member-row">
                    <span className="member-avatar">{m.name.slice(0, 1).toUpperCase()}</span>
                    <span className="member-name">{m.name}</span>
                    <span className="dim small">加入于 {new Date(m.created_at).toLocaleDateString('zh-CN')}</span>
                    <button className="member-remove" onClick={() => removeMember(m.id)}>移除</button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="members-empty">
              <p>请先在左上角下拉框选择一个团队</p>
              <p className="dim">选择团队后即可维护该团队的成员名单</p>
            </div>
          )}

          {error && <div className="home-error">{error}</div>}
        </div>
      </main>
    </div>
  );
}
