import type { ExportResult, FileDetail, FrameDetail, FrameLink, ProjectFrameRow, ProjectPageRow, SpecData } from './types';

/** 项目卡片封面用：一张画板的缩略图与原始尺寸 */
export interface ProjectCoverFrame {
  name: string;
  thumb_url: string | null;
  width: number;
  height: number;
}

/** 公开只读分享：登录态的开关状态 */
export interface ShareState {
  active: boolean;
  url: string | null;
}

/** 公开只读分享页：后端只返回展示所需的白名单字段 */
export interface SharedFrame {
  id: string;
  file_id: string;
  name: string;
  file_name: string;
  page_name: string | null;
  width: number;
  height: number;
  thumb_url: string | null;
}

export interface SharedProject {
  project: { id: string; name: string };
  frames: SharedFrame[];
}

export interface Member {
  id: string;
  team_id: string;
  name: string;
  email: string | null;
  role: 'owner' | 'admin' | 'collaborator';
  created_at: string;
}

export interface Identity {
  email: string;
  role: 'owner' | 'admin' | 'collaborator';
}

/** 导入令牌（明文只在创建响应里出现一次） */
export interface ImportToken {
  id: string;
  prefix: string;
  /** all=创建该令牌的账号下全部团队；team=仅创建时的团队 */
  scope: 'all' | 'team';
  created_at: string;
  last_used_at: string | null;
}

// ---------- 身份（协作者只读 / 管理员可编辑可删除） ----------
const IDENTITY_KEY = 'dh.identity';
let activeTeamId = '';

/** 页面挂载时设置当前上下文团队，后续请求自动携带该团队的成员身份头 */
export function setActiveTeam(teamId: string | null | undefined) {
  activeTeamId = teamId ?? '';
}

function readIdentities(): Record<string, Identity> {
  try {
    return JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? '{}') as Record<string, Identity>;
  } catch {
    return {};
  }
}

/** 当前团队身份；null = 所有者（最高权限） */
export function getActiveIdentity(): Identity | null {
  return readIdentities()[activeTeamId] ?? null;
}

/** 指定团队身份（不依赖 activeTeam 上下文） */
export function getIdentity(teamId: string): Identity | null {
  return readIdentities()[teamId] ?? null;
}

export function setIdentity(teamId: string, identity: Identity | null) {
  const map = readIdentities();
  if (identity) map[teamId] = identity;
  else delete map[teamId];
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(map));
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const email = getActiveIdentity()?.email;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body && !(typeof FormData !== 'undefined' && init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(email ? { 'X-Member-Email': email } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `请求失败 (${res.status})`);
  }
  return data as T;
}

/**
 * 大文件直传（Vercel Serverless 请求体硬上限 4.5MB）。
 * 先向后端申请一个「只能 PUT 到指定 key」的预签名 URL，浏览器把文件直接送到
 * 对象存储，再只把 key 交给后端解析。常驻部署 / 预签名不可用时返回 null，
 * 前端自动回退原来的 multipart 上传，行为完全不变。
 */
interface DirectUpload {
  key: string;
  contentType: string;
}

async function directUpload(file: File): Promise<DirectUpload | null> {
  // 设计稿各浏览器给出的 MIME 五花八门，统一按二进制流签名；
  // 图片保留真实类型（后续入库要按扩展名落盘），JSON 单独标识。
  const contentType = /^image\/(png|jpeg|webp|gif)$/i.test(file.type)
    ? file.type
    : file.type === 'application/json'
      ? 'application/json'
      : 'application/octet-stream';
  const q = new URLSearchParams({ filename: file.name || 'upload.bin', contentType });
  let pre: {
    mode: string;
    uploadUrl?: string;
    key?: string;
    contentType?: string;
    token?: string;
  };
  try {
    pre = await request(`/api/upload/presign?${q.toString()}`);
  } catch {
    return null;
  }

  // Vercel Blob：服务端签发受限令牌，浏览器直接 PUT 到 Blob（文件不经过函数，
  // 因此不受 4.5MB 请求体上限约束）；大文件由 SDK 自动分片。
  if (pre.mode === 'blob' && pre.token && pre.key) {
    try {
      const { put } = await import('@vercel/blob/client');
      await put(pre.key, file, {
        access: 'public',
        token: pre.token,
        contentType: pre.contentType ?? contentType,
        multipart: true,
      });
      return { key: pre.key, contentType: pre.contentType ?? contentType };
    } catch (err) {
      console.warn('[upload] Blob 直传失败，回退普通上传:', err);
      return null;
    }
  }

  if (pre.mode !== 'direct' || !pre.uploadUrl || !pre.key) return null;
  const put = await fetch(pre.uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': pre.contentType ?? contentType },
  });
  if (!put.ok) {
    // 对象存储 CORS / 凭据未配好时不要让上传功能整体失效：
    // 回退到原 multipart 路径（小文件仍可用，大文件会由平台返回明确的 413）。
    console.warn('[upload] 直传失败，回退普通上传:', put.status, '（请检查对象存储 CORS 与凭据）');
    return null;
  }
  return { key: pre.key, contentType: pre.contentType ?? contentType };
}

export interface CommentItem {
  id: string;
  frame_id: string;
  parent_id: string | null;
  node_id: string | null;
  x: number | null;
  y: number | null;
  author: string;
  body: string;
  resolved: boolean;
  created_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  verified?: boolean;
}

/** 邮箱验证提示条的「本次登录不再提示」标记（sessionStorage；登录成功时由 LoginPage 清除） */
export const VERIFY_BANNER_DISMISS_KEY = 'shejixiezuo:verify-banner-dismissed';

/**
 * 首屏里 Protected 守卫与 HomePage 会各调一次 /api/auth/me（实测 2 次 RTT）。
 * 2 秒内复用上一次成功结果；失败绝不缓存，登出 / 登录 / 注册 / 改昵称立即失效，
 * 避免会话切换后旧身份残留。TTL 很短，不影响跨页面导航时的重新校验。
 */
let meCache: { at: number; user: AuthUser } | null = null;
const invalidateMe = () => { meCache = null; };

/**
 * 同步读取已缓存的当前用户，供页面挂载首帧初始化身份 UI（顶栏头像等）。
 * 解决「进项目详情再返回首页，头像先闪一秒兜底字再变真实头像」的问题：
 * 返回时 api.me() 的异步结果要几百毫秒才到，此前用缓存同步渲染即可。
 * 不受 2s TTL 限制——TTL 只决定是否向服务端重新校验，缓存数据在会话内是权威的；
 * 会话切换（login/logout/register/updateMe）会走 invalidateMe 清空，不会残留旧身份。
 */
export const getMeCached = (): AuthUser | null => meCache?.user ?? null;

export const api = {
  // ---------- 登录注册 ----------
  register: async (email: string, password: string, name?: string) => {
    const user = await request<AuthUser>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
    invalidateMe();
    return user;
  },

  login: async (email: string, password: string) => {
    const user = await request<AuthUser>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    invalidateMe();
    return user;
  },

  logout: async () => {
    try {
      return await request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
    } finally {
      invalidateMe();
    }
  },

  me: () => {
    if (meCache && Date.now() - meCache.at < 2000) return Promise.resolve(meCache.user);
    return request<AuthUser>('/api/auth/me').then((user) => {
      meCache = { at: Date.now(), user };
      return user;
    });
  },

  /** 修改当前账号昵称（users.name 为头像下拉与团队成员列表共用的唯一真源） */
  updateMe: async (name: string) => {
    const user = await request<AuthUser>('/api/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    invalidateMe();
    return user;
  },

  /** 邮箱验证：邮件链接落地后凭 token 核验 */
  verifyEmail: (token: string) =>
    request<{ ok: boolean }>('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  /** 重发验证邮件；登录态可不传邮箱（未登录传邮箱，响应恒为成功文案，防探测） */
  resendVerification: (email?: string) =>
    request<{ ok: boolean }>('/api/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  /** 忘记密码：发送重置邮件（响应恒为成功文案，防探测） */
  forgotPassword: (email: string) =>
    request<{ ok: boolean }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  /** 重置密码：邮件链接落地后凭 token 设置新密码 */
  resetPassword: (token: string, password: string) =>
    request<{ ok: boolean }>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),

  // ---------- 团队邀请 ----------
  /** 链接邀请（owner/admin）：生成不绑定邮箱的邀请链接（明文 token 仅此一次），7 天内可多人使用 */
  createInviteLink: (teamId: string, role: 'admin' | 'collaborator') =>
    request<{ id: string; role: string; expires_at: string; inviteUrl: string }>(
      `/api/teams/${teamId}/invites`,
      { method: 'POST', body: JSON.stringify({ mode: 'link', role }) }
    ),

  /** 邮箱邀请（owner/admin）：把邮箱直接加入团队成员，不发邮件不需要对方接受 */
  addMemberByEmail: (teamId: string, email: string, role: 'admin' | 'collaborator') =>
    request<{ mode: 'email'; member: { id: string; name: string; email: string; role: string; created_at: string } }>(
      `/api/teams/${teamId}/invites`,
      { method: 'POST', body: JSON.stringify({ mode: 'email', email, role }) }
    ),

  /** 邀请落地页信息（公开）；链接邀请时 email 为 null */
  inviteInfo: (token: string) =>
    request<{ teamName: string; email: string | null; role: string }>(`/api/invites/info?token=${encodeURIComponent(token)}`),

  /** 接受邀请（需登录；链接邀请任何登录用户可接受，邮箱邀请须邮箱一致） */
  acceptInvite: (token: string) =>
    request<{ ok: boolean; teamId: string; teamName: string; role: string }>('/api/invites/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  /** 服务端是否配置了统一 Figma 令牌（只看 true/false，不含令牌本身） */
  figmaImportStatus: () => request<{ configured: boolean }>('/api/import/figma/status'),

  importFile: (url: string, projectId?: string, token?: string) =>
    request<{ id: string; name: string; nodeId?: string | null; frameCount?: number }>('/api/files', {
      method: 'POST',
      body: JSON.stringify({ url, projectId, token: token?.trim() || undefined }),
    }),

  /** 导入 Figma 插件导出的 JSON（服务端不调用 Figma REST，不受限流影响） */
  importFigmaJson: async (
    json: string | object,
    projectId?: string
  ): Promise<{ id: string; name: string; frameCount: number; nodeCount: number; skipped: number }> => {
    const text = typeof json === 'string' ? json : JSON.stringify(json);
    const direct = await directUpload(
      new File([text], 'figma-export.json', { type: 'application/json' })
    );
    if (direct) {
      return request('/api/import/figma-json/from-storage', {
        method: 'POST',
        body: JSON.stringify({ key: direct.key, projectId }),
      });
    }
    return request('/api/import/figma-json', {
      method: 'POST',
      body: JSON.stringify({ json, projectId }),
    });
  },

  /** 上传 .sketch / .psd 文件导入（可指定所属项目） */
  uploadDesign: async (file: File, projectId?: string): Promise<{ id: string; name: string }> => {
    const direct = await directUpload(file);
    if (direct) {
      return request('/api/upload/from-storage', {
        method: 'POST',
        body: JSON.stringify({ key: direct.key, filename: file.name, projectId }),
      });
    }
    const fd = new FormData();
    fd.append('file', file);
    if (projectId) fd.append('projectId', projectId);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `上传失败 (${res.status})`);
    return data as { id: string; name: string };
  },

  /** 粘贴图片导入：一张图 = 一个画板 */
  uploadImage: async (
    file: File,
    projectId?: string,
    width = 0,
    height = 0
  ): Promise<{ id: string; name: string }> => {
    const direct = await directUpload(file);
    if (direct) {
      return request('/api/upload/image/from-storage', {
        method: 'POST',
        body: JSON.stringify({
          key: direct.key,
          filename: file.name || 'clip.png',
          contentType: direct.contentType,
          projectId,
          width,
          height,
        }),
      });
    }
    const fd = new FormData();
    fd.append('file', file);
    if (projectId) fd.append('projectId', projectId);
    fd.append('width', String(width));
    fd.append('height', String(height));
    const res = await fetch('/api/upload/image', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `导入失败 (${res.status})`);
    return data as { id: string; name: string };
  },

  /** 解析 Figma 图层剪贴板中的 figmeta（fileKey/fileName），引导走 API 导入 */
  parseFigmaClipboard: (html: string) =>
    request<{ fileKey: string; fileName: string; url: string }>('/api/upload/figma-clipboard', {
      method: 'POST',
      body: JSON.stringify({ html }),
    }),

  getComments: (frameId: string) => request<CommentItem[]>(`/api/comments/frames/${frameId}`),

  addComment: (
    frameId: string,
    body: { author: string; body: string; nodeId?: string; x?: number; y?: number }
  ) =>
    request<CommentItem>(`/api/comments/frames/${frameId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  replyComment: (id: string, body: { author: string; body: string }) =>
    request<CommentItem>(`/api/comments/${id}/replies`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  resolveComment: (id: string, resolved: boolean) =>
    request<{ id: string; resolved: boolean }>(`/api/comments/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolved }),
    }),

  deleteComment: (id: string) => request<{ ok: boolean }>(`/api/comments/${id}`, { method: 'DELETE' }),

  listFiles: (projectId?: string) =>
    request<FileDetail[]>(`/api/files${projectId ? `?projectId=${projectId}` : ''}`),

  /** 配置/清除图层「原型交互：跳转到目标画板」 */
  setInteraction: (fileId: string, nodeId: string, targetFrameId: string | null) =>
    request<{ ok: boolean }>(`/api/files/${fileId}/nodes/${nodeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ interaction: targetFrameId ? { targetFrameId } : null }),
    }),

  /** 写回文本图层的内容（props.text.content） */
  setNodeText: (fileId: string, nodeId: string, text: string) =>
    request<{ ok: true }>(`/api/files/${fileId}/nodes/${nodeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    }),

  // ---- 页面（画板编组） ----
  createPage: (fileId: string, name: string, parentPageId?: string | null) =>
    request<{ id: string; name: string }>(`/api/files/${fileId}/pages`, {
      method: 'POST',
      body: JSON.stringify({ name, parentPageId: parentPageId ?? null }),
    }),
  renamePage: (fileId: string, pageId: string, name: string) =>
    request<{ id: string; name: string }>(`/api/files/${fileId}/pages/${pageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  deletePage: (fileId: string, pageId: string, mode: 'dissolve' | 'content' = 'dissolve') =>
    request<{ ok: boolean; deletedFrames?: number }>(
      `/api/files/${fileId}/pages/${pageId}${mode === 'content' ? '?mode=content' : ''}`,
      { method: 'DELETE' }
    ),
  moveFrameToPage: (fileId: string, frameId: string, pageId: string | null) =>
    request<{ ok: boolean }>(`/api/files/${fileId}/frames/${frameId}/page`, {
      method: 'PATCH',
      body: JSON.stringify({ pageId }),
    }),
  /** 批量移入编组（追加到末尾；pageId 传 null 移出为未分组） */
  moveFramesToPage: (fileId: string, frameIds: string[], pageId: string | null) =>
    request<{ ok: boolean; moved: number }>(`/api/files/${fileId}/frames/page`, {
      method: 'PATCH',
      body: JSON.stringify({ frameIds, pageId }),
    }),
  /** 保存画布自由坐标 */
  setFramePositions: (fileId: string, positions: { id: string; x: number; y: number }[]) =>
    request<{ ok: boolean; saved: number }>(`/api/files/${fileId}/frames/position`, {
      method: 'PATCH',
      body: JSON.stringify({ positions }),
    }),
  /** 编组内排序：frameIds 为目标编组的完整顺序（同时完成跨组移动） */
  reorderFrames: (fileId: string, pageId: string | null, frameIds: string[]) =>
    request<{ ok: boolean; ordered: number }>(`/api/files/${fileId}/frames/order`, {
      method: 'PATCH',
      body: JSON.stringify({ frameIds, pageId }),
    }),

  renameFile: (fileId: string, name: string) =>
    request<{ id: string; name: string }>(`/api/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  renameFrame: (fileId: string, frameId: string, name: string) =>
    request<{ id: string; name: string }>(`/api/files/${fileId}/frames/${frameId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  /** 删除画板（级联删除其图层与评论） */
  deleteFrame: (fileId: string, frameId: string) =>
    request<{ ok: true }>(`/api/files/${fileId}/frames/${frameId}`, { method: 'DELETE' }),

  /** 批量删除同一设计稿内的画板；跨设计稿请按 file_id 分组分别调用 */
  deleteFrames: (fileId: string, ids: string[]) =>
    request<{ ok: true; deleted: number }>(`/api/files/${fileId}/frames`, {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }),

  // ---- 团队 ----
  listTeams: () =>
    request<{ id: string; name: string; project_count: string; created_at: string; my_role: 'owner' | 'admin' | 'collaborator' | null }[]>('/api/teams'),
  createTeam: (name: string) =>
    request<{ id: string; name: string }>('/api/teams', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteTeam: (id: string) => request<{ deleted: boolean }>(`/api/teams/${id}`, { method: 'DELETE' }),
  renameTeam: (id: string, name: string) =>
    request<{ id: string; name: string }>(`/api/teams/${id}/rename`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  transferTeam: (id: string, memberId: string) =>
    request<{ transferred: boolean }>(`/api/teams/${id}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ memberId }),
    }),
  leaveTeam: (id: string) => request<{ left: boolean }>(`/api/teams/${id}/leave`, { method: 'POST' }),

  // ---- 团队成员（邮箱邀请 / 角色） ----
  listMembers: (teamId: string) => request<Member[]>(`/api/teams/${teamId}/members`),
  /** 邮箱邀请成员：role 'admin'=管理员（可编辑可删除）/'collaborator'=协作者（只读） */
  addMember: (teamId: string, email: string, role: 'admin' | 'collaborator') =>
    request<Member>(`/api/teams/${teamId}/members`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),
  updateMemberRole: (teamId: string, memberId: string, role: 'admin' | 'collaborator') =>
    request<Member>(`/api/teams/${teamId}/members/${memberId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  removeMember: (teamId: string, memberId: string) =>
    request<{ deleted: boolean }>(`/api/teams/${teamId}/members/${memberId}`, { method: 'DELETE' }),

  // ---- 团队导入令牌（Figma 插件用，服务端只存哈希） ----
  listImportTokens: (teamId: string) => request<ImportToken[]>(`/api/teams/${teamId}/import-tokens`),
  createImportToken: (teamId: string, scope: ImportToken['scope'] = 'all') =>
    request<ImportToken & { token: string }>(`/api/teams/${teamId}/import-tokens`, {
      method: 'POST',
      body: JSON.stringify({ scope }),
    }),
  revokeImportToken: (teamId: string, tokenId: string) =>
    request<{ deleted: boolean }>(`/api/teams/${teamId}/import-tokens/${tokenId}`, { method: 'DELETE' }),

  // ---- 项目 ----
  listProjects: (teamId?: string) =>
    request<{ id: string; name: string; file_count: string; created_at: string; last_file_at: string | null; cover: string | null; cover_frames: ProjectCoverFrame[] | null }[]>(
      `/api/projects${teamId ? `?teamId=${teamId}` : ''}`
    ),
  createProject: (name: string, teamId?: string) =>
    request<{ id: string; name: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, teamId }),
    }),
  getProject: (id: string) =>
    request<{ id: string; name: string; team_id: string | null; team_name: string | null }>(`/api/projects/${id}`),
  /** 项目画板总览：所有设计稿的全部画板 + 编组（项目画板页用） */
  listProjectFrames: (projectId: string) =>
    request<{ frames: ProjectFrameRow[]; pages: ProjectPageRow[] }>(`/api/projects/${projectId}/frames`),
  listFrameLinks: (projectId: string) =>
    request<FrameLink[]>(`/api/projects/${projectId}/links`),
  createFrameLink: (projectId: string, from: string, to: string, side: 'top' | 'right' | 'bottom' | 'left' = 'right') =>
    request<FrameLink>(`/api/projects/${projectId}/links`, {
      method: 'POST',
      body: JSON.stringify({ from, to, side }),
    }),
  deleteFrameLink: (projectId: string, linkId: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/links/${linkId}`, { method: 'DELETE' }),
  deleteProject: (id: string) => request<{ deleted: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  // ---------- 公开只读分享 ----------
  shareStatus: (projectId: string) =>
    request<ShareState>(`/api/share/projects/${projectId}`),
  enableShare: (projectId: string) =>
    request<ShareState>(`/api/share/projects/${projectId}`, { method: 'POST' }),
  disableShare: (projectId: string) =>
    request<ShareState>(`/api/share/projects/${projectId}`, { method: 'DELETE' }),
  /** 公开接口：不需要登录，token 直接写在路径里 */
  getSharedProject: (token: string) =>
    request<SharedProject>(`/api/share/${encodeURIComponent(token)}`),

  getFile: (id: string) => request<FileDetail>(`/api/files/${id}`),

  deleteFile: (id: string) => request<{ ok: boolean }>(`/api/files/${id}`, { method: 'DELETE' }),

  getFrame: (fileId: string, frameId: string) =>
    request<FrameDetail>(`/api/files/${fileId}/frames/${frameId}`),

  exportAsset: (body: {
    fileId: string;
    nodeId: string;
    name?: string;
    format: string;
    scale: number;
  }) =>
    request<ExportResult>('/api/assets/export', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  syncFile: (id: string) =>
    request<{ updated: boolean }>(`/api/files/${id}/sync`, { method: 'POST' }),

  getSpec: (id: string) => request<SpecData>(`/api/files/${id}/spec`),

  /** 批量切图：返回 zip Blob 并触发下载 */
  exportZip: async (body: {
    fileId: string;
    frameId: string;
    mode: 'presets' | 'all';
    format?: string;
    scale?: number;
  }): Promise<void> => {
    const res = await fetch('/api/assets/export-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error ?? `导出失败 (${res.status})`);
    }
    const blob = await res.blob();
    const name =
      decodeURIComponent(
        res.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/)?.[1] ?? 'slices.zip'
      );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  },

  /**
   * 下载单张切图：先取回内存，再用同源 blob: URL 触发保存。
   *
   * 切图存在 Vercel Blob（跨源），跨源 URL 上的 <a download> 会被浏览器忽略；
   * 而 Blob 响应是 Content-Disposition: inline，于是变成在窗口里打开图片。
   * 线上 Blob 实测带 Access-Control-Allow-Origin: *，可直接 fetch，无需改后端。
   */
  download: async (url: string, filename: string): Promise<void> => {
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw new Error('切图文件读取失败：请检查网络或跨域设置后重试');
    }
    if (!res.ok) throw new Error(`切图下载失败 (${res.status})`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      // 不能立刻 revoke：部分浏览器要等下载任务取完 blob 数据才安全
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
  },
};
