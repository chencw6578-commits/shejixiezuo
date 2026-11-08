/**
 * Figma 插件主线程：读取当前选中节点（或当前页顶层画板），导出为网站可导入的 JSON。
 *
 * 重要约束（Figma 插件沙箱）：
 * - 主线程没有 DOM、没有 fetch，只能操作 figma 场景树；
 * - 与 UI iframe 通信只走 figma.ui.postMessage / figma.ui.onmessage；
 * - 网络请求（可选「直接发送到网站」）由 ui.html 里的 fetch 发起。
 *
 * 导出结构：schemaVersion 1，artboards 里每个节点采用接近 Figma REST 的形状
 * （absoluteBoundingBox / children / fills / strokes / effects / style / characters），
 * 网站后端复用同一套解析逻辑；图片填充只带 imageHash 与 node id，不内嵌 base64。
 */
const SCHEMA_VERSION = 1;
const ARTBOARD_TYPES = ['FRAME', 'COMPONENT', 'INSTANCE'];

figma.showUI(__html__, { width: 420, height: 560, title: '设计协作 · 导出画板 JSON' });

function round(v) {
  return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function isNumber(v) {
  return typeof v === 'number' && isFinite(v);
}

/** 读取节点的绝对包围盒：优先 absoluteBoundingBox，退化为 absoluteTransform + 尺寸 */
function boundingBox(node) {
  const b = node.absoluteBoundingBox;
  if (b && isNumber(b.x) && isNumber(b.y) && isNumber(b.width) && isNumber(b.height)) {
    return { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) };
  }
  const t = node.absoluteTransform;
  const x = t && t[0] ? t[0][2] : 0;
  const y = t && t[1] ? t[1][2] : 0;
  return { x: round(x), y: round(y), width: round(node.width), height: round(node.height) };
}

function rgba(c) {
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  return { r: round(c.r), g: round(c.g), b: round(c.b), a: isNumber(c.a) ? round(c.a) : 1 };
}

/** 只保留网站需要的 paint 字段，避免把 Figma 内部对象带进 JSON */
function exportPaint(paint) {
  if (!paint || typeof paint !== 'object') return null;
  const type = typeof paint.type === 'string' ? paint.type : '';
  const out = {
    type,
    visible: paint.visible !== false,
    opacity: isNumber(paint.opacity) ? round(paint.opacity) : 1,
  };
  if (type === 'SOLID') {
    out.color = rgba(paint.color);
  } else if (type.indexOf('GRADIENT') === 0) {
    out.gradientStops = (Array.isArray(paint.gradientStops) ? paint.gradientStops : [])
      .filter((s) => s && s.color)
      .map((s) => ({ position: round(s.position), color: rgba(s.color) }));
    out.gradientHandlePositions = (Array.isArray(paint.gradientHandlePositions) ? paint.gradientHandlePositions : [])
      .filter((v) => v && isNumber(v.x) && isNumber(v.y))
      .map((v) => ({ x: round(v.x), y: round(v.y) }));
  } else if (type === 'IMAGE') {
    out.scaleMode = paint.scaleMode;
    // 只带 hash，不带 base64 图片数据
    out.imageHash = typeof paint.imageHash === 'string' ? paint.imageHash : null;
  }
  return out;
}

function exportPaints(paints) {
  if (!Array.isArray(paints)) return [];
  return paints.map(exportPaint).filter(Boolean);
}

function exportEffects(effects) {
  if (!Array.isArray(effects)) return [];
  return effects
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      type: e.type,
      visible: e.visible !== false,
      radius: isNumber(e.radius) ? round(e.radius) : undefined,
      spread: isNumber(e.spread) ? round(e.spread) : undefined,
      offset: e.offset ? { x: round(e.offset.x), y: round(e.offset.y) } : undefined,
      color: e.color ? rgba(e.color) : undefined,
    }));
}

/** 从字体样式名推断数值字重（Figma 只给 style 字符串） */
const WEIGHT_KEYS = [
  ['thin', 100],
  ['extralight', 200],
  ['ultralight', 200],
  ['light', 300],
  ['regular', 400],
  ['normal', 400],
  ['book', 400],
  ['medium', 500],
  ['semibold', 600],
  ['demibold', 600],
  ['extrabold', 800],
  ['ultrabold', 800],
  ['bold', 700],
  ['black', 900],
  ['heavy', 900],
];

function fontWeightOf(fontName) {
  const style = fontName && typeof fontName.style === 'string' ? fontName.style.toLowerCase().replace(/[^a-z]/g, '') : '';
  if (!style) return 400;
  for (const [key, weight] of WEIGHT_KEYS) {
    if (style.indexOf(key) === 0 || style.indexOf(key) === style.length - key.length) return weight;
  }
  return 400;
}

function lineHeightPx(node, fontSize) {
  const lh = node.lineHeight;
  if (!lh || typeof lh !== 'object') return undefined;
  if (lh.unit === 'PIXELS' && isNumber(lh.value)) return round(lh.value);
  if (lh.unit === 'PERCENT' && isNumber(lh.value) && isNumber(fontSize)) return round((fontSize * lh.value) / 100);
  return undefined;
}

function letterSpacingPx(node, fontSize) {
  const ls = node.letterSpacing;
  if (!ls || typeof ls !== 'object') return undefined;
  if (ls.unit === 'PIXELS' && isNumber(ls.value)) return round(ls.value);
  if (ls.unit === 'PERCENT' && isNumber(ls.value) && isNumber(fontSize)) return round((fontSize * ls.value) / 100);
  return undefined;
}

/** 文字字段按 Figma REST 的 characters + style 形状输出，网站可直接复用同一套解析 */
function exportTextFields(node) {
  if (node.type !== 'TEXT') return { characters: undefined, style: undefined };
  // 混排文本的 fontSize 等会是 figma.mixed（symbol），非数值时按缺省处理
  const fontSize = isNumber(node.fontSize) ? node.fontSize : undefined;
  const fontName = node.fontName && typeof node.fontName === 'object' ? node.fontName : {};
  return {
    characters: typeof node.characters === 'string' ? node.characters : '',
    style: {
      fontFamily: typeof fontName.family === 'string' ? fontName.family : undefined,
      fontPostScriptName: typeof fontName.style === 'string' ? fontName.style : undefined,
      fontWeight: fontWeightOf(node.fontName),
      fontSize: isNumber(fontSize) ? round(fontSize) : undefined,
      lineHeightPx: lineHeightPx(node, fontSize),
      letterSpacing: letterSpacingPx(node, fontSize),
      textAlignHorizontal: node.textAlignHorizontal,
      textAlignVertical: node.textAlignVertical,
      textCase: node.textCase,
      textDecoration: node.textDecoration,
    },
  };
}

function exportRadii(node) {
  if (isNumber(node.cornerRadius)) return { cornerRadius: round(node.cornerRadius) };
  const tl = node.topLeftRadius;
  const tr = node.topRightRadius;
  const br = node.bottomRightRadius;
  const bl = node.bottomLeftRadius;
  if ([tl, tr, br, bl].every(isNumber)) {
    return { rectangleCornerRadii: [round(tl), round(tr), round(br), round(bl)] };
  }
  return {};
}

/**
 * 递归导出节点子树。
 * parent 坐标来自 node.x / node.y（相对父级），boardX / boardY 为相对画板左上角。
 */
function exportNode(node, parentId, origin) {
  const box = boundingBox(node);
  const paints = exportPaints(node.fills);
  const imagePaint = paints.find((p) => p.type === 'IMAGE' && p.visible !== false);
  const out = {
    id: node.id,
    parentId: parentId || null,
    name: typeof node.name === 'string' ? node.name : node.type,
    type: node.type,
    x: isNumber(node.x) ? round(node.x) : round(box.x - origin.x),
    y: isNumber(node.y) ? round(node.y) : round(box.y - origin.y),
    boardX: round(box.x - origin.x),
    boardY: round(box.y - origin.y),
    absoluteBoundingBox: box,
    rotation: isNumber(node.rotation) ? round(node.rotation) : 0,
    opacity: isNumber(node.opacity) ? round(node.opacity) : 1,
    visible: node.visible !== false,
    ...exportRadii(node),
    fills: paints,
    strokes: exportPaints(node.strokes),
    strokeWeight: isNumber(node.strokeWeight) ? round(node.strokeWeight) : undefined,
    strokeAlign: node.strokeAlign,
    effects: exportEffects(node.effects),
    hasImageFill: Boolean(imagePaint),
    imageFillNodeId: imagePaint ? node.id : null,
    ...exportTextFields(node),
    children: [],
  };
  if (Array.isArray(node.children)) {
    out.children = node.children.map((child) => exportNode(child, node.id, origin));
  }
  return out;
}

/** 选中优先；没有选中则取当前页顶层画板（FRAME / COMPONENT / INSTANCE） */
function pickArtboards() {
  const selection = figma.currentPage.selection || [];
  if (selection.length > 0) return selection;
  return Array.from(figma.currentPage.children || []).filter((n) => ARTBOARD_TYPES.indexOf(n.type) >= 0);
}

function countNodes(node) {
  let n = 1;
  if (Array.isArray(node.children)) {
    for (const child of node.children) n += countNodes(child);
  }
  return n;
}

function buildExport() {
  const artboards = pickArtboards();
  if (!artboards.length) {
    return {
      ok: false,
      message: '当前页没有画板：请先选中一个画板（FRAME / COMPONENT / INSTANCE）再导出。',
    };
  }
  const originHolders = artboards.map((node) => ({
    node,
    origin: boundingBox(node),
  }));
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generator: 'shejixiezuo-figma-plugin',
    exportedAt: new Date().toISOString(),
    file: {
      name: figma.root && typeof figma.root.name === 'string' ? figma.root.name : undefined,
      fileKey: typeof figma.fileKey === 'string' ? figma.fileKey : undefined,
      pageName: figma.currentPage && figma.currentPage.name,
    },
    artboards: originHolders.map(({ node, origin }) => exportNode(node, null, origin)),
  };
  const nodeCount = payload.artboards.reduce((sum, a) => sum + countNodes(a), 0);
  return {
    ok: true,
    payload,
    stats: { artboards: payload.artboards.length, nodes: nodeCount },
  };
}

figma.ui.onmessage = (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'export' || msg.type === 'ready') {
    try {
      figma.ui.postMessage(Object.assign({ type: 'export-result' }, buildExport()));
    } catch (err) {
      figma.ui.postMessage({
        type: 'export-result',
        ok: false,
        message: '导出失败：' + (err && err.message ? err.message : String(err)),
      });
    }
    return;
  }
  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
