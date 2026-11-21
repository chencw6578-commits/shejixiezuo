/**
 * 测试 Figma 插件 prefs 迁移逻辑（v1.8.1 双域名并存修复）。
 * ui.html 是 data: iframe 内联脚本，无法直接 import——这里抽取相关函数源码在 Node 沙箱执行。
 * 覆盖：被污染旧站配置还原、正常新站配置不误伤、双配置互不干扰、id 保留、retiredRestored 幂等、v4 迁移。
 */
const fs = require('fs');
const path = require('path');

const uiPath = path.join(__dirname, '..', 'figma-plugin', 'ui.html');
const html = fs.readFileSync(uiPath, 'utf8');

// 从 ui.html 抽取指定函数（按函数名匹配到其函数体的结束大括号——这里函数结构规整，用括号计数）
function extractFn(name) {
  const sig = 'function ' + name + '(';
  const start = html.indexOf(sig);
  if (start < 0) throw new Error('找不到函数 ' + name);
  let i = html.indexOf('{', start);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}

const fnNames = ['newProfileId', 'suggestProfileName', 'makeProfile', 'activeProfileById', 'restoreRetiredProfile', 'normalizeProfiles'];
const fnSrc = fnNames.map(extractFn).join('\n');

// 抽取两个常量定义
const defaultUrlMatch = html.match(/var DEFAULT_BASE_URL = '([^']+)'/);
const retiredReMatch = html.match(/var RETIRED_BASE_URL_RE = (\/[^\n]+\/i);/);
const oldSiteMatch = html.match(/var OLD_SITE_URL = '([^']+)'/);
if (!defaultUrlMatch || !retiredReMatch || !oldSiteMatch) throw new Error('抽取常量失败');

const preamble = `
var DEFAULT_BASE_URL = '${defaultUrlMatch[1]}';
var RETIRED_BASE_URL_RE = ${retiredReMatch[1]};
var OLD_SITE_URL = '${oldSiteMatch[1]}';
var state = { profiles: [], activeProfileId: '' };
function activeProfileById(id) {
  for (var i = 0; i < state.profiles.length; i++) if (state.profiles[i].id === id) return state.profiles[i];
  return null;
}
${fnSrc}
`;

// 在沙箱里执行，导出 normalizeProfiles
const vm = require('vm');
const sandbox = { console: { warn: () => {} }, Math, Date };
vm.createContext(sandbox);
vm.runInContext(preamble + '\nthis.__normalize = normalizeProfiles;', sandbox);
const normalize = sandbox.__normalize;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}

const NEW = 'https://sjxz.yundongchangzu.com';
const OLD = 'https://shilipix.cn';

console.log('== 用例 1：被污染的旧站配置（名字旧站+域名新站）应还原 ==');
{
  const prefs = { version: 5, profiles: [
    { id: 'p_old_1', name: '设计协作（旧站）', baseUrl: NEW, token: 'imp_WRONG_TOKEN', teamId: 't1', projectId: 'pr1', groupId: 'g1', newGroupName: '' },
  ], activeProfileId: 'p_old_1' };
  const r = normalize(prefs);
  const p = r[0];
  check('域名还原为旧站', p.baseUrl === OLD, p.baseUrl);
  check('错配令牌被清空', p.token === '', JSON.stringify(p.token));
  check('三级目标被清空', p.teamId === '' && p.projectId === '' && p.groupId === '');
  check('id 保留', p.id === 'p_old_1', p.id);
  check('打了 restored 标记', p.retiredRestored === true);
}

console.log('== 用例 2：正常新站配置不被误伤 ==');
{
  const prefs = { version: 5, profiles: [
    { id: 'p_new', name: '设计协作（新站）', baseUrl: NEW, token: 'imp_NEW_OK', teamId: 't9', projectId: '', groupId: '', newGroupName: '' },
  ], activeProfileId: 'p_new' };
  const r = normalize(prefs);
  const p = r[0];
  check('域名保持新站', p.baseUrl === NEW, p.baseUrl);
  check('令牌保留', p.token === 'imp_NEW_OK', p.token);
  check('团队保留', p.teamId === 't9');
  check('未打 restored 标记', !p.retiredRestored);
}

console.log('== 用例 3：双配置互不干扰（旧站被污染+新站正常）==');
{
  const prefs = { version: 5, profiles: [
    { id: 'p_old', name: '设计协作（旧站）', baseUrl: NEW, token: 'imp_OLD_WRONG', teamId: 'a', projectId: '', groupId: '', newGroupName: '' },
    { id: 'p_new', name: '设计协作（新站）', baseUrl: NEW, token: 'imp_NEW_OK', teamId: 'b', projectId: '', groupId: '', newGroupName: '' },
  ], activeProfileId: 'p_old' };
  const r = normalize(prefs);
  check('旧站还原为 OLD', r[0].baseUrl === OLD, r[0].baseUrl);
  check('旧站令牌清空', r[0].token === '');
  check('新站保持 NEW', r[1].baseUrl === NEW, r[1].baseUrl);
  check('新站令牌保留', r[1].token === 'imp_NEW_OK', r[1].token);
  check('两个 id 顺序与值都保留', r[0].id === 'p_old' && r[1].id === 'p_new');
}

console.log('== 用例 4：retiredRestored 幂等（还原过一次后不再改动用户后续编辑）==');
{
  const prefs = { version: 5, profiles: [
    { id: 'p1', name: '设计协作（旧站）', baseUrl: NEW, token: 'imp_USER_REENTERED', teamId: 'user', projectId: '', groupId: '', newGroupName: '', retiredRestored: true },
  ], activeProfileId: 'p1' };
  const r = normalize(prefs);
  const p = r[0];
  check('已还原配置不再被重置域名', p.baseUrl === NEW, p.baseUrl);
  check('用户重填的令牌保留', p.token === 'imp_USER_REENTERED', p.token);
  check('团队保留', p.teamId === 'user');
}

console.log('== 用例 5：v4 单配置迁移 ==');
{
  // 5a: v4 指向旧域名 → 应保持旧域名、命名旧站，不触发还原
  const prefs4old = { version: 4, baseUrl: 'https://www.shilipix.cn', token: 'imp_OLD_OK', teamId: 't', projectId: '', groupId: '', newGroupName: '' };
  const r1 = normalize(prefs4old);
  check('v4旧域名→命名旧站', r1[0].name === '设计协作（旧站）', r1[0].name);
  check('v4旧域名→保持旧域名不改', /shilipix\.cn/.test(r1[0].baseUrl), r1[0].baseUrl);
  check('v4旧域名→令牌保留', r1[0].token === 'imp_OLD_OK', r1[0].token);

  // 5b: v4 指向新域名 → 命名新站、不误还原
  const prefs4new = { version: 4, baseUrl: NEW, token: 'imp_NEW_OK', teamId: '', projectId: '', groupId: '', newGroupName: '' };
  const r2 = normalize(prefs4new);
  check('v4新域名→命名新站', r2[0].name === '设计协作（新站）', r2[0].name);
  check('v4新域名→保持新域名', r2[0].baseUrl === NEW, r2[0].baseUrl);
  check('v4新域名→令牌保留', r2[0].token === 'imp_NEW_OK');
}

console.log('== 用例 6：无 profiles 的空 prefs（新安装兜底）==');
{
  const r = normalize({});
  check('生成 1 个默认配置', r.length === 1);
  check('默认指向新站', r[0].baseUrl === NEW, r[0].baseUrl);
  // 注：v4 分支用原始 prefs.baseUrl(空) 命名，suggestProfileName 返回中性的「设计协作」（既有行为）
  check('默认名字为中性「设计协作」', r[0].name === '设计协作', r[0].name);
}

console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
