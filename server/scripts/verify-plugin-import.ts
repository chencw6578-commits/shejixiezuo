/** 端到端验证：登录 → 创建导入令牌 → 插件导入 sample → 查库断言切图标记入库 */
const BASE = 'http://127.0.0.1:4000';
const EMAIL = 'qa-e2e-8801@demo.com';
const PASSWORD = 'password123';

const sample = JSON.parse(
  (await import('node:fs')).readFileSync('/workspace/figma-plugin/sample-export.json', 'utf8')
);

const jar: string[] = [];
const saveCookie = (res: Response) => {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) jar.push(c.split(';')[0]);
};
const cookie = () => jar.join('; ');

// 1. 注册（已存在则忽略）+ 登录
let res = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: '切图验证' }),
});
if (res.ok) console.log('1. 注册 OK');
res = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
saveCookie(res);
if (!res.ok) throw new Error('登录失败: ' + res.status);
console.log('1. 登录 OK');

// 2. 团队与项目
res = await fetch(`${BASE}/api/teams`, { headers: { Cookie: cookie() } });
const teams = (await res.json()) as { id: string; name: string }[];
const teamId = teams[0]?.id;
res = await fetch(`${BASE}/api/projects?teamId=${teamId}`, { headers: { Cookie: cookie() } });
const projects = (await res.json()) as { id: string; name: string }[];
const projectId = projects[0]?.id;
console.log('2. 团队/项目:', teams[0]?.name, '/', projects[0]?.name);

// 3. 创建导入令牌
res = await fetch(`${BASE}/api/teams/${teamId}/import-tokens`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie() },
  body: JSON.stringify({ name: '切图验证' }),
});
const tokenData = (await res.json()) as { token: string };
console.log('3. 导入令牌 OK');

// 4. 插件导入（boards = sample 的 artboards）
res = await fetch(`${BASE}/api/plugin/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenData.token}` },
  body: JSON.stringify({
    platform: 'ios',
    scale: 2,
    projectId,
    pluginVersion: '1.3.5',
    exportedAt: new Date().toISOString(),
    file: sample.file,
    boards: sample.artboards,
  }),
});
const imported = (await res.json()) as Record<string, unknown>;
console.log('4. 插件导入:', res.status, JSON.stringify(imported).slice(0, 300));

// 5. 查导入结果：虚拟图层与预设
const fileId = imported.fileId as string;
res = await fetch(`${BASE}/api/files/${fileId}`, { headers: { Cookie: cookie() } });
const detail0 = (await res.json()) as { frames?: { id: string; name: string }[] };
const frames = detail0.frames ?? [];
console.log('5. 画板数:', frames.length);

for (const f of frames.slice(0, 3)) {
  res = await fetch(`${BASE}/api/files/${fileId}/frames/${f.id}`, { headers: { Cookie: cookie() } });
  const detail = (await res.json()) as {
    nodes: { node_id: string; name: string; type: string; props?: { exportPresets?: unknown[] } }[];
  };
  const marked = detail.nodes.filter((n) => n.props?.exportPresets?.length);
  for (const n of marked) {
    console.log(`   ✓ [${n.type}] ${n.name} -> ${JSON.stringify(n.props?.exportPresets)}`);
  }
  console.log(`   画板「${f.name}」节点 ${detail.nodes.length} 个，带预设 ${marked.length} 个`);
}
console.log('DONE');
