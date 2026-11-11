// 3x 切图清晰度实测：新管线（Catmull-Rom + unsharp） vs 库里的旧 3x 切图
// 用法: npx tsx verify-3x-sharp.ts
import { pool } from './src/db.js';
import { cropSliceFromBoard, loadStoredAsset } from './src/export/crop.js';
import fs from 'node:fs';
import zlib from 'node:zlib';

/** 平均拉普拉斯绝对值（不透明像素）：越大越锐利。 */
function laplacianEnergy(png: Buffer): { score: number; w: number; h: number } | null {
  // 最小 PNG 解码（8bit RGBA/RGB/灰度，非隔行）——复用 crop.ts 不导出的解码器，
  // 这里独立实现一个够用的版本
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  if (!png.subarray(0, 4).equals(sig)) return null;
  let off = 8, W = 0, H = 0, ct = -1, interlace = 0;
  const idat: Buffer[] = [];
  const chunks: Record<string, Buffer> = {};
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { W = data.readUInt32BE(0); H = data.readUInt32BE(4); ct = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') chunks.PLTE = data;
    else if (type === 'tRNS') chunks.tRNS = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!W || !H || interlace) return null;
  const ch = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : ct === 6 ? 4 : 0;
  if (!ch) return null;
  let raw: Buffer;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = W * ch + 1;
  const px = Buffer.alloc(W * H * ch);
  for (let y = 0; y < H; y++) {
    const ft = raw[y * stride];
    const src = y * stride + 1, dst = y * W * ch, prev = y > 0 ? (y - 1) * W * ch : -1;
    for (let x = 0; x < W * ch; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0;
      const b = prev >= 0 ? px[prev + x] : 0;
      const c = prev >= 0 && x >= ch ? px[prev + x - ch] : 0;
      let v = raw[src + x];
      if (ft === 1) v += a; else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (ft !== 0) return null;
      px[dst + x] = v & 0xff;
    }
  }
  // 灰度 + alpha
  const lum = new Float32Array(W * H), al = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    let r = 0, g = 0, b = 0, a = 255;
    if (ct === 0) { r = g = b = px[i]; }
    else if (ct === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
    else if (ct === 3 && chunks.PLTE) { const idx = px[i]; r = chunks.PLTE[idx * 3]; g = chunks.PLTE[idx * 3 + 1]; b = chunks.PLTE[idx * 3 + 2]; if (chunks.tRNS && idx < chunks.tRNS.length) a = chunks.tRNS[idx]; }
    else if (ct === 4) { r = g = b = px[i * 2]; a = px[i * 2 + 1]; }
    else { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; a = px[i * 4 + 3]; }
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    al[i] = a;
  }
  let sum = 0, cnt = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (al[i - 1] < 128 || al[i + 1] < 128 || al[i - W] < 128 || al[i + W] < 128 || al[i] < 128) continue;
      const lap = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - W] - lum[i + W];
      sum += Math.abs(lap); cnt++;
    }
  }
  return cnt > 50 ? { score: +(sum / cnt).toFixed(1), w: W, h: H } : null;
}

(async () => {
  // 1) 找一个有整板位图的本地画板
  const frames = (await pool.query<{ id: string; file_id: string; thumb_url: string | null; name: string }>(
    `SELECT f.id, f.file_id, f.thumb_url, f.name FROM frames f
     JOIN design_files d ON d.id = f.file_id
     WHERE f.thumb_url IS NOT NULL AND d.source LIKE 'plugin%' LIMIT 5`
  )).rows;
  if (!frames.length) throw new Error('找不到带整板位图的插件导入画板');
  console.log('候选画板:', frames.map((f) => `${f.name}(${f.file_id.slice(0, 8)})`).join(', '));

  interface Energy { score: number; w: number; h: number }
  const results: Array<{ label: string; old: Energy | null; neo: Energy | null }> = [];
  for (const frame of frames) {
    // 该画板里较大的一个图层（边界明显，最能看出糊/锐）
    const node = (await pool.query<{ node_id: string; width: number; height: number; name: string }>(
      'SELECT node_id, width, height, name FROM nodes WHERE frame_id = $1 AND width >= 20 AND height >= 20 ORDER BY width * height DESC LIMIT 1',
      [frame.id]
    )).rows[0];
    if (!node) continue;

    // 2) 库里旧的 3x 切图（用户此前导出的）
    const oldAsset = (await pool.query<{ url: string; source: string; scale: number; name: string }>(
      `SELECT url, source, scale, name FROM assets
       WHERE file_id = $1 AND frame_id = $2 AND scale = 3 AND format = 'PNG'
       ORDER BY created_at DESC LIMIT 1`,
      [frame.file_id, frame.id]
    )).rows[0];

    // 3) 新管线导出 3x
    const neo = await cropSliceFromBoard(frame.file_id, frame.id, node.node_id, 'PNG', 3);
    if (!neo) { console.log(`跳过 ${frame.name}：新管线无输出`); continue; }
    fs.writeFileSync(`C:/Users/Administrator/WorkBuddy/2026-11-09-09-02-34/sharp-new-${frame.id.slice(0, 8)}.png`, neo.buf);

    let oldE: Energy | null = null;
    if (oldAsset) {
      try {
        const buf = await loadStoredAsset(oldAsset.url);
        oldE = laplacianEnergy(buf);
        fs.writeFileSync(`C:/Users/Administrator/WorkBuddy/2026-11-09-09-02-34/sharp-old-${frame.id.slice(0, 8)}.png`, buf);
      } catch { /* 旧文件丢了就跳过对比 */ }
    }
    const neoE = laplacianEnergy(neo.buf);
    results.push({ label: `${frame.name} / ${node.name} (${Math.round(node.width)}×${Math.round(node.height)})`, old: oldE, neo: neoE });
  }

  console.log('\n=== 清晰度对比（拉普拉斯能量，越大越锐利） ===');
  let pass = true;
  for (const r of results) {
    const o = r.old ? `${r.old.score} (${r.old.w}×${r.old.h})` : '无旧样本';
    const n = r.neo ? `${r.neo.score} (${r.neo.w}×${r.neo.h})` : '无新输出';
    const ok = r.old && r.neo ? r.neo.score >= r.old.score : null;
    if (ok === false) pass = false;
    console.log(`${r.label}\n  旧: ${o}\n  新: ${n} ${ok === null ? '' : ok ? '✓' : '✗ 反而更糊'}`);
  }
  if (!results.length) { console.log('没有可测样本'); process.exit(2); }
  process.exit(pass ? 0 : 1);
  process.exit(0);
})().catch((e) => { console.error('失败:', e); process.exit(2); });
