/**
 * 测试 Figma 插件 v1.9.0 单令牌架构（v5→v6 迁移 + 站点自动探测）。
 * ui.html 是 data: iframe 内联脚本，无法直接 import——抽取相关函数源码在 Node 沙箱执行。
 * 覆盖：
 *   A. normalizePrefs：v5 profiles 扁平化、激活配置优先、空令牌退到非空配置、顶层兜底、v6 直通、域名丢弃。
 *   B. detectSite：谁认传谁、全 401 报令牌无效、网络失败保留信息、多站点命中告警、异常状态码。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const uiPath = path.join(__dirname, '..', 'figma-plugin', 'ui.html');
const html = fs.readFileSync(uiPath, 'utf8');

// 从 ui.html 抽取指定函数（括号计数匹配函数体；保留 async 前缀）
function extractFn(name) {
  const sig = 'function ' + name + '(';
  const found = html.indexOf(sig);
  if (found < 0) throw new Error('找不到函数 ' + name);
  // 若前面紧邻 async，则把 async 一起带上
  const before = html.slice(Math.max(0, found - 6), found);
  const isAsync = /async\s+$/.test(before);
  const start = isAsync ? found - 6 : found;
  let i = html.indexOf('{', found);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}

// 抽取 SITES 常量块
const sitesMatch = html.match(/var SITES = (\[[\s\S]*?\]);/);
if (!sitesMatch) throw new Error('抽取 SITES 失败');

const fnNames = ['normalizePrefs', 'recordNet', 'probeSite', 'detectSite'];
const fnSrc = fnNames.map(extractFn).join('\n');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}

// ---------- A. normalizePrefs ----------
const preamble = `
var SITES = ${sitesMatch[1]};
var state = { baseUrl: '', siteName: '' };
var consoleShim = { warn: function(){}, log: function(){} };
${fnSrc}
this.__normalizePrefs = normalizePrefs;
this.__setState = function (s) { state.baseUrl = s.baseUrl || ''; state.siteName = s.siteName || ''; };
this.__getState = function () { return { baseUrl: state.baseUrl, siteName: state.siteName }; };
`;
const sandboxA = { console: { warn: () => {}, log: () => {} }, Math, Date, Promise };
vm.createContext(sandboxA);
vm.runInContext(preamble, sandboxA);
const normalizePrefs = sandboxA.__normalizePrefs;

const NEW = 'https://sjxz.yundongchangzu.com';
const OLD = 'https://www.shilipix.cn';

console.log('== A1：v5 激活配置的令牌与目标被保留，域名被丢弃 ==');
{
  const r = normalizePrefs({
    version: 5,
    profiles: [
      { id: 'p1', baseUrl: OLD, token: 'imp_OLD_OK', teamId: 't1', projectId: 'pr1', groupId: 'g1', newGroupName: 'ng' },
      { id: 'p2', baseUrl: NEW, token: 'imp_NEW_OK', teamId: 't2', projectId: '', groupId: '', newGroupName: '' },
    ],
    activeProfileId: 'p1',
    platform: 'ios', scale: 3,
  });
  check('版本升为 6', r.version === 6, r.version);
  check('激活配置令牌保留', r.token === 'imp_OLD_OK', r.token);
  check('三级目标保留', r.teamId === 't1' && r.projectId === 'pr1' && r.groupId === 'g1' && r.newGroupName === 'ng');
  check('platform/scale 保留', r.platform === 'ios' && r.scale === 3);
  check('无 profiles 字段', !('profiles' in r));
  check('无 baseUrl 字段（域名丢弃）', !('baseUrl' in r));
}

console.log('== A2：激活配置令牌为空 → 退到第一个有令牌的配置 ==');
{
  const r = normalizePrefs({
    version: 5,
    profiles: [
      { id: 'p1', baseUrl: NEW, token: '', teamId: '', projectId: '', groupId: '', newGroupName: '' },
      { id: 'p2', baseUrl: OLD, token: 'imp_FALLBACK', teamId: 'tf', projectId: 'pf', groupId: 'gf', newGroupName: '' },
    ],
    activeProfileId: 'p1',
  });
  check('退到第二个配置的令牌', r.token === 'imp_FALLBACK', r.token);
  check('三级目标来自该配置', r.teamId === 'tf' && r.projectId === 'pf' && r.groupId === 'gf');
}

console.log('== A3：profiles 全无令牌 → 顶层镜像兜底（v4 兼容）==');
{
  const r = normalizePrefs({
    version: 4,
    profiles: [{ id: 'p1', baseUrl: NEW, token: '', teamId: '', projectId: '', groupId: '', newGroupName: '' }],
    activeProfileId: 'p1',
    token: 'imp_TOPLEVEL', teamId: 'tt', projectId: 'tp', groupId: 'tg', newGroupName: 'tn',
  });
  check('顶层令牌兜底', r.token === 'imp_TOPLEVEL', r.token);
  check('顶层目标兜底', r.teamId === 'tt' && r.projectId === 'tp' && r.groupId === 'tg' && r.newGroupName === 'tn');
}

console.log('== A4：纯 v4 单配置（无 profiles）==');
{
  const r = normalizePrefs({ version: 4, baseUrl: OLD, token: 'imp_V4', teamId: 'v4t', projectId: '', groupId: '', newGroupName: '' });
  check('v4 令牌保留', r.token === 'imp_V4', r.token);
  check('v4 目标保留', r.teamId === 'v4t');
  check('域名不进输出', !('baseUrl' in r));
}

console.log('== A5：v6 数据直通（applyPrefs 里 version>=6 不走迁移，这里验证迁移函数本身不影响）==');
{
  // applyPrefs 对 v6 直接用 prefs；此处确认 normalizePrefs 对 v6 输入也不破坏 token
  const r = normalizePrefs({ version: 6, token: 'imp_V6', teamId: 'v6t', projectId: 'v6p', groupId: 'v6g', newGroupName: '', platform: 'web', scale: 1 });
  check('v6 令牌保留', r.token === 'imp_V6', r.token);
  check('v6 目标保留', r.teamId === 'v6t' && r.projectId === 'v6p' && r.groupId === 'v6g');
}

console.log('== A6：空 prefs（新安装兜底）==');
{
  const r = normalizePrefs({});
  check('版本 6', r.version === 6);
  check('令牌为空', r.token === '');
  check('无域名', !('baseUrl' in r));
}

// ---------- B. detectSite（mock fetch）----------
// 为每个沙箱构造一个带 mock fetch 的上下文
function makeDetectSandbox(fetchImpl) {
  const sb = {
    console: { warn: () => {}, log: () => {} },
    Math, Date, Promise,
    fetch: fetchImpl,
  };
  vm.createContext(sb);
  vm.runInContext(`
    var SITES = ${sitesMatch[1]};
    var state = { baseUrl: '', siteName: '' };
    ${['recordNet', 'probeSite', 'detectSite'].map(extractFn).join('\n')}
    this.__detectSite = detectSite;
    this.__getState = function () { return { baseUrl: state.baseUrl, siteName: state.siteName }; };
  `, sb);
  return sb;
}

console.log('== B1：只有一个站点认令牌 → 传到该站 ==');
{
  // 新站 200（teamId 有值），旧站 401
  const fetchMock = async (url) => {
    if (url.indexOf('sjxz.yundongchangzu.com') >= 0) {
      return { ok: true, status: 200, json: async () => ({ teamId: 't', teamName: '新站团队', scope: 'team' }) };
    }
    return { ok: false, status: 401, json: async () => ({ error: 'invalid token' }) };
  };
  const sb = makeDetectSandbox(fetchMock);
  sb.__detectSite('imp_X').then((hit) => {
    check('命中新站', hit.site.id === 'new', hit.site.id);
    check('带团队信息', hit.me.teamId === 't');
    const st = sb.__getState();
    check('state.baseUrl 设为新站', st.baseUrl === NEW, st.baseUrl);
    check('state.siteName 设为新站', st.siteName === '新站', st.siteName);
    finishAsync();
  }).catch((e) => { check('B1 不应抛错', false, e.message); finishAsync(); });
}

console.log('== B2：只有旧站认令牌 → 传到旧站 ==');
{
  const fetchMock = async (url) => {
    if (url.indexOf('www.shilipix.cn') >= 0) {
      return { ok: true, status: 200, json: async () => ({ teamId: 'o', teamName: '旧站团队', scope: 'all' }) };
    }
    return { ok: false, status: 401, json: async () => ({ error: 'invalid token' }) };
  };
  const sb = makeDetectSandbox(fetchMock);
  sb.__detectSite('imp_OLD').then((hit) => {
    check('命中旧站', hit.site.id === 'old', hit.site.id);
    const st = sb.__getState();
    check('state.baseUrl 设为旧站', st.baseUrl === OLD, st.baseUrl);
    check('state.siteName 设为旧站', st.siteName === '旧站', st.siteName);
    finishAsync();
  }).catch((e) => { check('B2 不应抛错', false, e.message); finishAsync(); });
}

console.log('== B3：两站都 401 → 抛令牌无效(401) ==');
{
  const fetchMock = async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid' }) });
  const sb = makeDetectSandbox(fetchMock);
  sb.__detectSite('imp_BAD').then(() => {
    check('B3 应抛错', false, '未抛');
    finishAsync();
  }).catch((e) => {
    check('抛 401', e.status === 401, String(e.status));
    check('文案含重新生成', /重新生成/.test(e.message), e.message);
    finishAsync();
  });
}

console.log('== B4：一站 200 但无 teamId（异常）+ 另一站 401 → 视为无命中，非 401 单站判定 ==');
{
  const fetchMock = async (url) => {
    if (url.indexOf('sjxz') >= 0) return { ok: true, status: 200, json: async () => ({ scope: 'team' }) }; // 缺 teamId
    return { ok: false, status: 401, json: async () => ({ error: 'invalid' }) };
  };
  const sb = makeDetectSandbox(fetchMock);
  sb.__detectSite('imp_X').then(() => {
    check('B4 应抛错（200 缺 teamId 不算命中）', false, '未抛');
    finishAsync();
  }).catch((e) => {
    check('不误报 401（因为并非两站都 401）', e.status !== 401, String(e.status));
    check('文案含站点异常', /异常|HTTP/.test(e.message), e.message);
    finishAsync();
  });
}

console.log('== B5：一站网络失败（status 0）+ 另一站 401 → 报连接错误，保留具体站点 ==');
{
  const fetchMock = async (url) => {
    if (url.indexOf('sjxz') >= 0) throw new Error('Failed to fetch');
    return { ok: false, status: 401, json: async () => ({ error: 'invalid' }) };
  };
  const sb = makeDetectSandbox(fetchMock);
  sb.__detectSite('imp_X').then(() => {
    check('B5 应抛错', false, '未抛');
    finishAsync();
  }).catch((e) => {
    check('文案含新站地址', /sjxz\.yundongchangzu\.com/.test(e.message), e.message);
    check('文案含网络错误原因', /Failed to fetch/.test(e.message), e.message);
    check('非 401', e.status !== 401);
    finishAsync();
  });
}

console.log('== B6：两站都认（极端）→ 取第一个并正常返回 ==');
{
  const fetchMock = async () => ({ ok: true, status: 200, json: async () => ({ teamId: 'both', scope: 'all' }) });
  const sb = makeDetectSandbox(fetchMock);
  sb.__detectSite('imp_BOTH').then((hit) => {
    check('命中首个站点(new)', hit.site.id === 'new', hit.site.id);
    check('团队信息来自命中站点', hit.me.teamId === 'both');
    finishAsync();
  }).catch((e) => { check('B6 不应抛错', false, e.message); finishAsync(); });
}

// 异步用例完成后统一结算
let asyncDone = 0;
const asyncTotal = 6; // B1..B6
function finishAsync() {
  asyncDone++;
  if (asyncDone === asyncTotal) {
    console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
    process.exit(fail ? 1 : 0);
  }
}
