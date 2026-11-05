import type { ExportResult, FileDetail, FrameDetail, SpecData } from './types';

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
