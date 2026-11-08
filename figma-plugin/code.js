/**
 * 设计协作 · 导出向导（Figma 插件主线程）
 * 沙箱里没有 DOM / fetch：网络请求全部由 ui.html 的 iframe 发出；
 * 这里只负责读画板、导出 JSON、按倍率导出 PNG（base64）与读写 clientStorage 偏好。
 */
const PLUGIN_VERSION = '1.1.0';
const BUILD_DATE = '2026-11-08';
const SCHEMA_VERSION = 1;
const PREFS_KEY = 'designhub-plugin-prefs';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ARTBOARD_TYPES = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'];

// 启动第一句就开窗：避免任何加载逻辑让用户觉得「点了没反应」
try {
  figma.showUI(__html__, { width: 480, height: 720, title: '设计协作 · 导出向导' });
} catch (err) {
  figma.notify('插件窗口打开失败：' + (err instanceof Error ? err.message : String(err)));
  throw err;
}

/** 序列化安全：Figma 的 Paint / Effect 等对象可能带内部字段 */
function safe(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    return null;
  }
}

function post(message) {
  try {
    figma.ui.postMessage(message);
  } catch (err) {
    // 窗口已关闭时忽略
  }
}

function reportError(err, prefix) {
  const message = (prefix ? prefix + '：' : '') + (err instanceof Error ? err.message : String(err));
  post({ type: 'error', message });
  figma.notify(message, { timeout: 6000 });
}

/** 读取节点缩放/旋转/圆角等可选属性 */
function copyVisual(node, out) {
  if ('rotation' in node) out.rotation = node.rotation;
  if ('opacity' in node) out.opacity = node.opacity;
  if ('visible' in node) out.visible = node.visible;
  if ('blendMode' in node) out.blendMode = node.blendMode;
  if ('cornerRadius' in node) out.cornerRadius = node.cornerRadius;
  if ('cornerRadii' in node) out.cornerRadii = safe(node.cornerRadii);
  if ('fills' in node) out.fills = safe(node.fills);
  if ('strokes' in node) out.strokes = safe(node.strokes);
  if ('strokeWeight' in node) out.strokeWeight = node.strokeWeight;
  if ('strokeAlign' in node) out.strokeAlign = node.strokeAlign;
  if ('effects' in node) out.effects = safe(node.effects);
  if ('clipsContent' in node) out.clipsContent = node.clipsContent;
}

/** 导出子树：字段与网站 schemaVersion 1 对应 */
function exportNode(node, parentId) {
  const out = {
    id: node.id,
    parentId: parentId || null,
    name: node.name,
    type: node.type,
    x: node.x,
    y: node.y,
    boardX: node.x,
    boardY: node.y,
    absoluteBoundingBox: safe(node.absoluteBoundingBox),
    width: node.width,
    height: node.height,
  };
  copyVisual(node, out);

  if ('characters' in node) {
    out.characters = node.characters;
    out.style = safe({
      fontFamily: node.fontName && node.fontName !== figma.mixed ? node.fontName.family : undefined,
      fontStyle: node.fontName && node.fontName !== figma.mixed ? node.fontName.style : undefined,
      fontSize: node.fontSize !== figma.mixed ? node.fontSize : undefined,
      fontWeight: node.fontWeight,
      lineHeightPx: node.lineHeight && node.lineHeight !== figma.mixed ? node.lineHeight.value : undefined,
      lineHeightUnit: node.lineHeight && node.lineHeight !== figma.mixed ? node.lineHeight.unit : undefined,
      letterSpacing: node.letterSpacing !== figma.mixed ? node.letterSpacing : undefined,
      textAlignHorizontal: node.textAlignHorizontal,
      textAlignVertical: node.textAlignVertical,
      textAutoResize: node.textAutoResize,
    });
  }

  if (Array.isArray(out.fills)) {
    const imagePaint = out.fills.find((f) => f && f.type === 'IMAGE' && f.visible !== false);
    if (imagePaint) {
      out.hasImageFill = true;
      out.imageFillNodeId = imagePaint.imageHash || null;
    }
  }

  out.children = 'children' in node ? node.children.map((child) => exportNode(child, node.id)) : [];
  return out;
}

/** 兼容 dynamic-page 的节点查找 */
async function getNodeById(id) {
  if (typeof figma.getNodeByIdAsync === 'function') return figma.getNodeByIdAsync(id);
  return figma.getNodeById(id);
}

/** dynamic-page 下读取页面 children 前必须加载 */
async function ensureCurrentPageLoaded() {
  try {
    if (figma.currentPage && typeof figma.currentPage.loadAsync === 'function') {
      await figma.currentPage.loadAsync();
    }
  } catch (err) {
    try {
      await figma.loadAllPagesAsync();
    } catch (err2) {
      // 页面已加载时可能抛错，忽略
    }
  }
}

function countNodes(node, budget) {
  let count = 1;
  if ('children' in node) {
    for (const child of node.children) {
      count += countNodes(child, budget);
      if (count >= budget) return budget;
    }
  }
  return count;
}

function isArtboard(node) {
  return ARTBOARD_TYPES.indexOf(node.type) >= 0;
}

async function listBoards() {
  await ensureCurrentPageLoaded();
  const selected = new Set(figma.currentPage.selection.map((n) => n.id));
  const boards = figma.currentPage.children
    .filter(isArtboard)
    .map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      width: Math.round(node.width * 100) / 100,
      height: Math.round(node.height * 100) / 100,
      x: Math.round(node.x),
      y: Math.round(node.y),
      selected: selected.has(node.id),
      nodeCount: countNodes(node, 2000),
    }));
  return {
    ok: true,
    pageName: figma.currentPage.name,
    fileName: figma.root.name || 'Figma 文件',
    boards,
    selectionCount: selected.size,
  };
}

/** Uint8Array → base64（沙箱没有 btoa，手写编码） */
function bytesToBase64(bytes) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += B64[(triple >> 18) & 63];
    out += B64[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[triple & 63] : '=';
  }
  return out;
}

function basePayload(artboards) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generator: 'shejixiezuo-figma-plugin',
    pluginVersion: PLUGIN_VERSION,
    exportedAt: new Date().toISOString(),
    file: { name: figma.root.name || 'Figma 文件', pageName: figma.currentPage.name },
    artboards,
  };
}

/** 导出单个画板（JSON + 可选 PNG），供向导逐个上传 */
async function exportBoard(boardId, scale, includeImage) {
  await ensureCurrentPageLoaded();
  const node = await getNodeById(boardId);
  if (!node) return { ok: false, message: `找不到画板 ${boardId}，请返回第一步刷新画板列表` };
  if (!isArtboard(node)) return { ok: false, message: `「${node.name}」不是画板（${node.type}）` };

  const artboard = exportNode(node, null);
  const payload = basePayload([artboard]);

  let image = null;
  let imageBytes = 0;
  let imageSkipped = null;
  if (includeImage) {
    try {
      const bytes = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: scale },
      });
      imageBytes = bytes.length;
      if (bytes.length > MAX_IMAGE_BYTES) {
        imageSkipped = `位图 ${(bytes.length / 1024 / 1024).toFixed(1)}MB 超过 5MB，已跳过图片`;
      } else {
        image = bytesToBase64(bytes);
      }
    } catch (err) {
      imageSkipped = `位图导出失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { ok: true, boardId: node.id, name: node.name, payload, image, imageBytes, imageSkipped };
}

/** 仅导出 JSON（不上传）：合并多个画板为一份 payload */
async function exportBoardsJson(boardIds) {
  await ensureCurrentPageLoaded();
  const ids = Array.isArray(boardIds) && boardIds.length ? boardIds : figma.currentPage.children.filter(isArtboard).map((n) => n.id);
  const artboards = [];
  for (const id of ids) {
    const node = await getNodeById(id);
    if (node && isArtboard(node)) artboards.push(exportNode(node, null));
  }
  if (!artboards.length) return { ok: false, message: '没有可导出的画板' };
  return { ok: true, payload: basePayload(artboards) };
}

async function loadPrefs() {
  try {
    const prefs = await figma.clientStorage.getAsync(PREFS_KEY);
    return prefs && typeof prefs === 'object' ? prefs : {};
  } catch (err) {
    return {};
  }
}

async function savePrefs(prefs) {
  try {
    await figma.clientStorage.setAsync(PREFS_KEY, prefs);
  } catch (err) {
    // 偏好保存失败不影响导出
  }
}

figma.ui.onmessage = async (msg) => {
  const type = msg && msg.type;
  try {
    if (type === 'ready') {
      const prefs = await loadPrefs();
      post({
        type: 'boot',
        pluginVersion: PLUGIN_VERSION,
        buildDate: BUILD_DATE,
        fileName: figma.root.name || 'Figma 文件',
        pageName: figma.currentPage.name,
      });
      post({ type: 'prefs', prefs });
      post({ type: 'boards', ...(await listBoards()) });
      return;
    }
    if (type === 'list-boards') {
      post({ type: 'boards', requestId: msg.requestId, ...(await listBoards()) });
      return;
    }
    if (type === 'export-board') {
      const scale = [1, 2, 3].indexOf(Number(msg.scale)) >= 0 ? Number(msg.scale) : 2;
      post({ type: 'progress', stage: 'read', boardId: msg.boardId, message: '读取节点…' });
      const result = await exportBoard(msg.boardId, scale, !!msg.includeImage);
      post({ type: 'board-exported', requestId: msg.requestId, ...result });
      return;
    }
    if (type === 'export-json') {
      const result = await exportBoardsJson(msg.boardIds);
      post({ type: 'json-result', requestId: msg.requestId, ...result });
      return;
    }
    if (type === 'save-prefs') {
      await savePrefs(msg.prefs && typeof msg.prefs === 'object' ? msg.prefs : {});
      post({ type: 'prefs-saved' });
      return;
    }
    if (type === 'notify') {
      if (typeof msg.message === 'string' && msg.message) figma.notify(msg.message);
      return;
    }
    if (type === 'resize') {
      const width = Number(msg.width) || 480;
      const height = Number(msg.height) || 720;
      figma.ui.resize(width, height);
      return;
    }
    if (type === 'close') {
      figma.closePlugin();
    }
  } catch (err) {
    reportError(err, '操作失败');
  }
};
