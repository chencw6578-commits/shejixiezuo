/**
 * 可交互静态原型生成器：
 * 每个画板 → 一个页面（画板渲染图做底），配置了「原型交互」（nodes.props.interaction）的
 * 图层生成透明热区，点击即切换到目标画板。Hash 路由支持浏览器前进/后退。
 *
 * 两种输出：
 *  - buildPrototypeHtml：单文件 HTML（图片直接引用 /storage/ URL，用于网页内预览）
 *  - buildPrototypeZip：  独立可分发的 zip（assets/ 内嵌画板 PNG + README）
 */
import { pool } from './db.js';
import { getStorage } from './storage/index.js';

interface FrameRow {
  id: string;
  name: string;
  width: number;
  height: number;
  thumb_url: string | null;
}

interface InteractionRow {
  node_id: string;
  frame_id: string;
  name: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  target: string;
}

interface Hotspot {
  targetIndex: number;
  targetName: string;
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slugOf = (name: string, i: number) =>
  `page${i + 1}-${name.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '') || i}`;

async function loadPrototype(fileId: string) {
  const file = (
    await pool.query<{ id: string; name: string }>('SELECT id, name FROM design_files WHERE id = $1', [fileId])
  ).rows[0];
  if (!file) throw new Error('文件不存在');
  const frames = (
    await pool.query<FrameRow>(
      `SELECT id, name, width, height, thumb_url FROM frames
       WHERE file_id = $1 ORDER BY sort_order, name`,
      [fileId]
    )
  ).rows;
  const interactions = (
    await pool.query<InteractionRow>(
      `SELECT node_id, frame_id, name, x, y, width, height,
              props->'interaction'->>'targetFrameId' AS target
       FROM nodes
       WHERE file_id = $1 AND visible AND props->'interaction'->>'targetFrameId' IS NOT NULL`,
      [fileId]
    )
  ).rows;
  return { file, frames, interactions };
}

function buildHotspots(
  interactions: InteractionRow[],
  frameId: string,
  frame: { width: number; height: number },
  indexByFrameId: Map<string, number>,
  nameByIndex: string[]
): Hotspot[] {
  const hotspots: Hotspot[] = [];
  for (const it of interactions) {
    if (it.frame_id !== frameId) continue;
    const targetIndex = indexByFrameId.get(it.target);
    if (targetIndex === undefined) continue;
    hotspots.push({
      targetIndex,
      targetName: nameByIndex[targetIndex],
      left: (it.x / frame.width) * 100,
      top: (it.y / frame.height) * 100,
      width: (it.width / frame.width) * 100,
      height: (it.height / frame.height) * 100,
      label: it.name ?? it.node_id,
    });
  }
  return hotspots.sort((a, b) => b.width * b.height - a.width * a.height);
}

function pageHtml(
  frame: FrameRow,
  slug: string,
  hotspots: Hotspot[],
  imgSrc: string,
  slugs: string[]
): string {
  const spots = hotspots
    .map(
      (h) =>
        `      <a class="hotspot" href="#/${slugs[h.targetIndex]}" title="${esc(
          `${h.label} → ${h.targetName}`
        )}" style="left:${h.left.toFixed(2)}%;top:${h.top.toFixed(2)}%;width:${h.width.toFixed(
          2
        )}%;height:${h.height.toFixed(2)}%"></a>`
    )
    .join('\n');
  return `    <section class="page" id="${slug}" data-name="${esc(frame.name)}">
      <h2 class="page-title">${esc(frame.name)}</h2>
      <div class="device" style="--ar:${frame.width} / ${frame.height}">
        <img src="${imgSrc}" alt="${esc(frame.name)}" draggable="false">
${spots}
      </div>
    </section>`;
}

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1e1e1e;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:16px;height:48px;padding:0 16px;background:#111;border-bottom:1px solid #333;position:sticky;top:0;z-index:9}
header b{font-size:14px;white-space:nowrap}
header nav{display:flex;gap:4px;overflow-x:auto}
header nav a{color:#9aa;padding:4px 10px;border-radius:6px;text-decoration:none;font-size:13px;white-space:nowrap}
header nav a.active{color:#fff;background:#1b6dff}
.tip{margin-left:auto;font-size:12px;color:#666}
main{padding:24px 0}
.page{display:none;flex-direction:column;align-items:center;gap:10px}
.page.active{display:flex}
.page-title{font-size:13px;color:#888;font-weight:400}
.device{position:relative;height:min(86vh,calc(100vh - 120px));aspect-ratio:var(--ar);max-width:94vw}
.device img{width:100%;height:100%;display:block;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5);user-select:none}
.hotspot{position:absolute;display:block;border-radius:6px;transition:background .12s,outline-color .12s;outline:0 solid transparent}
.hotspot:hover{background:rgba(27,109,255,.16);outline:2px solid #1b6dff}
`;

function shellHtml(file: FrameName, pages: string[], nav: string[], script: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(file.name)} · 可交互原型</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <b>${esc(file.name)}</b>
  <nav>
${nav}
  </nav>
  <span class="tip">鼠标悬停可发现可点击区域 · 点击按钮跳转页面 · 浏览器后退可返回</span>
</header>
<main>
${pages.join('\n')}
</main>
<script>
${script}
</script>
</body>
</html>
`;
}

interface FrameName {
  name: string;
}

function routerScript(firstSlug: string): string {
  return `(function(){
  var first = '${firstSlug}';
  function show(){
    var h = location.hash.replace(/^#\\//, '') || first;
    var el = document.getElementById(h) || document.getElementById(first);
    var pages = document.querySelectorAll('.page');
    for (var i = 0; i < pages.length; i++) pages[i].classList.toggle('active', pages[i] === el);
    var links = document.querySelectorAll('header nav a');
    for (var i = 0; i < links.length; i++)
      links[i].classList.toggle('active', links[i].getAttribute('href') === '#/' + el.id);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', show);
  show();
})();`;
}

async function assemble(fileId: string): Promise<{
  html: string;
  assets: Array<{ name: string; buf: Buffer }>;
  file: { name: string };
  slugs: string[];
} | null> {
  const { file, frames, interactions } = await loadPrototype(fileId);
  if (frames.length === 0) return null;
  const indexByFrameId = new Map(frames.map((f, i) => [f.id, i]));
  const nameByIndex = frames.map((f) => f.name);
  const pages: string[] = [];
  const nav: string[] = [];
  const assets: Array<{ name: string; buf: Buffer }> = [];
  const storage = await getStorage();
  // 先算好全部 slug：页面 i 的热区可能跳转到排在它后面的页面
  const slugs = frames.map((f, i) => slugOf(f.name, i));
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const slug = slugs[i];
    const hotspots = buildHotspots(interactions, f.id, f, indexByFrameId, nameByIndex);
    if (f.thumb_url && f.thumb_url.startsWith('/storage/')) {
      const buf = await storage.get(f.thumb_url.replace(/^\/storage\//, ''));
      assets.push({ name: `assets/${slug}.png`, buf });
    }
    const imgSrc = f.thumb_url ?? '';
    pages.push(pageHtml(f, slug, hotspots, imgSrc, slugs));
    nav.push(`    <a href="#/${slug}">${esc(f.name)}</a>`);
  }
  const html = shellHtml(file, pages, nav, routerScript(slugs[0]));
  return { html, assets, file, slugs };
}

/** 网页内预览：单文件 HTML，图片走 /storage/ 相对地址（同源） */
export async function buildPrototypeHtml(fileId: string): Promise<string | null> {
  const r = await assemble(fileId);
  return r?.html ?? null;
}

/** 可分发 zip：index.html + assets/*.png + README.md */
export async function buildPrototypeZip(fileId: string): Promise<{ name: string; buf: Buffer } | null> {
  const r = await assemble(fileId);
  if (!r) return null;
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  // zip 内图片路径改为本地 assets/
  const standalone = r.html.replace(/src="\/storage\/[^"]+"/g, (m) => {
    const slug = m.match(/assets\/([^"]+)\.png/)?.[1];
    return slug ? `src="assets/${slug}.png"` : m;
  });
  zip.file('index.html', standalone);
  for (const a of r.assets) zip.file(a.name, a.buf);
  zip.file(
    'README.md',
    `# ${r.file.name} · 可交互静态原型

由设计协作平台自动生成。

## 使用

- 本地预览：直接双击 index.html（需与 assets/ 同目录），或起任意静态服务器（\`npx serve .\`）后访问
- 部署：整个目录扔到任意静态托管（Nginx / OSS / Vercel / GitHub Pages）即可

## 交互说明

- 顶部导航栏可切换页面；浏览器前进/后退可用（hash 路由）
- 设计稿里配置了「原型交互 → 跳转到」的图层会生成透明热区，鼠标悬停会高亮，点击即跳转目标画板
- 在平台的画板详情页选中图层，可在右侧「原型交互」中修改跳转目标，重新导出即可更新

## 结构

- index.html   全部页面 + hash 路由 + 热区（可直接阅读/二改的静态代码）
- assets/      每个画板的渲染 PNG（2x）
`
  );
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { name: `${r.file.name}-prototype.zip`, buf };
}
