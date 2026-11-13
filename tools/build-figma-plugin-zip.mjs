// 打包 Figma 插件为 zip，输出到 web/public/figma-plugin.zip。
// 纯 Node 实现（zlib + 自建 CRC32 + ZIP 容器），零第三方依赖、跨平台。
// 插件以「扁平结构」存放（manifest.json 在解压后的根目录），方便用户在 Figma
// 「Import plugin from manifest…」里直接选解压出的 manifest.json。
import { deflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const srcDir = join(repoRoot, 'figma-plugin');
const outFile = join(repoRoot, 'web', 'public', 'figma-plugin.zip');

// ---------- 收集 figma-plugin 下所有文件（递归） ----------
function walk(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, base, out);
    } else {
      // ZIP 内部路径用正斜杠；相对 figma-plugin 根，保持扁平（无外层目录）
      const rel = relative(base, full).split('\\').join('/');
      out.push({ rel, full });
    }
  }
}
const files = [];
walk(srcDir, srcDir, files);
if (files.length === 0) {
  console.error('[build-figma-plugin-zip] 未在 figma-plugin/ 找到任何文件，中止');
  process.exit(1);
}

// ---------- CRC32 ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- 组装 ZIP（method=8 deflate） ----------
const chunks = [];
const central = [];
let offset = 0;

for (const f of files) {
  const data = readFileSync(f.full);
  const nameBuf = Buffer.from(f.rel, 'utf8');
  const crc = crc32(data);
  const comp = deflateRawSync(data); // raw deflate，对应 ZIP method 8

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // general purpose flag
  local.writeUInt16LE(8, 8); // compression method = deflate
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0, 12); // mod date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra field length
  chunks.push(local, nameBuf, comp);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
  cen.writeUInt16LE(20, 4); // version made by
  cen.writeUInt16LE(20, 6); // version needed
  cen.writeUInt16LE(0, 8); // flag
  cen.writeUInt16LE(8, 10); // method
  cen.writeUInt16LE(0, 12); // time
  cen.writeUInt16LE(0, 14); // date
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(comp.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt16LE(0, 30); // extra
  cen.writeUInt16LE(0, 32); // comment
  cen.writeUInt16LE(0, 34); // disk number
  cen.writeUInt16LE(0, 36); // internal attrs
  cen.writeUInt32LE(0, 38); // external attrs
  cen.writeUInt32LE(offset, 42); // local header offset
  central.push(cen, nameBuf);

  offset += local.length + nameBuf.length + comp.length;
}

const centralStart = offset;
let centralSize = 0;
for (const c of central) {
  chunks.push(c);
  centralSize += c.length;
}

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // 结束记录签名
end.writeUInt16LE(0, 4); // disk number
end.writeUInt16LE(0, 6); // disk with central dir
end.writeUInt16LE(files.length, 8); // entries (this disk)
end.writeUInt16LE(files.length, 10); // total entries
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(centralStart, 16);
end.writeUInt16LE(0, 20); // comment length
chunks.push(end);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, Buffer.concat(chunks));
console.log(`[build-figma-plugin-zip] 已打包 ${files.length} 个文件 -> ${outFile}`);
for (const f of files) console.log(`  - ${f.rel}`);
