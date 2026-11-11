/**
 * 设计协作 · 导出向导（Figma 插件主线程）
 * 沙箱里没有 DOM / fetch：网络请求全部由 ui.html 的 iframe 发出；
 * 这里只负责读画板、导出 JSON、按倍率导出 PNG（base64）与读写 clientStorage 偏好。
 */
const PLUGIN_VERSION = '1.3.9';
const BUILD_DATE = '2026-11-11';
const SCHEMA_VERSION = 1;
const PREFS_KEY = 'designhub-plugin-prefs';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ARTBOARD_TYPES = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'];

// 不同阶段给 UI 不同的「静默上限」：读取节点 30 秒 / 单张切图 90 秒 / 单板上传 60 秒。
// exportAsync 是主线程同步阻塞的，这段时间发不出任何消息，用一个统一阈值会误杀。
const SILENCE_NODES_MS = 60000;
const SILENCE_IMAGE_MS = 120000;
// base64 分片：每片 256KB 源字节，取 3 的整数倍（262143）保证各片编码可直接拼接
const IMAGE_CHUNK_BYTES = 262143;
// 逐图层高清切图：单板上传的切片数上限（与服务端 MAX_SLICES_PER_REQUEST 对齐）
const MAX_SLICES_PER_BOARD = 120;
// 位图填充识别的递归深度上限：防止超深嵌套把导出卡住
const MAX_WALK_DEPTH = 24;

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

// Figma 里改变选中后自动同步列表（列表是选中项只读镜像，不需要用户在插件里勾选）
try {
  figma.on('selectionchange', () => {
    listBoards()
      .then((data) => post({ type: 'boards', ...data }))
      .catch(() => undefined);
  });
} catch (err) {
  // 旧版本 Figma 没有该事件时忽略，重新运行插件仍可同步
}

function reportError(err, prefix, requestId) {
  const message = (prefix ? prefix + '：' : '') + (err instanceof Error ? err.message : String(err));
  post({ type: 'error', requestId: requestId || undefined, message });
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

/** 让出一次宏任务，避免大画板序列化把主线程整段占住 */
function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 时间戳（毫秒）：用于把每个阶段的真实耗时回传 UI */
function nowMs() {
  return Date.now();
}

/** 进度心跳：UI 收到后就把「无响应」计时重置为当前阶段的静默上限 */
function postProgress(ctx, stage, done, message, silenceMs) {
  if (!ctx || !ctx.requestId) return;
  post({
    type: 'progress',
    requestId: ctx.requestId,
    stage: stage,
    done: done,
    total: ctx.total || 1,
    message: message || '',
    silenceMs: silenceMs || SILENCE_NODES_MS,
  });
}

/** 导出子树：字段与网站 schemaVersion 1 对应；每 300 个节点发一次心跳并让出事件循环 */
async function exportNodeAsync(node, parentId, ctx) {
  ctx.count = (ctx.count || 0) + 1;
  if (ctx.count % 100 === 0) {
    postProgress(ctx, 'nodes', ctx.index, '读取节点…（已 ' + ctx.count + ' 个）', SILENCE_NODES_MS);
    await nextTask();
  }

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

  // 切图标记：图层在 Figma 里的 Export 预设。网站端解析与 REST 导入同款
  // （parseExportPresets 读 exportSettings 字段），漏掉这一项就会「无法识别切图」。
  if (Array.isArray(node.exportSettings) && node.exportSettings.length) {
    out.exportSettings = safe(node.exportSettings);
  }

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

  out.children = [];
  if ('children' in node) {
    for (const child of node.children) {
      out.children.push(await exportNodeAsync(child, node.id, ctx));
    }
  }
  return out;
}

/** 兼容 dynamic-page 的节点查找 */
async function getNodeById(id) {
  if (typeof figma.getNodeByIdAsync === 'function') return figma.getNodeByIdAsync(id);
  return figma.getNodeById(id);
}

/** dynamic-page 下只需加载当前页；不调用 loadAllPagesAsync，避免大文件整页加载卡死 */
async function ensurePageLoaded() {
  try {
    if (figma.currentPage && typeof figma.currentPage.loadAsync === 'function') {
      await figma.currentPage.loadAsync();
    }
  } catch (err) {
    // 页面已加载时可能抛错，忽略
  }
}

function isArtboard(node) {
  return ARTBOARD_TYPES.indexOf(node.type) >= 0;
}

async function listBoards() {
  await ensurePageLoaded();
  const selection = figma.currentPage.selection || [];
  // 只读镜像当前选中项：不再遍历整页 children，大文件也不会卡在「读取节点」
  const boards = selection.filter(isArtboard).map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    width: Math.round(node.width * 100) / 100,
    height: Math.round(node.height * 100) / 100,
    x: Math.round(node.x),
    y: Math.round(node.y),
    selected: true,
  }));
  return {
    ok: true,
    pageName: figma.currentPage.name,
    fileName: figma.root.name || 'Figma 文件',
    boards,
    selectionCount: selection.length,
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

/**
 * base64 分片回传：每片 256KB 源字节，片与片之间让出事件循环。
 * 一次性 postMessage 整个 base64（一张 2x 切图常有数 MB）会把主线程和消息序列化一起卡住，
 * 分片后每片只阻塞很短时间，心跳能持续发出。
 */
async function sendImageChunks(ctx, boardId, bytes, timings) {
  const total = Math.max(1, Math.ceil(bytes.length / IMAGE_CHUNK_BYTES));
  for (let seq = 0; seq < total; seq++) {
    const start = seq * IMAGE_CHUNK_BYTES;
    const end = Math.min(bytes.length, start + IMAGE_CHUNK_BYTES);
    const slice = typeof bytes.subarray === 'function' ? bytes.subarray(start, end) : bytes.slice(start, end);
    const t0 = nowMs();
    const data = bytesToBase64(slice);
    timings.base64Ms += nowMs() - t0;
    const t1 = nowMs();
    post({ type: 'image-chunk', requestId: ctx.requestId, boardId: boardId, seq: seq, total: total, data: data });
    timings.postMs += nowMs() - t1;
    await nextTask();
  }
  return total;
}

/**
 * 图层子树内是否含位图填充（Paint type = IMAGE）：
 * 含 → 元素本质是位图，按 PNG @4x 导出（4x 源供 0.5–4x 任意倍率降采样）；
 * 不含 → 元素本质是矢量，除 PNG @4x 外再导一份真矢量 SVG（SVG 下载任意缩放清晰）。
 * fills 可能是 figma.mixed 或内部对象，读不到时按「无位图」处理（宁可多给矢量）。
 */
function hasImageFill(node, depth) {
  if (depth <= 0) return false;
  try {
    const fills = node.fills;
    if (Array.isArray(fills) && fills.some((f) => f && f.type === 'IMAGE')) return true;
  } catch (err) { /* 读不到填充信息，不当作位图 */ }
  if ('children' in node && Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      if (hasImageFill(node.children[i], depth - 1)) return true;
    }
  }
  return false;
}

/** 收集画板内带 Figma Export 标记的图层（与网站端「切图」概念一致，跳过画板自身） */
function collectSliceNodes(root, max) {
  const found = [];
  (function walk(node, depth) {
    if (found.length >= max || depth > MAX_WALK_DEPTH) return;
    if (node !== root && Array.isArray(node.exportSettings) && node.exportSettings.length) {
      found.push(node);
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i++) walk(node.children[i], depth + 1);
    }
  })(root, 0);
  return found;
}

/** 单张切图分片回传：复用 image-chunk 通道，bufferKey = 请求id:slice:序号，UI 按此拼装。
 * 注意 requestId 传 ask 的请求 id（分片期间 UI 靠它重置「无响应」计时），bufferKey 单独携带 */
async function sendSliceChunks(ctx, bufferKey, bytes) {
  const total = Math.max(1, Math.ceil(bytes.length / IMAGE_CHUNK_BYTES));
  for (let seq = 0; seq < total; seq++) {
    const start = seq * IMAGE_CHUNK_BYTES;
    const end = Math.min(bytes.length, start + IMAGE_CHUNK_BYTES);
    const slice = typeof bytes.subarray === 'function' ? bytes.subarray(start, end) : bytes.slice(start, end);
    const data = bytesToBase64(slice);
    post({ type: 'image-chunk', requestId: ctx.requestId, bufferKey: bufferKey, boardId: null, seq: seq, total: total, data: data });
    await nextTask();
  }
  return total;
}

/**
 * 逐图层高清切图：按元素本性导出——纯矢量图层出 PNG@4x + 真矢量 SVG，
 * 位图图层出 PNG@4x。切片经由现有 POST /api/plugin/slices 入库（source='figma'），
 * 网站端任意倍率导出时优先从 4x 源降采样 / 直接复用矢量，不再放大 1x 位图。
 */
async function exportSlices(rootNode, ctx, timings) {
  const nodes = collectSliceNodes(rootNode, MAX_SLICES_PER_BOARD);
  const warnings = [];
  const slices = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const label = '逐图层切图 ' + (i + 1) + '/' + nodes.length + '：「' + n.name + '」';
    const vector = !hasImageFill(n, MAX_WALK_DEPTH);
    const wanted = vector
      ? [['PNG', 4], ['SVG', 1]]
      : [['PNG', 4]];
    for (let w = 0; w < wanted.length; w++) {
      const format = wanted[w][0];
      const scale = wanted[w][1];
      try {
        postProgress(ctx, 'images', ctx.index, label + '（' + format + ' 导出中）…', SILENCE_IMAGE_MS);
        await nextTask();
        const t0 = nowMs();
        const bytes = await n.exportAsync({ format: format, constraint: { type: 'SCALE', value: scale } });
        timings.exportMs += nowMs() - t0;
        if (!bytes || !bytes.length) {
          warnings.push('「' + n.name + '」的 ' + format + ' 切图导出为空，已跳过');
          continue;
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
          warnings.push('「' + n.name + '」的 ' + format + ' 切图 ' + (bytes.length / 1024 / 1024).toFixed(1) + 'MB 超过 5MB，已跳过');
          continue;
        }
        postProgress(ctx, 'images', ctx.index, label + '（' + format + ' 回传中）…', SILENCE_IMAGE_MS);
        const bufferKey = ctx.requestId + ':slice:' + slices.length;
        const chunks = await sendSliceChunks(ctx, bufferKey, bytes);
        slices.push({ key: bufferKey, nodeId: n.id, name: n.name, format: format, scale: scale, chunks: chunks });
      } catch (err) {
        warnings.push('「' + n.name + '」的 ' + format + ' 切图导出失败：' + (err instanceof Error ? err.message : String(err)));
      }
      await nextTask();
    }
  }
  if (!nodes.length) warnings.push('该画板没有带 Figma Export 标记的图层，未生成逐图层切图（在 Figma 里给图层添加 Export 设置后重新导入）');
  return { slices: slices, warnings: warnings };
}

/** 导出单个画板（JSON + 可选 PNG），逐板发进度心跳，供向导逐个上传 */
async function exportBoard(boardId, scale, includeImage, includeSlices, ctx) {
  const index = (ctx && ctx.index) || 0;
  const timings = { loadMs: 0, serializeMs: 0, exportMs: 0, base64Ms: 0, postMs: 0, totalMs: 0 };
  const startedAt = nowMs();
  postProgress(ctx, 'nodes', index, '读取节点…', SILENCE_NODES_MS);

  const tLoad = nowMs();
  await ensurePageLoaded();
  const node = await getNodeById(boardId);
  timings.loadMs = nowMs() - tLoad;

  if (!node) return { ok: false, message: `找不到画板 ${boardId}，请重新打开插件刷新画板列表`, timings };
  if (!isArtboard(node)) return { ok: false, message: `「${node.name}」不是画板（${node.type}）`, timings };

  const tSerialize = nowMs();
  const artboard = await exportNodeAsync(node, null, Object.assign({}, ctx, { count: 0 }));
  timings.serializeMs = nowMs() - tSerialize;
  const payload = basePayload([artboard]);
  postProgress(ctx, 'nodes', index + 1, '已读取「' + node.name + '」（' + timings.serializeMs + 'ms）', SILENCE_NODES_MS);
  await nextTask();

  let image = null;
  let imageChunks = 0;
  let imageBytes = 0;
  let imageSkipped = null;
  if (includeImage) {
    const label = '第 ' + (index + 1) + ' / ' + (ctx.total || 1) + ' 张：' + node.name +
      '（' + Math.round(node.width) + '×' + Math.round(node.height) + ' @' + scale + 'x）';
    // 先在导出前发一条：UI 立刻显示「正在导出第 N 张（1229×883 @2x）…」
    postProgress(ctx, 'images', index, '正在导出' + label + '…', SILENCE_IMAGE_MS);
    await nextTask();

    const tExport = nowMs();
    try {
      const bytes = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: scale },
      });
      timings.exportMs = nowMs() - tExport;
      imageBytes = bytes.length;
      if (bytes.length > MAX_IMAGE_BYTES) {
        imageSkipped = `位图 ${(bytes.length / 1024 / 1024).toFixed(1)}MB 超过 5MB，已跳过图片`;
      } else {
        postProgress(ctx, 'images', index, '切图已生成（' + timings.exportMs + 'ms，' +
          (bytes.length / 1024).toFixed(0) + 'KB），正在分片回传…', SILENCE_IMAGE_MS);
        imageChunks = await sendImageChunks(ctx, node.id, bytes, timings);
      }
    } catch (err) {
      timings.exportMs = nowMs() - tExport;
      imageSkipped = `位图导出失败：${err instanceof Error ? err.message : String(err)}`;
    }
    postProgress(ctx, 'images', index + 1,
      '已导出' + label + '（' + timings.exportMs + 'ms）', SILENCE_NODES_MS);
  }

  // 逐图层高清切图：矢量元素导真矢量 SVG，位图/矢量统一导 4x PNG（降采样永远比放大清晰）
  let slices = [];
  let sliceWarnings = [];
  if (includeSlices) {
    postProgress(ctx, 'images', index, '开始逐图层高清切图…', SILENCE_NODES_MS);
    await nextTask();
    const sliceResult = await exportSlices(node, ctx, timings);
    slices = sliceResult.slices;
    sliceWarnings = sliceResult.warnings;
    postProgress(ctx, 'images', index,
      slices.length ? '已生成 ' + slices.length + ' 张逐图层切图' : '无逐图层切图', SILENCE_NODES_MS);
    await nextTask();
  }

  timings.totalMs = nowMs() - startedAt;
  console.log('[timing] board=' + node.name + ' ' + JSON.stringify(timings));
  // 图片不再塞进这一条消息，改由 image-chunk 分片，UI 侧拼装
  return {
    ok: true,
    boardId: node.id,
    name: node.name,
    width: Math.round(node.width * 100) / 100,
    height: Math.round(node.height * 100) / 100,
    payload,
    image: null,
    imageChunks,
    imageBytes,
    imageSkipped,
    slices,
    sliceWarnings,
    timings,
  };
}

/** 仅导出 JSON（不上传）：合并多个画板为一份 payload，逐板发心跳 */
async function exportBoardsJson(boardIds, ctx) {
  await ensurePageLoaded();
  const ids = Array.isArray(boardIds) && boardIds.length ? boardIds : figma.currentPage.selection.filter(isArtboard).map((n) => n.id);
  const total = ids.length;
  const artboards = [];
  for (let i = 0; i < total; i++) {
    postProgress(ctx, 'nodes', i, '读取第 ' + (i + 1) + ' / ' + total + ' 个画板…', SILENCE_NODES_MS);
    const node = await getNodeById(ids[i]);
    if (node && isArtboard(node)) {
      artboards.push(await exportNodeAsync(node, null, Object.assign({}, ctx, { count: 0 })));
    }
    postProgress(ctx, 'nodes', i + 1, '已读取第 ' + (i + 1) + ' 个画板', SILENCE_NODES_MS);
    await nextTask();
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
      const scale = [1, 2, 3, 4].indexOf(Number(msg.scale)) >= 0 ? Number(msg.scale) : 2;
      const ctx = { requestId: msg.requestId, index: Number(msg.index) || 0, total: Number(msg.total) || 1, count: 0 };
      const result = await exportBoard(msg.boardId, scale, !!msg.includeImage, !!msg.includeSlices, ctx);
      post({ type: 'board-exported', requestId: msg.requestId, ...result });
      return;
    }
    if (type === 'export-json') {
      const ctx = { requestId: msg.requestId, index: 0, total: Array.isArray(msg.boardIds) ? msg.boardIds.length : 0 };
      const result = await exportBoardsJson(msg.boardIds, ctx);
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
    // 必须把真实异常回传 UI，否则界面只会报「主线程无响应」
    reportError(err, '操作失败', (msg && msg.requestId) || null);
  }
};
