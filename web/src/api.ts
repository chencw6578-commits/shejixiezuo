import type { ExportResult, FileDetail, FrameDetail, ProjectFrameRow, SpecData } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
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

  // ---- 团队 ----
  listTeams: () =>
    request<{ id: string; name: string; project_count: string; created_at: string }[]>('/api/teams'),
  createTeam: (name: string) =>
    request<{ id: string; name: string }>('/api/teams', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteTeam: (id: string) => request<{ deleted: boolean }>(`/api/teams/${id}`, { method: 'DELETE' }),

  // ---- 项目 ----
  listProjects: (teamId?: string) =>
    request<{ id: string; name: string; file_count: string; created_at: string; last_file_at: string | null }[]>(
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
