import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, getIdentity, setIdentity, type AuthUser } from '../api';
import type { Identity, ImportToken, Member } from '../api';
import { ChevronDown, Folder, KeyRound, LogOut, Mail, Pencil, Plus, Trash2, Users, X } from '../components/icons';
import { useDialogs } from '../components/Dialogs';
import RowMenu from '../components/RowMenu';

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

type View = 'projects' | 'members';

/** 头像单色：按账号标识稳定散列到一组纯色（同一账号每次一致，不同账号不同色） */
const AVATAR_COLORS = [
  '#6c4cf1', '#0d99ff', '#0e9384', '#12b76a',
  '#f79009', '#f04438', '#ee46bc', '#175cd3',
  '#7a5af8', '#dd2590', '#475467', '#0e7090',
] as const;

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** 角色显示名 */
const ROLE_LABEL: Record<string, string> = {
  owner: '所有者',
  admin: '管理员',
  collaborator: '协作 · 只读',
};

/** 最近访问的团队：无 team 参数时优先用它，避免总落到列表第一个团队 */
const LAST_TEAM_KEY = 'shejixiezuo:last-team';

function readLastTeamId() {
  try {
    return localStorage.getItem(LAST_TEAM_KEY) ?? '';
  } catch {
    return '';
  }
}

export default function HomePage() {
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<View>('projects');
  const [teams, setTeams] = useState<Team[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // 团队上下文以 URL 的 ?team= 为准；旧链接没有参数时回退到最近访问的团队
  const [activeTeam, setActiveTeam] = useState<string>(searchParams.get('team') || readLastTeamId());
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'admin' | 'collaborator'>('collaborator');
  // 最近一次生成的邀请：链接只展示给操作者，可复制
  const [inviteLink, setInviteLink] = useState<{ email: string; role: string; inviteUrl: string } | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  // 成员角色默认只读；点「编辑身份」后该行才临时进入可编辑态
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [identity, setIdentityState] = useState<Identity | null>(null);
  // 登录账号（邮箱注册登录），顶栏头像展示与退出
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  // 导入令牌从侧栏页改为头像下拉入口 + 弹窗展示
  const [tokenModal, setTokenModal] = useState(false);
  const avatarMenuRef = useRef<HTMLDetailsElement | null>(null);
  const teamSwitchRef = useRef<HTMLDetailsElement | null>(null);

  // 首页所有浮层统一支持「点击其他区域自动关闭」：
  // 团队切换下拉 / 头像下拉（details 元素）；弹窗类（dlg-overlay）已有遮罩点击关闭
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(t)) {
        avatarMenuRef.current.open = false;
      }
      if (teamSwitchRef.current && !teamSwitchRef.current.contains(t)) {
        if (teamSwitchRef.current.open) setSwitchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 团队导入令牌：newToken 只在生成后展示一次
  const [tokens, setTokens] = useState<ImportToken[]>([]);
  const [newToken, setNewToken] = useState('');
  // 令牌作用范围：默认「全部团队」，插件里可先选团队再选项目
  const [tokenScope, setTokenScope] = useState<ImportToken['scope']>('all');
  const navigate = useNavigate();
  const dialogs = useDialogs();

  // 当前登录账号（守卫保证已登录，这里只取展示数据）
  useEffect(() => {
    api.me().then(setAuthUser).catch(() => undefined);
  }, []);

  // 邮箱验证：未验证时顶部提示条；重发 60s 冷却
  const [resendState, setResendState] = useState<'idle' | 'sent' | 'cool'>('idle');
  const resendVerification = async () => {
    if (resendState === 'cool') return;
    try {
      await api.resendVerification();
      setResendState('sent');
      setTimeout(() => setResendState('cool'), 60_000);
      setTimeout(() => setResendState('idle'), 6_000);
    } catch {
      /* 模糊响应，静默失败 */
    }
  };

  const doLogout = async () => {
    try {
      await api.logout();
    } finally {
      navigate('/login', { replace: true });
    }
  };

  // 当前登录账号在当前团队的真实角色：体验身份（identity）优先，否则按成员表匹配，
  // 都没有 = 协作者（与服务端 teamRole 的最小权限默认一致）
  const myMember = authUser ? members.find((m) => m.email === authUser.email) : undefined;
  const myRole: 'owner' | 'admin' | 'collaborator' = identity?.role ?? myMember?.role ?? 'collaborator';
  const canManage = myRole === 'owner' || myRole === 'admin';

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

  // 团队上下文以 URL 的 ?team= 为准：URL → state 单向同步（前进/后退/直开链接都走这里）。
  // 反向只在「用户主动切换团队 / 回退兜底」时由 switchTeam 显式 navigate，
  // 避免两个 effect 互相回写导致 666 ↔ 11 反复横跳与请求风暴。
  const urlTeam = searchParams.get('team') ?? '';
  const switchTeam = useCallback(
    (id: string, replace = false) => {
      setActiveTeam(id);
      navigate(`/projects?team=${encodeURIComponent(id)}`, { replace });
    },
    [navigate]
  );

  useEffect(() => {
    if (urlTeam && urlTeam !== activeTeam) setActiveTeam(urlTeam);
  }, [urlTeam, activeTeam]);

  // 记住最近访问的团队，供无 ?team= 的旧链接兜底
  useEffect(() => {
    if (!activeTeam) return;
    try {
      localStorage.setItem(LAST_TEAM_KEY, activeTeam);
    } catch {
      // localStorage 不可用时忽略，仅影响「最近访问」记忆
    }
  }, [activeTeam]);

  // 旧的无 ?team= 地址：确定当前团队后补上参数（replace，不留死链）
  useEffect(() => {
    if (!activeTeam || urlTeam) return;
    navigate(`/projects?team=${encodeURIComponent(activeTeam)}`, { replace: true });
  }, [activeTeam, urlTeam, navigate]);

  // 未指定团队 / 团队已失效：优先最近访问，其次第一个团队，并把 URL 补齐（旧链接不留死链）
  useEffect(() => {
    if (!teams.length) return;
    if (activeTeam && teams.some((t) => t.id === activeTeam)) return;
    const stored = readLastTeamId();
    const fallback = stored && teams.some((t) => t.id === stored) ? stored : teams[0].id;
    switchTeam(fallback, true);
  }, [teams, activeTeam, switchTeam]);

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
      // 后台加载失败（如体验协作者身份时令牌列表返回 403）不弹全局错误条，
      // 避免权限说明常驻在项目 / 团队成员页。
      .catch(() => setTokens([]));
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
      const created = await api.createImportToken(activeTeam, tokenScope);
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
      message: '撤销后该记录会从列表删除且不可恢复，使用该令牌的 Figma 插件会立即失效（返回 401），需要重新填写新令牌。',
      confirmText: '撤销并删除',
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

  /** 删除项目：服务端级联删除其中设计稿 / 画板 / 图层，不可逆，先站内确认 */
  const removeProject = async (p: Project) => {
    const ok = await dialogs.confirm({
      title: '删除项目',
      message: (
        <>
          确定删除「{p.name}」吗？项目内的 <b>{p.file_count} 份设计稿</b>及其画板、标注数据会一并删除，且不可恢复。
        </>
      ),
      confirmText: '删除项目',
    });
    if (!ok) return;
    try {
      await api.deleteProject(p.id);
      loadProjects();
      loadTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 创建团队：弹出与「新建项目」一致的弹窗（Enter 确认 / Esc 取消 / 点遮罩关闭） */
  const openCreateTeam = () => {
    setSwitchOpen(false);
    void dialogs.prompt({
      title: '创建团队',
      label: '团队名称',
      placeholder: '输入团队名称，如 移动设计组',
      maxLength: 60,
      confirmText: '创建',
      onSubmit: async (name) => {
        try {
          const t = await api.createTeam(name);
          await loadTeams();
          switchTeam(t.id);
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    });
  };

  const addMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memberEmail.trim() || busy || !activeTeam) return;
    setBusy(true);
    setError('');
    try {
      // 邀请流：生成一次性邀请链接（7 天有效），并发送邀请邮件；对方接受后才入队
      const inv = await api.inviteMember(activeTeam, memberEmail.trim(), memberRole);
      setInviteLink(inv);
      setMemberEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink.inviteUrl);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      /* 剪贴板不可用时用户可手动选中复制 */
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
  const avatarSeed = authUser?.email ?? identity?.email ?? '主';

  return (
    <div className="home-shell">
      {/* 邮箱未验证提示条（软验证：不阻断使用） */}
      {authUser && authUser.verified === false && (
        <div className="verify-banner">
          <span>📧 邮箱尚未验证，验证后可确保账号安全与找回密码。</span>
          <button onClick={resendVerification} disabled={resendState === 'cool'}>
            {resendState === 'cool' ? '请 1 分钟后再试' : resendState === 'sent' ? '已重新发送 ✓' : '重新发送验证邮件'}
          </button>
        </div>
      )}
      {/* 顶部状态栏：左侧上下文面包屑，右侧身份头像 */}
      <header className="home-topbar">
        <details
          className="team-switch topbar-team-switch"
          ref={teamSwitchRef}
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
                  switchTeam(t.id);
                  setView('projects');
                  setSwitchOpen(false);
                }}
              >
                {t.name}
                <em>{t.project_count}</em>
              </button>
            ))}
            <button
              type="button"
              className="team-switch-create"
              onClick={openCreateTeam}
              title="创建新团队"
            >
              <Plus /> 新建团队
            </button>
          </div>
        </details>
        <details className="avatar-menu" ref={avatarMenuRef}>
          <summary title="当前身份">
            <span className="avatar-dot" style={{ backgroundColor: avatarColor(avatarSeed) }}>{avatarSeed.slice(0, 1).toUpperCase()}</span>
            <span className="avatar-name">{authUser?.email ?? (identity ? identity.email : '所有者')}</span>
            <span className="caret"><ChevronDown /></span>
          </summary>
          <div className="avatar-pop">
            <div className="avatar-pop-head">
              <span className="avatar-dot big" style={{ backgroundColor: avatarColor(avatarSeed) }}>{avatarSeed.slice(0, 1).toUpperCase()}</span>
              <div className="avatar-pop-info">
                <b>{authUser?.email ?? (identity ? identity.email : '所有者')}</b>
                <div>
                  <span className={`role-badge ${identity?.role ?? myRole}`}>
                    {ROLE_LABEL[identity?.role ?? myRole] ?? '成员'}
                  </span>
                </div>
              </div>
            </div>
            <div className="avatar-menu-list">
              <button
                className="avatar-menu-item"
                onClick={() => {
                  setTokenModal(true);
                  if (avatarMenuRef.current) avatarMenuRef.current.open = false;
                }}
              >
                <KeyRound /> 导入令牌
              </button>
              {identity && activeTeam && (
                <button
                  className="avatar-menu-item"
                  onClick={() => {
                    exitIdentity();
                    if (avatarMenuRef.current) avatarMenuRef.current.open = false;
                  }}
                >
                  <X /> 退出身份体验
                </button>
              )}
              {authUser && (
                <button className="avatar-menu-item" onClick={() => void doLogout()}>
                  <LogOut /> 退出登录
                </button>
              )}
            </div>
            {!identity && (
              <p className="dim small avatar-pop-hint">可在「团队成员」页选择成员身份体验权限差异</p>
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
        </nav>
      </aside>

      {/* 右侧内容区 */}
      <main className="home-main">
        <div className="home-main-inner">
          {view === 'projects' ? (
            <>
              <header className="view-header">
                <div className="view-header-row">
                  <div className="view-header-text">
                    <h1>项目{activeTeamName ? ` · ${activeTeamName}` : ''}</h1>
                    <p>选择项目进入，查看设计稿、标注与规范</p>
                  </div>
                  <button type="button" className="new-project-btn" onClick={openCreateProject}>
                    <Plus /> 新建项目
                  </button>
                </div>
              </header>

              <ul className="project-grid">
                {projects.length === 0 && <p className="empty">暂无项目</p>}
                {projects.map((p) => (
                  <li key={p.id} className="project-card-wrap">
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
                    {/* 与卡片按钮同级，避免 button 嵌套 button；点击 ⋯ 不会进入项目 */}
                    {canManage && (
                      <RowMenu
                        className="project-card-menu"
                        label={p.name}
                        items={[{ label: '删除项目', onClick: () => void removeProject(p) }]}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : activeTeamName ? (
            <>
              <header className="view-header">
                <h1>团队成员 · {activeTeamName}</h1>
                <p>所有者 / 管理员可邀请与移除成员、增删项目、上传设计稿；协作者为只读（仅查看）</p>
              </header>

              {canManage ? (
                <>
                  <form className="inline-form" onSubmit={addMember}>
                    <input
                      value={memberEmail}
                      onChange={(e) => setMemberEmail(e.target.value)}
                      placeholder="输入被邀请邮箱，如 design@company.com"
                      className="compact-input grow"
                      type="email"
                    />
                    <select value={memberRole} onChange={(e) => setMemberRole(e.target.value as 'admin' | 'collaborator')} className="compact-input">
                      <option value="collaborator">协作 · 只读</option>
                      <option value="admin">管理员</option>
                    </select>
                    <button type="submit" disabled={busy || !memberEmail.trim()}><Mail /> 发送邀请</button>
                  </form>
                  {inviteLink && (
                    <div className="invite-link-box">
                      <span className="small dim">
                        已向 <b>{inviteLink.email}</b> 发送邀请邮件（{ROLE_LABEL[inviteLink.role] ?? inviteLink.role}，7 天有效）。对方也可通过链接接受：
                      </span>
                      <code className="invite-link-url">{inviteLink.inviteUrl}</code>
                      <button type="button" onClick={() => void copyInviteLink()}>
                        {inviteCopied ? '已复制 ✓' : '复制链接'}
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p className="empty">你是协作者身份，仅可查看设计稿；邀请与管理成员需要管理员权限</p>
              )}

              <ul className="member-list">
                {members.length === 0 && <p className="empty">还没有成员，输入邮箱邀请第一个吧</p>}
                {members.map((m) => (
                  <li key={m.id} className="member-row">
                    <span className="member-avatar">{(m.email ?? m.name).slice(0, 1).toUpperCase()}</span>
                    <div className="member-info">
                      <span className="member-name">
                        {m.email ?? m.name}
                        {m.role === 'owner' && <span className="role-badge owner">所有者</span>}
                      </span>
                      <span className="dim small">加入于 {new Date(m.created_at).toLocaleDateString('zh-CN')}</span>
                    </div>
                    {editingMemberId === m.id && canManage && m.email && m.role !== 'owner' ? (
                      <select
                        className="member-role"
                        value={m.role}
                        autoFocus
                        onChange={(e) => {
                          const role = e.target.value as 'admin' | 'collaborator';
                          setEditingMemberId(null);
                          void changeRole(m.id, role);
                        }}
                        title="选择角色后自动保存"
                      >
                        <option value="admin">管理员</option>
                        <option value="collaborator">协作 · 只读</option>
                      </select>
                    ) : (
                      <span className={`role-badge ${m.role}`}>{ROLE_LABEL[m.role] ?? m.role}</span>
                    )}
                    {canManage && m.email && m.role !== 'owner' && (
                      <button
                        className={`member-action ${editingMemberId === m.id ? 'is-active' : ''}`}
                        onClick={() => setEditingMemberId(editingMemberId === m.id ? null : m.id)}
                        title={editingMemberId === m.id ? '取消编辑身份' : '编辑该成员身份（角色）'}
                      >
                        {editingMemberId === m.id ? <X size={14} /> : <Pencil size={14} />}
                        {editingMemberId === m.id ? '取消' : '编辑身份'}
                      </button>
                    )}
                    {canManage && m.role !== 'owner' && (
                      <button className="member-action" onClick={() => void removeMember(m.id)} title="移除该成员">
                        <Trash2 size={14} /> 移除
                      </button>
                    )}
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

      {/* 导入令牌弹窗：原「团队设置」页内容，入口在头像下拉框 */}
      {tokenModal && activeTeamName && (
        <div className="dlg-overlay" onClick={() => setTokenModal(false)}>
          <div
            className="dlg token-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`导入令牌 · ${activeTeamName}`}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="token-modal-head">
              <div>
                <h2>导入令牌 · {activeTeamName}</h2>
                <p className="dim small">为 Figma 插件生成「导入令牌」，插件用它调用导入接口，不需要浏览器登录状态</p>
              </div>
              <button
                type="button"
                className="token-modal-close"
                aria-label="关闭"
                onClick={() => setTokenModal(false)}
              >
                <X />
              </button>
            </header>

            <section className="settings-section">
              <div className="settings-head">
                <div>
                  <h3>令牌列表</h3>
                  <p className="dim small">
                    令牌以 imp_ 开头，服务端只保存哈希，明文只在生成时显示一次；撤销即删除记录，插件立即失效（401）。
                  </p>
                </div>
                <div className="token-create">
                  <select
                    value={tokenScope}
                    aria-label="令牌作用范围"
                    onChange={(e) => setTokenScope(e.target.value as ImportToken['scope'])}
                  >
                    <option value="all">全部团队</option>
                    <option value="team">仅 {activeTeamName}</option>
                  </select>
                  <button type="button" className="new-project-btn" disabled={busy} onClick={() => void createToken()}>
                    <Plus /> 生成导入令牌
                  </button>
                </div>
              </div>

              {newToken && (
                <div className="token-once">
                  <div className="token-once-head">新令牌（只显示这一次）</div>
                  <div className="token-once-body">
                    <code>{newToken}</code>
                    <button type="button" className="ghost-btn" onClick={() => void copyToken()}>复制</button>
                  </div>
                  <p className="dim small">粘贴到 Figma 插件的「导入令牌」输入框，之后无法再从网站查看明文。</p>
                </div>
              )}

              <ul className="token-list">
                {tokens.length === 0 && <p className="empty">还没有导入令牌，点击右上角生成</p>}
                {tokens.map((t) => (
                  <li key={t.id} className="token-row">
                    <code>{t.prefix}…</code>
                    <span className={`role-badge ${t.scope === 'all' ? 'admin' : 'collaborator'}`}>
                      {t.scope === 'all' ? '全部团队' : '单团队'}
                    </span>
                    <span className="dim small">创建于 {new Date(t.created_at).toLocaleString('zh-CN')}</span>
                    <span className="dim small">
                      {t.last_used_at ? `最近使用 ${new Date(t.last_used_at).toLocaleString('zh-CN')}` : '尚未使用'}
                    </span>
                    <button type="button" className="member-remove" onClick={() => void revokeToken(t.id)}>撤销</button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      )}

      {dialogs.element}
    </div>
  );
}
