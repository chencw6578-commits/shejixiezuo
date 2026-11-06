import type { ExportResult, FileDetail, FrameDetail, ProjectFrameRow, SpecData } from './types';

export interface Member {
  id: string;
  team_id: string;
  name: string;
  email: string | null;
  role: 'admin' | 'collaborator';
  created_at: string;
}

export interface Identity {
  email: string;
  role: 'admin' | 'collaborator';
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

export const api = {
  importFile: (url: string, projectId?: string) =>
    request<{ id: string; name: string }>('/api/files', {
      method: 'POST',
      body: JSON.stringify({ url, projectId }),
    }),

  /** 上传 .sketch / .psd 文件导入（可指定所属项目） */
  uploadDesign: async (file: File, projectId?: string): Promise<{ id: string; name: string }> => {
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

  // ---- 团队 ----
  listTeams: () =>
    request<{ id: string; name: string; project_count: string; created_at: string }[]>('/api/teams'),
  createTeam: (name: string) =>
    request<{ id: string; name: string }>('/api/teams', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteTeam: (id: string) => request<{ deleted: boolean }>(`/api/teams/${id}`, { method: 'DELETE' }),

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

  // ---- 项目 ----
  listProjects: (teamId?: string) =>
    request<{ id: string; name: string; file_count: string; created_at: string; last_file_at: string | null; cover: string | null }[]>(
      `/api/projects${teamId ? `?teamId=${teamId}` : ''}`
    ),
  createProject: (name: string, teamId?: string) =>
    request<{ id: string; name: string }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, teamId }),
    }),
  getProject: (id: string) =>
    request<{ id: string; name: string; team_id: string | null; team_name: string | null }>(`/api/projects/${id}`),
  /** 项目画板总览：所有设计稿的全部画板（项目画板页用） */
  listProjectFrames: (projectId: string) =>
    request<ProjectFrameRow[]>(`/api/projects/${projectId}/frames`),
  deleteProject: (id: string) => request<{ deleted: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

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

  download: (url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
};
