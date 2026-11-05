import type { ExportResult, FileDetail, FrameDetail } from './types';

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

export const api = {
  importFile: (url: string) =>
    request<{ id: string; name: string }>('/api/files', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),

  listFiles: () => request<FileDetail[]>('/api/files'),

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

  download: (url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
};
