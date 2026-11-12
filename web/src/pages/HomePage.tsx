import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, getIdentity, setIdentity, VERIFY_BANNER_DISMISS_KEY, type AuthUser } from '../api';
import type { Identity, ImportToken, Member, ProjectCoverFrame } from '../api';
import { ChevronDown, Folder, KeyRound, LogOut, Mail, Pencil, Plus, Search, Trash2, Users, X } from '../components/icons';
import { useDialogs } from '../components/Dialogs';
import { canvasBgColor, isDarkCanvas, readCanvasBg } from '../canvasBg';
import RowMenu from '../components/RowMenu';

interface Team {
  id: string;
  name: string;
  project_count: string;
  created_at?: string;
  my_role?: 'owner' | 'admin' | 'collaborator' | null;
}

interface Project {
  id: string;
  name: string;
  file_count: string;
  last_file_at: string | null;
  created_at: string;
  cover: string | null;
  cover_frames: ProjectCoverFrame[] | null;
}

type View = 'projects' | 'members';

/** 品牌图形 Logo（纯图形无文字）：圆角方块内「画板 + 向右上出图箭头」——设计稿从画板向外交付，对应网站「设计交付」核心 */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="brand-mark-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8ab4f8" />
          <stop offset="1" stopColor="#0b57d0" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#brand-mark-g)" />
      {/* 画板：设计载体 */}
      <rect x="4" y="4.5" width="11.5" height="11.5" rx="2" fill="none" stroke="#fff" strokeWidth="1.7" />
      {/* 画板内容示意线 */}
      <path d="M7 8.2h5.5M7 11h3.5" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" opacity="0.55" fill="none" />
      {/* 交付箭头：从画板右下角穿出、指向右上（导出/交付） */}
      <path d="M13 16 19.5 9.5" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" fill="none" />
      <path d="M16.2 9.5h3.3v3.3" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/* 项目卡片图形标识：品牌渐变小方块 + 前实后虚两层画板（一个项目 = 一叠设计稿），
   与顶栏 BrandMark 同族视觉，替代通用文件夹图标 */
function ProjectMark() {
  return (
    <svg className="project-mark" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="project-mark-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8ab4f8" />
          <stop offset="1" stopColor="#0b57d0" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#project-mark-g)" />
      {/* 后层画板：半透明，示意项目内更多设计稿 */}
      <rect x="9.6" y="4.9" width="9.5" height="9.5" rx="1.8" fill="none" stroke="#fff" strokeWidth="1.5" opacity="0.45" />
      {/* 前层画板：实心填充遮住后层交叠部分，形成清晰的前后层叠 */}
      <rect x="4.9" y="9.6" width="9.5" height="9.5" rx="1.8" fill="#1a73e8" stroke="#fff" strokeWidth="1.7" />
    </svg>
  );
}

/** 项目封面：把项目内全部画板排成总览网格，而不是只显示第一张画板 */
function ProjectCover({ frames }: { frames: ProjectCoverFrame[] }) {
  return (
    <span className="project-cover-grid">
      {frames.slice(0, 10).map((f, i) => (
        <CoverCell key={`${f.name}-${i}`} frame={f} />
      ))}
    </span>
  );
}

/** 单个画板格子：缩略图加载失败时退回「白底 + 画板名」，封面不会变空 */
function CoverCell({ frame }: { frame: ProjectCoverFrame }) {
  const [failed, setFailed] = useState(false);
  const showImg = !!frame.thumb_url && !failed;
  return (
    <span className="project-cover-cell" title={frame.name}>
      {showImg ? (
        <img src={frame.thumb_url!} alt={frame.name} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="project-cover-cell-name">{frame.name}</span>
      )}
    </span>
  );
}

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

/** 项目列表 Tab：全部项目 / 最近使用 / 最近更新 */
type ProjectTab = 'all' | 'viewed' | 'updated';

/** 最近使用记录存 localStorage：{ projectId: 最后进入时间戳 }，纯客户端行为 */
const RECENT_VIEWS_KEY = 'recentProjectViews';

function readRecentViews(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(RECENT_VIEWS_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function recordProjectView(id: string): void {
  try {
    const map = readRecentViews();
    map[id] = Date.now();
    localStorage.setItem(RECENT_VIEWS_KEY, JSON.stringify(map));
  } catch {
    /* 存储不可用时静默忽略，不影响进入项目 */
  }
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
  // 项目列表 Tab：全部项目 / 最近使用 / 最近更新
  const [projectTab, setProjectTab] = useState<ProjectTab>('all');
  // 团队上下文以 URL 的 ?team= 为准；旧链接没有参数时回退到最近访问的团队
  const [activeTeam, setActiveTeam] = useState<string>(searchParams.get('team') || readLastTeamId());
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'admin' | 'collaborator'>('collaborator');
  // 最近一次生成的邀请链接：只展示给操作者，可复制（链接邀请不绑定邮箱，可多人使用）
  const [inviteLink, setInviteLink] = useState<{ email?: string | null; role: string; inviteUrl: string } | null>(null);
  // 邀请成员走弹窗（替代原内联表单）：link=复制邀请链接 / email=邮箱直接加入
  const [inviteModal, setInviteModal] = useState(false);
  const [inviteMode, setInviteMode] = useState<'link' | 'email'>('link');
  const [inviteCopied, setInviteCopied] = useState(false);
  // 弹窗内专用提示：页面底部 home-error 会被弹窗遮住，重复成员/接口错误必须就地显示
  const [inviteError, setInviteError] = useState('');
  // 编辑成员身份走弹窗：记录目标成员与草稿角色，点保存才提交
  const [roleModal, setRoleModal] = useState<{ id: string; email: string; role: 'admin' | 'collaborator' } | null>(null);
  const [roleDraft, setRoleDraft] = useState<'admin' | 'collaborator'>('collaborator');
  // 移除成员二次确认弹窗：点「移除」先弹窗，确认后才真正调用接口
  const [removeModal, setRemoveModal] = useState<{ id: string; email: string } | null>(null);
  // 团队管理：搜索昵称/邮箱 + 按角色筛选（纯前端过滤，不改接口与成员数据）
  const [memberQuery, setMemberQuery] = useState('');
  const [memberRoleFilter, setMemberRoleFilter] = useState<'all' | 'owner' | 'admin' | 'collaborator'>('all');
  const isMemberFiltering = memberQuery.trim() !== '' || memberRoleFilter !== 'all';
  const filteredMembers = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    return members.filter((m) => {
      if (memberRoleFilter !== 'all' && m.role !== memberRoleFilter) return false;
      if (!q) return true;
      return (m.name ?? '').toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q);
    });
  }, [members, memberQuery, memberRoleFilter]);
  // 邮箱邀请输入的是已加入成员：输入时就提示，提交时再给明确反馈（后端 409 兜底不变）
  const duplicateMember = useMemo(() => {
    const q = memberEmail.trim().toLowerCase();
    if (!q || !q.includes('@')) return null;
    return members.find((m) => (m.email ?? '').trim().toLowerCase() === q) ?? null;
  }, [memberEmail, members]);
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
  // 页面底部错误条只作临时反馈：自动消除，避免上一次操作的旧错误（尤其重复邀请提示）长期常驻
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);
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

  // 邮箱验证：未验证时顶部提示条；可手动关闭（本次登录会话内不再出现，下次登录由 LoginPage 重置）；重发 60s 冷却
  const [resendState, setResendState] = useState<'idle' | 'sent' | 'cool'>('idle');
  const [verifyDismissed, setVerifyDismissed] = useState(false);
  useEffect(() => {
    if (!authUser) {
      setVerifyDismissed(false);
      return;
    }
    try {
      setVerifyDismissed(sessionStorage.getItem(VERIFY_BANNER_DISMISS_KEY) === authUser.email);
    } catch {
      setVerifyDismissed(false);
    }
  }, [authUser]);
  const dismissVerifyBanner = () => {
    setVerifyDismissed(true);
    try {
      if (authUser) sessionStorage.setItem(VERIFY_BANNER_DISMISS_KEY, authUser.email);
    } catch {
      /* 隐私模式下忽略，仅本次渲染内隐藏 */
    }
  };
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

  // 按 Tab 过滤/排序：全部=原顺序；最近使用=localStorage 记录倒序；最近更新=按最后更新时间倒序
  const visibleProjects = useMemo(() => {
    if (projectTab === 'viewed') {
      const views = readRecentViews();
      return projects
        .filter((p) => views[p.id])
        .sort((a, b) => views[b.id] - views[a.id]);
    }
    if (projectTab === 'updated') {
      return [...projects].sort(
        (a, b) =>
          new Date(b.last_file_at ?? b.created_at).getTime() - new Date(a.last_file_at ?? a.created_at).getTime()
      );
    }
    return projects;
  }, [projectTab, projects]);

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
    // 切换团队时清空搜索与角色筛选，避免新团队沿用旧条件而显示「没有匹配的成员」
    setMemberQuery('');
    setMemberRoleFilter('all');
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
      // 避免权限说明常驻在项目 / 团队管理页。
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

  /** 重命名团队（所有者 / 管理员）：弹窗输入新名称，成功后刷新团队列表与侧栏显示 */
  const openRenameTeam = (t: Team) => {
    setSwitchOpen(false);
    void dialogs.prompt({
      title: '重命名团队',
      label: '团队名称',
      initialValue: t.name,
      placeholder: '输入新的团队名称',
      maxLength: 60,
      confirmText: '保存',
      validate: (v) => (v.trim() ? null : '请输入团队名称'),
      onSubmit: async (name) => {
        const trimmed = name.trim();
        if (trimmed === t.name) return null;
        try {
          await api.renameTeam(t.id, trimmed);
          await loadTeams();
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    });
  };

  /** 修改当前账号昵称：保存后同步刷新登录态与当前团队成员列表 */
  const openEditNickname = () => {
    if (!authUser) return;
    if (avatarMenuRef.current) avatarMenuRef.current.open = false;
    void dialogs.prompt({
      title: '修改昵称',
      label: '昵称',
      initialValue: authUser.name ?? '',
      placeholder: '昵称将显示在头像下拉与团队成员列表',
      maxLength: 30,
      confirmText: '保存',
      validate: (v) => (v.trim() ? null : '请输入昵称'),
      onSubmit: async (name) => {
        const trimmed = name.trim();
        if (trimmed === (authUser.name ?? '')) return null;
        try {
          const updated = await api.updateMe(trimmed);
          setAuthUser(updated);
          if (activeTeam) {
            const rows = await api.listMembers(activeTeam);
            setMembers(Array.isArray(rows) ? rows : []);
          }
          return null;
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
    });
  };

  /** 移交所有权（仅所有者可用）：拉取该团队其他成员 → 选择 → 二次确认 → 后端互改角色 */
  const openTransferTeam = async (teamId: string, teamName: string) => {
    setSwitchOpen(false);
    let others: { id: string; name: string; email: string | null }[] = [];
    try {
      const rows = await api.listMembers(teamId);
      others = (Array.isArray(rows) ? rows : []).filter((m) => m.role !== 'owner');
    } catch {
      others = [];
    }
    if (!others.length) {
      void dialogs.alert('团队里还没有其他成员，先在「团队管理」页邀请成员后再移交所有权。', '无法移交');
      return;
    }
    const picked = await dialogs.choose({
      title: '移交所有权',
      message: <>选择「{teamName}」的新所有者。移交后你将变为管理员。</>,
      options: others.map((m) => ({
        label: `${m.name} · ${m.email ?? ''}`,
        value: m.id,
      })),
    });
    if (!picked) return;
    const target = others.find((m) => m.id === picked);
    if (!target) return;
    const ok = await dialogs.confirm({
      title: '确认移交',
      message: (
        <>
          确定把「{teamName}」的所有权移交给 <b>{target.email ?? target.name}</b> 吗？移交后你将成为管理员。
        </>
      ),
      confirmText: '移交',
    });
    if (!ok) return;
    try {
      await api.transferTeam(teamId, picked);
      await loadTeams();
      if (activeTeam === teamId) {
        api.listMembers(teamId).then((rows) => setMembers(Array.isArray(rows) ? rows : [])).catch(() => undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 删除团队（仅所有者可用）：项目与设计稿级联删除，删除后自动回退到剩余团队 */
  const removeCurrentTeam = async (t: Team) => {
    setSwitchOpen(false);
    const ok = await dialogs.confirm({
      title: '删除团队',
      message: (
        <>
          确定删除「{t.name}」吗？团队内的 <b>{t.project_count} 个项目</b>、全部设计稿与标注数据会一并删除，且不可恢复。
        </>
      ),
      confirmText: '删除团队',
    });
    if (!ok) return;
    try {
      await api.deleteTeam(t.id);
      await loadTeams();
      // 若删除的是当前团队，activeTeam 已不在列表中，既有兜底 effect 会自动切换
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 退出团队（管理员 / 协作者可用）：所有者需先移交或删除，后端会拒绝 */
  const leaveCurrentTeam = async (t: Team) => {
    setSwitchOpen(false);
    const ok = await dialogs.confirm({
      title: '退出团队',
      message: (
        <>
          确定退出「{t.name}」吗？退出后将无法再查看该团队的项目，需要重新被邀请才能回来。
        </>
      ),
      confirmText: '退出团队',
    });
    if (!ok) return;
    try {
      await api.leaveTeam(t.id);
      await loadTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 链接邀请：选好身份生成邀请链接，复制发给别人，对方点击链接登录后即可加入 */
  const createInviteLink = async () => {
    if (busy || !activeTeam) return;
    setBusy(true);
    setError('');
    try {
      const inv = await api.createInviteLink(activeTeam, memberRole);
      setInviteLink(inv);
      setInviteCopied(false);
      setInviteModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** 邮箱邀请：直接把邮箱加入团队成员，不发链接、不需要对方接受 */
  const addMemberByEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memberEmail.trim() || busy || !activeTeam) return;
    // 已是团队成员：不发必然失败的请求，直接在弹窗内给出明确提示
    if (duplicateMember) {
      setError(''); // 清掉旧版本可能残留的页面底部重复邀请红字
      setInviteError(
        `${memberEmail.trim()} 已是团队成员（${ROLE_LABEL[duplicateMember.role] ?? duplicateMember.role}），无需重复添加。如需调整身份，请在团队成员列表中点「编辑」。`
      );
      return;
    }
    setBusy(true);
    setError('');
    setInviteError('');
    try {
      await api.addMemberByEmail(activeTeam, memberEmail.trim(), memberRole);
      setMemberEmail('');
      setInviteError('');
      setInviteModal(false);
      // 直接刷新成员列表，新成员立即可见
      api
        .listMembers(activeTeam)
        .then((rows) => setMembers(Array.isArray(rows) ? rows : []))
        .catch(() => undefined);
    } catch (err) {
      // 409「该邮箱已在团队中」等错误必须显示在弹窗内，页面底部错误条会被遮住
      setInviteError(err instanceof Error ? err.message : String(err));
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
  // 昵称以登录账号 users.name 为准；未登录 / 未设昵称时回退邮箱（与改动前显示一致）
  const accountEmail = authUser?.email ?? identity?.email ?? '';
  const accountName = authUser?.name || accountEmail || '所有者';
  // 项目封面底色跟随画布底色（与编辑器同一个 localStorage 偏好），不再用透明棋盘格
  const coverBg = canvasBgColor(readCanvasBg());
  const coverDark = isDarkCanvas(coverBg);

  return (
    <div className="home-shell">
      {/* 邮箱未验证提示条（软验证：不阻断使用；可关闭，本次登录内不再提示） */}
      {authUser && authUser.verified === false && !verifyDismissed && (
        <div className="verify-banner">
          <span>📧 邮箱尚未验证，验证后可确保账号安全与找回密码。</span>
          <button onClick={resendVerification} disabled={resendState === 'cool'}>
            {resendState === 'cool' ? '请 1 分钟后再试' : resendState === 'sent' ? '已重新发送 ✓' : '重新发送验证邮件'}
          </button>
          <button
            type="button"
            className="verify-banner-close"
            title="本次登录不再提示"
            aria-label="关闭验证提示"
            onClick={dismissVerifyBanner}
          >
            <X />
          </button>
        </div>
      )}
      {/* 顶部状态栏：右侧身份头像（团队切换器已移入左侧栏顶部，侧栏从页面顶部贯通到底） */}
      <header className="home-topbar">
        <details className="avatar-menu" ref={avatarMenuRef}>
          <summary title="当前身份">
            <span className="avatar-dot" style={{ backgroundColor: avatarColor(avatarSeed) }}>{avatarSeed.slice(0, 1).toUpperCase()}</span>
          </summary>
          <div className="avatar-pop">
            <div className="avatar-pop-head">
              <span className="avatar-dot big" style={{ backgroundColor: avatarColor(avatarSeed) }}>{avatarSeed.slice(0, 1).toUpperCase()}</span>
              <div className="avatar-pop-info">
                <b title={accountName}>{accountName}</b>
                {accountEmail && accountEmail !== accountName && (
                  <span className="dim small">{accountEmail}</span>
                )}
                <div>
                  <span className={`role-badge ${identity?.role ?? myRole}`}>
                    {ROLE_LABEL[identity?.role ?? myRole] ?? '成员'}
                  </span>
                </div>
              </div>
            </div>
            <div className="avatar-menu-list">
              {authUser && (
                <button className="avatar-menu-item" onClick={openEditNickname}>
                  <Pencil /> 修改昵称
                </button>
              )}
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
              <p className="dim small avatar-pop-hint">可在「团队管理」页选择成员身份体验权限差异</p>
            )}
          </div>
        </details>
      </header>

      <div className="home-body">
      {/* 左侧边栏：顶部团队切换下拉框 + 导航，从页面顶部贯通到底 */}
      <aside className="home-sidebar">
        <details
          className="team-switch sidebar-team-switch"
          ref={teamSwitchRef}
          open={switchOpen}
          onToggle={(e) => setSwitchOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary title="切换团队">
            <BrandMark />
            <span className="team-switch-name">{activeTeamName ?? '当前团队'}</span>
            <span className="caret"><ChevronDown /></span>
          </summary>
          <div className="team-switch-pop">
            {teams.map((t) => {
              const role = t.my_role ?? (t.id === activeTeam ? myRole : null);
              return (
                <div key={t.id} className={`team-switch-row ${activeTeam === t.id ? 'active' : ''}`}>
                  <button
                    type="button"
                    className="team-switch-item"
                    onClick={() => {
                      switchTeam(t.id);
                      setView('projects');
                      setSwitchOpen(false);
                    }}
                  >
                    {t.name}
                  </button>
                  {role && (
                    <RowMenu
                      className="team-row-menu"
                      label={`团队 ${t.name}`}
                      items={
                        role === 'owner'
                          ? [
                              { label: '重命名', onClick: () => openRenameTeam(t) },
                              { label: '移交所有权', onClick: () => void openTransferTeam(t.id, t.name) },
                              { label: '删除团队', onClick: () => void removeCurrentTeam(t) },
                            ]
                          : role === 'admin'
                            ? [
                                { label: '重命名', onClick: () => openRenameTeam(t) },
                                { label: '退出团队', onClick: () => void leaveCurrentTeam(t) },
                              ]
                            : [{ label: '退出团队', onClick: () => void leaveCurrentTeam(t) }]
                      }
                    />
                  )}
                </div>
              );
            })}
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
            <Users /> 团队管理
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
                    <h1>项目</h1>
                  </div>
                  <button type="button" className="new-project-btn" onClick={openCreateProject}>
                    <Plus /> 新建项目
                  </button>
                </div>
              </header>

              {/* 列表 Tab：全部项目 / 最近使用 / 最近更新 */}
              <div className="project-tabs" role="tablist" aria-label="项目筛选">
                {(
                  [
                    ['all', '全部项目'],
                    ['viewed', '最近使用'],
                    ['updated', '最近更新'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={projectTab === key}
                    className={`project-tab ${projectTab === key ? 'active' : ''}`}
                    onClick={() => setProjectTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <ul className="project-grid">
                {visibleProjects.length === 0 && (
                  <p className="empty">
                    {projectTab === 'viewed' ? '暂无浏览记录，进入项目后会出现在这里' : '暂无项目'}
                  </p>
                )}
                {visibleProjects.map((p) => (
                  <li key={p.id} className="project-card-wrap">
                    <button
                      className="file-card project-card"
                      onClick={() => {
                        recordProjectView(p.id);
                        navigate(`/projects/${p.id}`);
                      }}
                    >
                      <span
                        className={`project-cover ${coverDark ? 'is-dark-canvas' : ''}`}
                        style={{ background: coverBg }}
                      >
                        {p.cover_frames && p.cover_frames.length > 0 ? (
                          <ProjectCover frames={p.cover_frames} />
                        ) : p.cover ? (
                          <img className="project-cover-single" src={p.cover} alt={p.name} loading="lazy" />
                        ) : null}
                      </span>
                      <span className="file-name"><ProjectMark /> {p.name}</span>
                      <span className="file-meta">
                        最后更新{' '}
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
            <div className="team-view">
              <header className="view-header">
                <div className="view-header-row">
                  <div className="view-header-text">
                    <h1>团队管理</h1>
                  </div>
                  {canManage && (
                    <button type="button" className="new-project-btn" onClick={() => { setError(''); setInviteError(''); setInviteModal(true); }}>
                      <Mail /> 邀请成员
                    </button>
                  )}
                </div>
              </header>

              {/* 搜索昵称/邮箱 + 按角色筛选：与成员列表同宽，顶部「邀请成员」按钮位置不变 */}
              <div className="member-toolbar">
                <div className="member-search">
                  <Search size={15} />
                  <input
                    type="search"
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    placeholder="搜索昵称或邮箱"
                    aria-label="搜索成员"
                  />
                  {memberQuery && (
                    <button
                      type="button"
                      className="member-search-clear"
                      onClick={() => setMemberQuery('')}
                      title="清空搜索"
                      aria-label="清空搜索"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <div className="member-toolbar-right">
                  {/* 与全站下拉按钮统一风格：隐藏原生黑色三角，改用 Lucide 线性 ChevronDown */}
                  <span className="member-role-filter-wrap">
                    <select
                      className="member-role-filter"
                      value={memberRoleFilter}
                      onChange={(e) => setMemberRoleFilter(e.target.value as 'all' | 'owner' | 'admin' | 'collaborator')}
                      aria-label="按角色筛选"
                    >
                      <option value="all">全部角色</option>
                      <option value="owner">{ROLE_LABEL.owner}</option>
                      <option value="admin">{ROLE_LABEL.admin}</option>
                      <option value="collaborator">{ROLE_LABEL.collaborator}</option>
                    </select>
                    <ChevronDown />
                  </span>
                  <span className="dim small member-count">
                    {isMemberFiltering
                      ? `显示 ${filteredMembers.length} / ${members.length} 位成员`
                      : `共 ${members.length} 位成员`}
                  </span>
                </div>
              </div>

              {canManage && inviteLink && (
                <div className="invite-link-box">
                  <span className="small dim">
                    {inviteLink.email
                      ? `已向 ${inviteLink.email} 发送邀请邮件（${ROLE_LABEL[inviteLink.role] ?? inviteLink.role}，7 天有效）。对方也可通过链接接受：`
                      : `已生成邀请链接（${ROLE_LABEL[inviteLink.role] ?? inviteLink.role}，7 天内有效，可发给多人）。对方点击链接登录后即可加入：`}
                  </span>
                  <code className="invite-link-url">{inviteLink.inviteUrl}</code>
                  <button type="button" onClick={() => void copyInviteLink()}>
                    {inviteCopied ? '已复制 ✓' : '复制链接'}
                  </button>
                </div>
              )}
              {!canManage && (
                <p className="empty">你是协作者身份，仅可查看设计稿；邀请与管理成员需要管理员权限</p>
              )}

              <ul className="member-list">
                {members.length === 0 && <p className="empty">还没有成员，点击右上角「邀请成员」邀请第一个吧</p>}
                {members.length > 0 && filteredMembers.length === 0 && (
                  <p className="empty">
                    没有匹配的成员
                    <button
                      type="button"
                      className="member-filter-reset"
                      onClick={() => { setMemberQuery(''); setMemberRoleFilter('all'); }}
                    >
                      清空筛选
                    </button>
                  </p>
                )}
                {filteredMembers.map((m) => (
                  <li key={m.id} className="member-row">
                    <span className="member-avatar">{(m.name || m.email || '?').slice(0, 1).toUpperCase()}</span>
                    <div className="member-info">
                      <span className="member-name">
                        {m.name || m.email || '未命名成员'}
                      </span>
                      <span className="dim small">
                        {m.email && m.email !== m.name ? `${m.email} · ` : ''}加入于 {new Date(m.created_at).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                    <span className={`role-badge ${m.role}`}>{ROLE_LABEL[m.role] ?? m.role}</span>
                    {canManage && m.email && m.role !== 'owner' && (
                      <button
                        className="member-action"
                        onClick={() => {
                          const email = m.email!;
                          const role = m.role === 'admin' ? 'admin' : 'collaborator';
                          setRoleDraft(role);
                          setRoleModal({ id: m.id, email, role });
                        }}
                        title="编辑该成员身份（角色）"
                      >
                        <Pencil size={14} /> 编辑身份
                      </button>
                    )}
                    {canManage && m.role !== 'owner' && (
                      <button className="member-action" onClick={() => setRemoveModal({ id: m.id, email: m.email ?? '该成员' })} title="移除该成员">
                        <Trash2 size={14} /> 移除
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
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

      {/* 邀请成员弹窗：链接邀请（复制链接发给别人）/ 邮箱邀请（直接加入成员） */}
      {inviteModal && (
        <div className="dlg-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setInviteModal(false); }}>
          <form
            className="dlg invite-modal"
            role="dialog"
            aria-modal="true"
            aria-label="邀请成员"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setInviteModal(false); } }}
            onSubmit={(e) => {
              e.preventDefault();
              if (inviteMode === 'email') void addMemberByEmail(e);
              else void createInviteLink();
            }}
          >
            <h2 className="dlg-title">邀请成员 · {activeTeamName}</h2>
            <div className="invite-mode-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={inviteMode === 'link'}
                className={inviteMode === 'link' ? 'is-active' : ''}
                onClick={() => { setInviteError(''); setInviteMode('link'); }}
              >
                链接邀请
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inviteMode === 'email'}
                className={inviteMode === 'email' ? 'is-active' : ''}
                onClick={() => { setInviteError(''); setInviteMode('email'); }}
              >
                邮箱邀请
              </button>
            </div>
            {inviteMode === 'link' ? (
              <>
                <label className="dlg-label" htmlFor="invite-role-link">邀请身份</label>
                <select
                  id="invite-role-link"
                  className="dlg-input"
                  value={memberRole}
                  onChange={(e) => setMemberRole(e.target.value as 'admin' | 'collaborator')}
                >
                  <option value="collaborator">协作 · 只读</option>
                  <option value="admin">管理员（可编辑、可邀请）</option>
                </select>
                <p className="dim small">复制链接发给对方，对方点击链接登录后即以此身份加入团队；链接 7 天内有效，可发给多人。</p>
                <div className="dlg-actions">
                  <button type="button" className="dlg-btn" onClick={() => setInviteModal(false)}>取消</button>
                  <button type="submit" className="dlg-btn is-primary" disabled={busy}>
                    {busy ? '生成中…' : '生成邀请链接'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="dlg-label" htmlFor="invite-email">对方邮箱</label>
                <input
                  id="invite-email"
                  className="dlg-input"
                  type="email"
                  value={memberEmail}
                  autoFocus
                  onChange={(e) => { setMemberEmail(e.target.value); setInviteError(''); }}
                  placeholder="如 design@company.com"
                  maxLength={120}
                />
                <label className="dlg-label" htmlFor="invite-role-email">邀请身份</label>
                <select
                  id="invite-role-email"
                  className="dlg-input"
                  value={memberRole}
                  onChange={(e) => setMemberRole(e.target.value as 'admin' | 'collaborator')}
                >
                  <option value="collaborator">协作 · 只读</option>
                  <option value="admin">管理员（可编辑、可邀请）</option>
                </select>
                {inviteError ? (
                  <p className="invite-dup-hint is-error" role="alert">{inviteError}</p>
                ) : duplicateMember ? (
                  <p className="invite-dup-hint" role="status">
                    {memberEmail.trim()} 已是团队成员（{ROLE_LABEL[duplicateMember.role] ?? duplicateMember.role}），无需重复添加；如需调整身份，请在团队成员列表中点「编辑」。
                  </p>
                ) : (
                  <p className="dim small">对方将被直接加入团队成员并立即生效，不发送邮件、不需要对方点击链接接受。</p>
                )}
                <div className="dlg-actions">
                  <button type="button" className="dlg-btn" onClick={() => setInviteModal(false)}>取消</button>
                  <button type="submit" className="dlg-btn is-primary" disabled={busy || !memberEmail.trim()}>
                    {busy ? '添加中…' : '直接加入成员'}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}

      {/* 编辑成员身份弹窗：不在角色徽章上直接编辑，弹窗内选择后点保存才提交 */}
      {roleModal && (
        <div className="dlg-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setRoleModal(null); }}>
          <form
            className="dlg invite-modal"
            role="dialog"
            aria-modal="true"
            aria-label="编辑成员身份"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRoleModal(null); } }}
            onSubmit={(e) => {
              e.preventDefault();
              const target = roleModal;
              setRoleModal(null);
              if (target && roleDraft !== target.role) void changeRole(target.id, roleDraft);
            }}
          >
            <h2 className="dlg-title">编辑成员身份</h2>
            <p className="dim small" style={{ margin: 0 }}>{roleModal.email}</p>
            <label className="dlg-label" htmlFor="role-modal-select">身份权限</label>
            <select
              id="role-modal-select"
              className="dlg-input"
              value={roleDraft}
              autoFocus
              onChange={(e) => setRoleDraft(e.target.value as 'admin' | 'collaborator')}
            >
              <option value="collaborator">协作 · 只读</option>
              <option value="admin">管理员（可编辑、可邀请）</option>
            </select>
            <div className="dlg-actions">
              <button type="button" className="dlg-btn" onClick={() => setRoleModal(null)}>取消</button>
              <button type="submit" className="dlg-btn is-primary">保存</button>
            </div>
          </form>
        </div>
      )}

      {/* 移除成员确认弹窗：防止误点直接移除，确认后才调用接口 */}
      {removeModal && (
        <div className="dlg-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setRemoveModal(null); }}>
          <div
            className="dlg invite-modal"
            role="dialog"
            aria-modal="true"
            aria-label="移除成员确认"
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRemoveModal(null); } }}
          >
            <h2 className="dlg-title">移除成员</h2>
            <p className="dim small" style={{ margin: 0 }}>
              确定要将 <b style={{ color: 'var(--text)' }}>{removeModal.email}</b> 从团队移除吗？移除后该成员将无法访问此团队的项目与设计稿。
            </p>
            <div className="dlg-actions" style={{ marginTop: 18 }}>
              <button type="button" className="dlg-btn" onClick={() => setRemoveModal(null)}>取消</button>
              <button type="button" className="dlg-btn is-danger" autoFocus onClick={() => {
                const target = removeModal;
                setRemoveModal(null);
                if (target) void removeMember(target.id);
              }}>确认移除</button>
            </div>
          </div>
        </div>
      )}

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
