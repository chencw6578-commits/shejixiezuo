// 同源对比：同一画板同一图层，2x 整板 → 3x 切图
// 旧管线（双线性）vs 新管线（Catmull-Rom + unsharp），拉普拉斯能量（越大越锐）
import { pool } from './src/db.js';
import { loadStoredAsset, decodePng, encodePng, resampleBilinear, upscaleSharp } from './src/export/crop.js';
import { cropSliceFromBoard } from './src/export/crop.js';
import fs from 'node:fs';

function laplacianEnergy(png: Buffer): { score: number; w: number; h: number } | null {
  const dec = decodePng(png);
  if (!dec) return null;
  const { width: W, height: H, rgba } = dec;
  let sum = 0, cnt = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      if (rgba[i - 4 + 3] < 128 || rgba[i + 4 + 3] < 128 || rgba[i - W * 4 + 3] < 128 || rgba[i + W * 4 + 3] < 128 || rgba[i + 3] < 128) continue;
      const lum = (j: number) => 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
      const lap = 4 * lum(i) - lum(i - 4) - lum(i + 4) - lum(i - W * 4) - lum(i + W * 4);
      sum += Math.abs(lap); cnt++;
    }
  }
  return cnt > 50 ? { score: +(sum / cnt).toFixed(1), w: W, h: H } : null;
}

(async () => {
  const frame = (await pool.query<{ id: string; file_id: string; thumb_url: string; width: number; height: number; name: string }>(
    `SELECT f.id, f.file_id, f.thumb_url, f.width, f.height, f.name FROM frames f
     JOIN design_files d ON d.id = f.file_id
     WHERE f.thumb_url LIKE '%66322ee%' LIMIT 1`
  )).rows[0];
  if (!frame) throw new Error('找不到样本画板');

  const boardBuf = await loadStoredAsset(frame.thumb_url);
  const dec = decodePng(boardBuf);
  if (!dec) throw new Error('整板解码失败');
  const boardScale = dec.width / frame.width;
  console.log(`画板 ${frame.name}: 设计 ${frame.width}×${frame.height}，整板 ${dec.width}×${dec.height}（@${boardScale}x）`);

  // 取几个中小尺寸图标/组件图层（最有代表性）
  const nodes = (await pool.query<{ node_id: string; name: string; x: number; y: number; width: number; height: number }>(
    `SELECT node_id, name, x, y, width, height FROM nodes
     WHERE frame_id = $1 AND width BETWEEN 30 AND 220 AND height BETWEEN 30 AND 220
     ORDER BY width * height DESC LIMIT 3`,
    [frame.id]
  )).rows;

  const scale = 3;
  let pass = true;
  for (const n of nodes) {
    const W = Math.max(1, Math.round(n.width * scale));
    const H = Math.max(1, Math.round(n.height * scale));
    const sx0 = n.x * boardScale;
    const sy0 = n.y * boardScale;
    const step = boardScale / scale;
    // 旧管线：双线性
    const oldPng = encodePng(W, H, resampleBilinear(dec, W, H, sx0, sy0, step, step));
    // 新管线：三次卷积 + 锐化
    const newPng = encodePng(W, H, upscaleSharp(dec, W, H, sx0, sy0, step, step));
    const o = laplacianEnergy(oldPng);
    const neo = laplacianEnergy(newPng);
    const ok = o && neo ? neo.score > o.score : false;
    if (!ok) pass = false;
    const tag = `${n.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 24)}_${n.width}x${n.height}`;
    fs.writeFileSync(`C:/Users/Administrator/WorkBuddy/2026-11-09-09-02-34/sharp3x-old-${tag}.png`, oldPng);
    fs.writeFileSync(`C:/Users/Administrator/WorkBuddy/2026-11-09-09-02-34/sharp3x-new-${tag}.png`, newPng);
    console.log(`${n.name} (${Math.round(n.width)}×${Math.round(n.height)} → ${W}×${H})`);
    console.log(`  旧(双线性): ${o ? o.score : 'n/a'}   新(三次卷积+锐化): ${neo ? neo.score : 'n/a'}  ${ok ? '✓ 更锐利' : '✗'}`);
  }
  // 整管线路径端到端（走 cropSliceFromBoard，含 SVG 包装）
  const e2e = nodes[0] && await cropSliceFromBoard(frame.file_id, frame.id, nodes[0].node_id, 'SVG', 3);
  console.log(`SVG 包装端到端: ${e2e ? `输出 ${e2e.buf.length}B (${e2e.ext})` : 'null'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('失败:', e); process.exit(2); });
