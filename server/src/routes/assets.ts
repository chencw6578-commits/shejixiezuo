import JSZip from 'jszip';
import { Router } from 'express';
import { pool } from '../db.js';
import { downloadImage, getImages } from '../figma/client.js';
import { getStorage } from '../storage/index.js';
import { isLocalFile, renderLocalSlice } from '../export/local.js';
import { cropSliceFromBoard, loadStoredAsset, upscaleRealSlice } from '../export/crop.js';
import { resolveExportTarget, loadNodeIndex, resolveFromIndex } from '../export/preset.js';

export const assetsRouter = Router();

const FORMATS = new Set(['PNG', 'SVG', 'PDF', 'JPG']);
const CONTENT_TYPES: Record<string, string> = {
  PNG: 'image/png',
  SVG: 'image/svg+xml',
  JPG: 'image/jpeg',
  PDF: 'application/pdf',
};

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'asset';

interface PreferredSlice { id: string; url: string; source: string }

/**
 * 精确命中插件按 Figma Export 预设上传的真实切图（source='figma'），
 * 或此前由「就近真切图放大」产生的缓存（source='upscaled'，同尺寸直接复用）。
 * 整板裁剪（source='crop'）只是兜底产物，绝不能当缓存命中——否则第一次
 * 裁错了尺寸/边缘，之后无论怎么修都会被那条旧记录锁死。
 * source='render' 是服务端近似渲染（常为全透明空白），同样不参与优先链。
 */
async function findPreferredSlice(
  fileId: string, nodeId: string, format: string, scale: number
): Promise<PreferredSlice | null> {
  const { rows } = await pool.query<PreferredSlice>(
    `SELECT id, url, source FROM assets
     WHERE file_id = $1 AND node_id = $2 AND format = $3 AND scale = $4
       AND source IN ('figma', 'upscaled')
     ORDER BY CASE source WHEN 'figma' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1`,
    [fileId, nodeId, format, scale]
  );
  return rows[0] ?? null;
}

/**
 * 就近真实切图：精确倍率没有插件真切图时，找同节点同格式里
 * 倍率不超过目标的最大一张（SVG 与倍率无关，任意一张都行）。
 * 之后由调用方解码放大到目标尺寸——透明底 + 图层精确边界，
 * 画质优于「带画板底色的整板裁剪放大」，尤其是图标类小图层。
 */
async function findNearestRealSlice(
  fileId: string, nodeId: string, format: string, scale: number
): Promise<{ id: string; url: string; source: string } | null> {
  if (format === 'SVG') {
    const { rows } = await pool.query<{ id: string; url: string; source: string }>(
      `SELECT id, url, source FROM assets
       WHERE file_id = $1 AND node_id = $2 AND format = 'SVG' AND source = 'figma'
       ORDER BY created_at DESC LIMIT 1`,
      [fileId, nodeId]
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query<{ id: string; url: string; source: string }>(
    `SELECT id, url, source FROM assets
     WHERE file_id = $1 AND node_id = $2 AND format = $3 AND source = 'figma' AND scale <= $4
     ORDER BY scale DESC, created_at DESC LIMIT 1`,
    [fileId, nodeId, format, scale]
  );
  return rows[0] ?? null;
}

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

  // 任意已导入图层均可导出切图（不再要求 Figma Export 预设）。
  // 设计标记的预设仍保留，供前端展示「一键按标记导出」快捷按钮。
  const node = (
    await pool.query<{ props: { exportPresets?: unknown[] } | null; frame_id: string }>(
      'SELECT props, frame_id FROM nodes WHERE file_id = $1 AND node_id = $2 LIMIT 1',
      [fileId, nodeId]
    )
  ).rows[0];
  if (!node) return res.status(404).json({ error: '图层不存在' });

  const ext = format.toLowerCase();
  const localOnly = isLocalFile(file.source, file.figma_key);

  // 把「用户点中的图层」解析成「Figma 真正标记要导出的图层」：
  // 点图标内部 Vector 时会落到带预设的父级 20×20 Frame，尺寸与四边才与设计一致。
  const target = await resolveExportTarget(fileId, node.frame_id, nodeId);
  const resolvedFrom = target?.resolvedFrom ?? null;

  // 1) 插件按 Figma Export 预设上传的真实切图：透明底、真矢量、尺寸完全按设计标记
  const real = await findPreferredSlice(fileId, target?.nodeId ?? nodeId, format, s);
  if (real) {
    try {
      const buf = await loadStoredAsset(real.url);
      if (buf.length) {
        return res.json({
          id: real.id, url: real.url, format, scale: s,
          size: buf.length, source: real.source, resolvedFrom,
        });
      }
    } catch {
      // 存储文件丢失：继续走下面的兜底，不把用户卡死
    }
  }

  // 1b) 精确倍率没有真切图时，用同图层最大可用倍率的真切图放大（仅本地文件——
  //     Figma 直连的文件走第 3 步 REST 真矢量导出更好）：
  //     透明底 + 图层精确边界，画质优于整板裁剪放大（尤其图标类小图层）。
  //     SVG 是矢量，与倍率无关，任何倍率直接复用。
  if (!real && localOnly) {
    const near = await findNearestRealSlice(fileId, target?.nodeId ?? nodeId, format, s);
    if (near) {
      try {
        const buf = await loadStoredAsset(near.url);
        if (buf.length) {
          if (format === 'SVG') {
            return res.json({
              id: near.id, url: near.url, format, scale: s,
              size: buf.length, source: near.source, resolvedFrom,
            });
          }
          const b = target?.bounds ??
            (await pool.query<{ width: number; height: number }>(
              'SELECT width, height FROM nodes WHERE file_id = $1 AND node_id = $2 LIMIT 1',
              [fileId, nodeId]
            )).rows[0];
          if (b && b.width > 0 && b.height > 0) {
            const up = await upscaleRealSlice(buf, b.width * s, b.height * s);
            if (up) {
              const storage = await getStorage();
              const key = `assets/${fileId}/${Date.now()}-${safeName(name ?? nodeId)}${s !== 1 ? `@${s}x` : ''}.png`;
              const url = await storage.put(key, up, 'image/png');
              const { rows } = await pool.query(
                `INSERT INTO assets (file_id, frame_id, node_id, name, format, scale, url, source)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'upscaled') RETURNING id, url, format, scale, created_at`,
                [fileId, node.frame_id, target?.nodeId ?? nodeId, name ?? nodeId, format, s, url]
              );
              return res.json({ ...rows[0], size: up.length, source: 'upscaled', resolvedFrom });
            }
          }
        }
      } catch {
        // 就近放大失败：继续整板裁剪兜底
      }
    }
  }

  // 2) 插件/本地文件拿不到 Figma API：从已保存的 Figma 原生整板 PNG 裁剪。
  //    裁剪框用解析出的目标包围盒（有 Figma 标记时即标记图层的完整边界），
  //    而不是用户点中的内部子路径 bbox，避免把四角/描边切掉。
  if (localOnly && format !== 'PDF') {
    const cropped = await cropSliceFromBoard(fileId, node.frame_id, nodeId, format, s, target?.bounds);
    if (cropped) {
      const storage = await getStorage();
      const key = `assets/${fileId}/${Date.now()}-${safeName(name ?? nodeId)}${s !== 1 ? `@${s}x` : ''}.${cropped.ext}`;
      const url = await storage.put(key, cropped.buf, cropped.contentType);
      const { rows } = await pool.query(
        `INSERT INTO assets (file_id, frame_id, node_id, name, format, scale, url, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'crop') RETURNING id, url, format, scale, created_at`,
        [fileId, node.frame_id, nodeId, name ?? nodeId, format, s, url]
      );
      return res.json({ ...rows[0], size: cropped.buf.length, source: 'crop', resolvedFrom });
    }
  }

  // 3) 最后的兜底：服务端近似渲染（演示 / Sketch / PSD）或 Figma REST 真实导出
  if (localOnly) {
    if (format === 'PDF') return res.status(400).json({ error: '本地文件暂只支持 PNG / SVG / JPG 导出' });
    const slice = await renderLocalSlice(fileId, node.frame_id, nodeId, format, s);
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
  // 两种批量模式：presets=按 Figma 标记逐个导出；all=按所选格式/倍率导出全部图层
  if (mode !== 'presets' && mode !== 'all') {
    return res.status(400).json({ error: `不支持的导出模式: ${mode}` });
  }
  if (!FORMATS.has(format)) {
    return res.status(400).json({ error: `不支持的格式: ${format}` });
  }
  const s = Number(scale);

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

  const zip = new JSZip();
  const usedNames = new Map<string, number>();
  const failures: string[] = [];
  const localOnly = isLocalFile(file.source, file.figma_key);

  const addToZip = (t: ZipTask, buf: Buffer, ext: string) => {
    const base = safeName(t.name);
    const n = (usedNames.get(base) ?? 0) + 1;
    usedNames.set(base, n);
    const filename = n > 1 ? `${base} (${n})${t.suffix}.${ext}` : `${base}${t.suffix}.${ext}`;
    zip.file(filename, buf);
  };

  // 三级优先链：插件真实切图 > 整板 PNG 裁剪 > 原渲染路径
  // 节点索引一次加载并按图层缓存，批量 600 个任务不会逐层查库。
  const nodeIndex = await loadNodeIndex(fileId, frameId);
  const targetCache = new Map<string, ReturnType<typeof resolveFromIndex>>();
  const targetOf = (nodeId: string) => {
    if (!targetCache.has(nodeId)) targetCache.set(nodeId, resolveFromIndex(nodeIndex, nodeId));
    return targetCache.get(nodeId) ?? null;
  };
  const resolved = new Map<number, { buf: Buffer; ext: string }>();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const target = targetOf(t.nodeId);
    const real = await findPreferredSlice(fileId, target?.nodeId ?? t.nodeId, t.format, t.scale);
    if (real) {
      try {
        const buf = await loadStoredAsset(real.url);
        if (buf.length) {
          resolved.set(i, { buf, ext: t.format.toLowerCase() });
          continue;
        }
      } catch {
        // 存储文件丢失：落到裁剪
      }
    }
    // 就近真切图放大（仅本地文件）：透明底优于整板裁剪放大；SVG 与倍率无关直接复用
    if (!real && localOnly && t.format !== 'PDF') {
      const near = await findNearestRealSlice(fileId, target?.nodeId ?? t.nodeId, t.format, t.scale);
      if (near) {
        try {
          const buf = await loadStoredAsset(near.url);
          if (buf.length) {
            if (t.format === 'SVG') {
              resolved.set(i, { buf, ext: 'svg' });
              continue;
            }
            const b = target?.bounds ?? (() => {
              const n = nodeIndex.byId.get(t.nodeId);
              return n && n.width > 0 ? { width: n.width, height: n.height } : null;
            })();
            if (b && b.width > 0 && b.height > 0) {
              const up = await upscaleRealSlice(buf, b.width * t.scale, b.height * t.scale);
              if (up) {
                resolved.set(i, { buf: up, ext: t.format.toLowerCase() });
                continue;
              }
            }
          }
        } catch {
          // 就近放大失败：落到整板裁剪
        }
      }
    }
    if (localOnly && t.format !== 'PDF') {
      const cropped = await cropSliceFromBoard(fileId, frameId, t.nodeId, t.format, t.scale, target?.bounds);
      if (cropped) resolved.set(i, { buf: cropped.buf, ext: cropped.ext });
    }
  }
  const rest: ZipTask[] = [];
  tasks.forEach((t, i) => {
    const r = resolved.get(i);
    if (r) addToZip(t, r.buf, r.ext);
    else rest.push(t);
  });

  // 按 格式+倍率 分组，尽量减少 images API 调用（只处理未优先解析的任务）
  const byKey = new Map<string, ZipTask[]>();
  for (const t of rest) {
    const k = `${t.format}@${t.scale}`;
    const list = byKey.get(k) ?? [];
    list.push(t);
    byKey.set(k, list);
  }

  // 本地文件（演示 / Sketch / PSD）：逐图层服务端渲染
  if (localOnly) {
    for (const t of rest) {
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
        addToZip(t, slice.buf, slice.ext);
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
