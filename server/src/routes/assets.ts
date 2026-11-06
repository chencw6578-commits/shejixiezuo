import JSZip from 'jszip';
import { Router } from 'express';
import { pool } from '../db.js';
import { downloadImage, getImages } from '../figma/client.js';
import { getStorage } from '../storage/index.js';
import { isLocalFile, renderLocalSlice } from '../export/local.js';

export const assetsRouter = Router();

const FORMATS = new Set(['PNG', 'SVG', 'PDF', 'JPG']);
const CONTENT_TYPES: Record<string, string> = {
  PNG: 'image/png',
  SVG: 'image/svg+xml',
  JPG: 'image/jpeg',
  PDF: 'application/pdf',
};

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'asset';

/** 导出单个图层切图 */
assetsRouter.post('/export', async (req, res) => {
  const { fileId, nodeId, format = 'PNG', scale = 2, name } = req.body ?? {};
  if (!fileId || !nodeId) return res.status(400).json({ error: '缺少 fileId 或 nodeId' });
  if (!FORMATS.has(format)) return res.status(400).json({ error: `不支持的格式: ${format}` });
  const s = Number(scale);
  if (!(s >= 0.5 && s <= 4)) return res.status(400).json({ error: 'scale 取值范围 0.5-4' });

  const file = (
    await pool.query<{ figma_key: string; source: string }>(
      'SELECT figma_key, source FROM design_files WHERE id = $1',
      [fileId]
    )
  ).rows[0];
  if (!file) return res.status(404).json({ error: '文件不存在' });

  const ext = format.toLowerCase();

  // 本地文件（演示 / Sketch / PSD）：服务端直接渲染，不走 Figma API
  if (isLocalFile(file.source, file.figma_key)) {
    if (format === 'PDF') return res.status(400).json({ error: '本地文件暂只支持 PNG / SVG / JPG 导出' });
    const frameOf = (
      await pool.query<{ frame_id: string }>(
        'SELECT frame_id FROM nodes WHERE file_id = $1 AND node_id = $2 LIMIT 1',
        [fileId, nodeId]
      )
    ).rows[0];
    if (!frameOf) return res.status(404).json({ error: '图层不存在' });
    const slice = await renderLocalSlice(fileId, frameOf.frame_id, nodeId, format, s);
    if (!slice) return res.status(404).json({ error: '图层不存在或不可导出' });
    const storage = await getStorage();
    const key = `assets/${fileId}/${Date.now()}-${safeName(name ?? nodeId)}${s !== 1 ? `@${s}x` : ''}.${slice.ext}`;
    const storedUrl = await storage.put(key, slice.buf, slice.contentType);
    const { rows } = await pool.query(
      `INSERT INTO assets (file_id, node_id, name, format, scale, url)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, url, format, scale, created_at`,
      [fileId, nodeId, name ?? nodeId, format, s, storedUrl]
    );
    return res.json({ ...rows[0], size: slice.buf.length });
  }

  const result = await getImages(file.figma_key, [nodeId], ext as 'png' | 'svg' | 'pdf' | 'jpg', s);
  const url = result.images[nodeId];
  if (!url) {
    return res.status(502).json({ error: `Figma 导出失败：${result.err ?? '节点不可导出'}` });
  }
  const buf = await downloadImage(url);
  const storage = await getStorage();
  const key = `assets/${fileId}/${Date.now()}-${safeName(name ?? nodeId)}${s !== 1 ? `@${s}x` : ''}.${ext}`;
  const storedUrl = await storage.put(key, buf, CONTENT_TYPES[format]);

  const { rows } = await pool.query(
    `INSERT INTO assets (file_id, node_id, name, format, scale, url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, url, format, scale, created_at`,
    [fileId, nodeId, name ?? nodeId, format, s, storedUrl]
  );
  res.json({ ...rows[0], size: buf.length });
});

interface ZipTask {
  nodeId: string;
  name: string;
  format: string;
  scale: number;
  suffix: string;
}

const MAX_ZIP_TASKS = 600;

/**
 * 批量切图打包 zip。
 * mode = presets：按设计稿标记的导出预设导出有预设的图层
 * mode = all：画板内全部图层按统一格式/倍率导出
 */
assetsRouter.post('/export-zip', async (req, res) => {
  const { fileId, frameId, mode = 'presets', format = 'PNG', scale = 2 } = req.body ?? {};
  if (!fileId || !frameId) return res.status(400).json({ error: '缺少 fileId 或 frameId' });
  if (mode === 'all' && !FORMATS.has(format)) {
    return res.status(400).json({ error: `不支持的格式: ${format}` });
  }
  const s = Number(scale);
  if (mode === 'all' && !(s >= 0.5 && s <= 4)) {
    return res.status(400).json({ error: 'scale 取值范围 0.5-4' });
  }

  const file = (
    await pool.query<{ figma_key: string; name: string; source: string }>(
      'SELECT figma_key, name, source FROM design_files WHERE id = $1',
      [fileId]
    )
  ).rows[0];
  if (!file) return res.status(404).json({ error: '文件不存在' });

  const frame = (
    await pool.query<{ name: string }>('SELECT name FROM frames WHERE id = $1 AND file_id = $2', [
      frameId,
      fileId,
    ])
  ).rows[0];
  if (!frame) return res.status(404).json({ error: '画板不存在' });

  const nodes = (
    await pool.query<{ node_id: string; name: string; props: { exportPresets?: { format: string; suffix: string; scale: number }[] } }>(
      'SELECT node_id, name, props FROM nodes WHERE frame_id = $1',
      [frameId]
    )
  ).rows;

  // 生成导出任务
  const tasks: ZipTask[] = [];
  if (mode === 'presets') {
    for (const n of nodes) {
      for (const p of n.props?.exportPresets ?? []) {
        if (!FORMATS.has(p.format)) continue;
        tasks.push({ nodeId: n.node_id, name: n.name, format: p.format, scale: p.scale, suffix: p.suffix });
      }
    }
  } else {
    for (const n of nodes) {
      tasks.push({ nodeId: n.node_id, name: n.name, format, scale: s, suffix: s !== 1 ? `@${s}x` : '' });
    }
  }
  if (tasks.length === 0) {
    return res.status(400).json({
      error: mode === 'presets'
        ? '该画板没有标记导出预设的图层（在 Figma 中为图层添加导出设置后重新导入），或改用「全部图层」模式'
        : '该画板没有图层',
    });
  }
  if (tasks.length > MAX_ZIP_TASKS) {
    return res.status(400).json({ error: `导出任务数 ${tasks.length} 超过上限 ${MAX_ZIP_TASKS}，请缩小范围` });
  }

  // 按 格式+倍率 分组，尽量减少 images API 调用
  const byKey = new Map<string, ZipTask[]>();
  for (const t of tasks) {
    const k = `${t.format}@${t.scale}`;
    const list = byKey.get(k) ?? [];
    list.push(t);
    byKey.set(k, list);
  }

  const zip = new JSZip();
  const usedNames = new Map<string, number>();
  const failures: string[] = [];

  // 本地文件（演示 / Sketch / PSD）：逐图层服务端渲染
  if (isLocalFile(file.source, file.figma_key)) {
    for (const t of tasks) {
      if (t.format === 'PDF') {
        failures.push(t.name);
        continue;
      }
      try {
        const slice = await renderLocalSlice(fileId, frameId, t.nodeId, t.format, t.scale);
        if (!slice) {
          failures.push(t.name);
          continue;
        }
        const base = safeName(t.name);
        const n = (usedNames.get(base) ?? 0) + 1;
        usedNames.set(base, n);
        const filename = n > 1 ? `${base} (${n})${t.suffix}.${slice.ext}` : `${base}${t.suffix}.${slice.ext}`;
        zip.file(filename, slice.buf);
      } catch {
        failures.push(t.name);
      }
    }
    const entries = Object.keys(zip.files).length;
    if (entries === 0) {
      return res.status(502).json({ error: '本地渲染失败：画板中没有可导出的图层' });
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zipName = encodeURIComponent(`${safeName(frame.name)}-slices.zip`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${zipName}`);
    res.setHeader('X-Slice-Failures', String(failures.length));
    return res.send(buf);
  }

  for (const [, group] of byKey) {
    const ext = group[0].format.toLowerCase();
    const gScale = group[0].scale;
    for (let i = 0; i < group.length; i += 50) {
      const chunk = group.slice(i, i + 50);
      let urls: Record<string, string | null>;
      try {
        const result = await getImages(
          file.figma_key,
          chunk.map((t) => t.nodeId),
          ext as 'png' | 'svg' | 'pdf' | 'jpg',
          gScale
        );
        urls = result.images;
      } catch {
        failures.push(...chunk.map((t) => t.name));
        continue;
      }
      // 限并发下载
      await Promise.all(
        chunk.map(async (t) => {
          const url = urls[t.nodeId];
          if (!url) {
            failures.push(t.name);
            return;
          }
          try {
            const buf = await downloadImage(url);
            const base = safeName(t.name);
            const n = (usedNames.get(base) ?? 0) + 1;
            usedNames.set(base, n);
            const filename = n > 1 ? `${base} (${n})${t.suffix}.${ext}` : `${base}${t.suffix}.${ext}`;
            zip.file(filename, buf);
          } catch {
            failures.push(t.name);
          }
        })
      );
    }
  }

  const entries = Object.keys(zip.files).length;
  if (entries === 0) {
    return res.status(502).json({ error: 'Figma 导出失败，请稍后重试' });
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const zipName = encodeURIComponent(`${safeName(frame.name)}-slices.zip`);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${zipName}`);
  res.setHeader('X-Slice-Failures', String(failures.length));
  res.send(buf);
});

/** 某文件的切图历史 */
assetsRouter.get('/file/:fileId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, node_id, name, format, scale, url, created_at
     FROM assets WHERE file_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [req.params.fileId]
  );
  res.json(rows);
});
