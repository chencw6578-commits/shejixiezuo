import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, getIdentity, setIdentity } from '../api';
import type { Identity, ImportToken, Member } from '../api';
import { ChevronDown, Folder, Layers, Mail, Plus, Users } from '../components/icons';
import { useDialogs } from '../components/Dialogs';

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
  cover: string | null;
}

type View = 'projects' | 'members' | 'settings';

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<View>('projects');
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeTeam, setActiveTeam] = useState<string>(searchParams.get('team') ?? ''); // '' = 尚未选定（加载后落到首个团队）
  const [teamName, setTeamName] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'admin' | 'collaborator'>('collaborator');
  const [identity, setIdentityState] = useState<Identity | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 团队导入令牌：newToken 只在生成后展示一次
  const [tokens, setTokens] = useState<ImportToken[]>([]);
  const [newToken, setNewToken] = useState('');
  const navigate = useNavigate();
  const dialogs = useDialogs();

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
  // 只有当前团队：未指定团队或团队失效时，落到首个团队
  useEffect(() => {
    if (!teams.length) return;
    if (!teams.some((t) => t.id === activeTeam)) setActiveTeam(teams[0].id);
  }, [teams, activeTeam]);
  useEffect(loadProjects, [loadProjects]);

  // 当前团队的成员列表 + 身份（协作者只读 / 管理员可编辑）
  useEffect(() => {
    if (!activeTeam) {
      setMembers([]);
      setIdentityState(null);
      return;
    }
    setIdentityState(getIdentity(activeTeam));
    api
      .listMembers(activeTeam)
      .then((rows) => setMembers(Array.isArray(rows) ? rows : []))
      .catch(() => setMembers([]));
  }, [activeTeam]);

  const loadTokens = useCallback(() => {
    if (!activeTeam) {
      setTokens([]);
      return;
    }
    api
      .listImportTokens(activeTeam)
      .then((rows) => setTokens(Array.isArray(rows) ? rows : []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [activeTeam]);

  useEffect(() => {
    setNewToken('');
    loadTokens();
  }, [loadTokens]);

  const createToken = async () => {
    if (!activeTeam || busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.createImportToken(activeTeam);
      setNewToken(created.token);
      loadTokens();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(newToken);
      setError('');
    } catch {
      setError('复制失败：请手动选中令牌文本复制');
    }
  };

  const revokeToken = async (id: string) => {
    if (!activeTeam) return;
    const ok = await dialogs.confirm({
      title: '撤销导入令牌',
      message: '撤销后使用该令牌的 Figma 插件会立即失效（返回 401），需要重新填写新令牌。',
      confirmText: '撤销',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.revokeImportToken(activeTeam, id);
      loadTokens();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

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
    if (!memberEmail.trim() || busy || !activeTeam) return;
    setBusy(true);
    setError('');
    try {
      await api.addMember(activeTeam, memberEmail.trim(), memberRole);
      setMemberEmail('');
      const rows = await api.listMembers(activeTeam);
      setMembers(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (id: string, role: 'admin' | 'collaborator') => {
    if (!activeTeam) return;
    try {
      const updated = await api.updateMemberRole(activeTeam, id, role);
      setMembers((ms) => ms.map((m) => (m.id === id ? updated : m)));
      // 若当前体验身份就是该成员，同步角色
      const idNow = getIdentity(activeTeam);
      if (idNow && updated.email && updated.email === idNow.email) {
        setIdentity(activeTeam, { email: updated.email, role });
        setIdentityState({ email: updated.email, role });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const enterAs = (m: Member) => {
    if (!activeTeam || !m.email) return;
    setIdentity(activeTeam, { email: m.email, role: m.role });
    setIdentityState({ email: m.email, role: m.role });
  };

  const exitIdentity = () => {
    if (!activeTeam) return;
    setIdentity(activeTeam, null);
    setIdentityState(null);
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

  const openCreateProject = () => {
    void dialogs.prompt({
      title: '新建项目',
      label: '项目名称',
      placeholder: activeTeamName ? `在「${activeTeamName}」中新建项目` : '输入项目名称',
      maxLength: 60,
      confirmText: '创建',
      onSubmit: async (name) => {
        try {
          await api.createProject(name, activeTeam || undefined);
          await loadProjects();
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    });
  };

  const activeTeamName = teams.find((t) => t.id === activeTeam)?.name;

  return (
    <div className="home-shell">
      {/* 顶部状态栏：左侧上下文面包屑，右侧身份头像 */}
      <header className="home-topbar">
        <details
          className="team-switch topbar-team-switch"
          open={switchOpen}
          onToggle={(e) => setSwitchOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary title="切换团队">
            <span className="team-switch-name">{activeTeamName ?? '当前团队'}</span>
            <span className="caret"><ChevronDown /></span>
          </summary>
          <div className="team-switch-pop">
            {teams.map((t) => (
              <button
                key={t.id}
                className={`team-switch-item ${activeTeam === t.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveTeam(t.id);
                  setView('projects');
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
              <button type="submit" disabled={busy || !teamName.trim()}><Plus /> 创建</button>
            </form>
          </div>
        </details>
        <details className="avatar-menu">
          <summary title="当前身份">
            <span className="avatar-dot">{identity ? identity.email.slice(0, 1).toUpperCase() : '主'}</span>
            <span className="avatar-name">{identity ? identity.email : '所有者'}</span>
            <span className="caret"><ChevronDown /></span>
          </summary>
          <div className="avatar-pop">
            <div className="avatar-pop-head">
              <span className="avatar-dot big">{identity ? identity.email.slice(0, 1).toUpperCase() : '主'}</span>
              <div className="avatar-pop-info">
                <b>{identity ? identity.email : '所有者'}</b>
                <div>
                  {identity ? (
                    <span className={`role-badge ${identity.role}`}>
                      {identity.role === 'admin' ? '管理员' : '协作 · 只读'}
                    </span>
                  ) : (
                    <span className="dim small">最高权限</span>
                  )}
                </div>
              </div>
            </div>
            {identity && activeTeam ? (
              <button className="ghost-btn" onClick={exitIdentity}>退出身份（回到所有者）</button>
            ) : (
              <p className="dim small">可在「团队成员」页选择成员身份体验权限差异</p>
            )}
          </div>
        </details>
      </header>

      <div className="home-body">
      {/* 左侧边栏：左上角团队切换下拉框 + 导航 */}
      <aside className="home-sidebar">
        <nav className="side-nav">
          <button
            className={`side-nav-item ${view === 'projects' ? 'active' : ''}`}
            onClick={() => setView('projects')}
          >
            <Folder /> 项目
          </button>
          <button
            className={`side-nav-item ${view === 'members' ? 'active' : ''}`}
            onClick={() => setView('members')}
          >
            <Users /> 团队成员
          </button>
          <button
            className={`side-nav-item ${view === 'settings' ? 'active' : ''}`}
            onClick={() => setView('settings')}
          >
            <Layers /> 团队设置
          </button>
        </nav>
      </aside>

      {/* 右侧内容区 */}
      <main className="home-main">
        <div className="home-main-inner">
          {view === 'projects' ? (
            <>
              <header className="view-header">
                <div className="view-header-row">
                  <h1>项目{activeTeamName ? ` · ${activeTeamName}` : ''}</h1>
                  <button type="button" className="new-project-btn" onClick={openCreateProject}>
                    <Plus /> 新建项目
                  </button>
                </div>
                <p>选择项目进入，查看设计稿、标注与规范</p>
              </header>

              <ul className="project-grid">
                {projects.length === 0 && <p className="empty">暂无项目</p>}
                {projects.map((p) => (
                  <li key={p.id}>
                    <button className="file-card project-card" onClick={() => navigate(`/projects/${p.id}`)}>
                      <span className="project-cover">
                        {p.cover ? (
                          <img src={p.cover} alt={p.name} loading="lazy" />
                        ) : (
                          <span className="project-cover-empty"><Folder /></span>
                        )}
                      </span>
                      <span className="file-name"><Folder /> {p.name}</span>
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
          ) : view === 'settings' && activeTeamName ? (
            <>
              <header className="view-header">
                <h1>团队设置 · {activeTeamName}</h1>
                <p>为 Figma 插件生成「导入令牌」，插件用它调用导入接口，不需要浏览器登录状态</p>
              </header>

              <section className="settings-section">
                <div className="settings-head">
                  <div>
                    <h2>导入令牌</h2>
                    <p className="dim small">
                      令牌以 imp_ 开头，服务端只保存哈希，明文只在生成时显示一次；撤销后插件立即失效（401）。
                    </p>
                  </div>
                  <button type="button" className="new-project-btn" disabled={busy} onClick={() => void createToken()}>
                    <Plus /> 生成导入令牌
                  </button>
                </div>

                {newToken && (
                  <div className="token-once">
                    <div className="token-once-head">新令牌（只显示这一次）</div>
                    <div className="token-once-body">
                      <code>{newToken}</code>
                      <button type="button" className="ghost-btn" onClick={() => void copyToken()}>复制</button>
                    </div>
                    <p className="dim small">粘贴到 Figma 插件第 3 步「导入令牌」，之后无法再从网站查看明文。</p>
                  </div>
                )}

                <ul className="token-list">
                  {tokens.length === 0 && <p className="empty">还没有导入令牌，点击右上角生成</p>}
                  {tokens.map((t) => (
                    <li key={t.id} className="token-row">
                      <code>{t.prefix}…</code>
                      <span className="dim small">创建于 {new Date(t.created_at).toLocaleString('zh-CN')}</span>
                      <span className="dim small">
                        {t.last_used_at ? `最近使用 ${new Date(t.last_used_at).toLocaleString('zh-CN')}` : '尚未使用'}
                      </span>
                      {t.revoked_at ? (
                        <span className="role-badge collaborator">已撤销</span>
                      ) : (
                        <button type="button" className="member-remove" onClick={() => void revokeToken(t.id)}>撤销</button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : activeTeamName ? (
            <>
              <header className="view-header">
                <h1>团队成员 · {activeTeamName}</h1>
                <p>通过邮箱邀请成员。管理员可编辑与删除设计稿，协作者为只读（仅查看与评论）</p>
              </header>

              <div className="identity-bar">
                当前身份：
                {identity ? (
                  <>
                    <strong>{identity.email}</strong>
                    <span className={`role-badge ${identity.role}`}>
                      {identity.role === 'admin' ? '管理员' : '协作 · 只读'}
                    </span>
                    <button className="ghost-btn" onClick={exitIdentity}>退出身份</button>
                  </>
                ) : (
                  <strong>所有者（最高权限）</strong>
                )}
              </div>

              <form className="inline-form" onSubmit={addMember}>
                <input
                  value={memberEmail}
                  onChange={(e) => setMemberEmail(e.target.value)}
                  placeholder="输入成员邮箱，如 design@company.com"
                  className="compact-input grow"
                  type="email"
                />
                <select value={memberRole} onChange={(e) => setMemberRole(e.target.value as 'admin' | 'collaborator')} className="compact-input">
                  <option value="collaborator">协作 · 只读</option>
                  <option value="admin">管理员</option>
                </select>
                <button type="submit" disabled={busy || !memberEmail.trim()}><Mail /> 邀请成员</button>
              </form>

              <ul className="member-list">
                {members.length === 0 && <p className="empty">还没有成员，输入邮箱邀请第一个吧</p>}
                {members.map((m) => (
                  <li key={m.id} className="member-row">
                    <span className="member-avatar">{(m.email ?? m.name).slice(0, 1).toUpperCase()}</span>
                    <div className="member-info">
                      <span className="member-name">{m.email ?? m.name}</span>
                      <span className="dim small">加入于 {new Date(m.created_at).toLocaleDateString('zh-CN')}</span>
                    </div>
                    <select
                      className="member-role"
                      value={m.role}
                      onChange={(e) => void changeRole(m.id, e.target.value as 'admin' | 'collaborator')}
                      disabled={!m.email}
                      title={m.email ? '修改角色' : '历史成员（无邮箱），角色不可切换'}
                    >
                      <option value="admin">管理员</option>
                      <option value="collaborator">协作 · 只读</option>
                    </select>
                    <button
                      className="ghost-btn"
                      disabled={!m.email}
                      onClick={() => enterAs(m)}
                      title={m.email ? '以该成员身份体验权限差异' : '历史成员（无邮箱）不可切换'}
                    >
                      以此身份体验
                    </button>
                    <button className="member-remove" onClick={() => void removeMember(m.id)}>移除</button>
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
      {dialogs.element}
    </div>
  );
}
