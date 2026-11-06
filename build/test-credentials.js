'use strict';
/**
 * 凭据自测（不依赖 Electron、不联网）
 * 用法：node build/test-credentials.js
 *
 * 覆盖：多 Token 凭据库的加密落盘与重启还原、增删改、留空不修改、
 *      按仓库域名自动匹配、四态认证、指定凭据、一键应用到全部目录、
 *      旧配置迁移、git 命令行 Authorization 注入。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { Store, defaultProject } = require('../core/store');
const { RepoEngine } = require('../core/engine');
const { buildAuthArgs } = require('../core/git');
const cred = require('../core/credentials');
const git = require('../core/git');

const GITHUB_TOKEN = 'ghp_GITHUB_TOKEN_9527';
const GITLAB_TOKEN = 'glpat_GITLAB_TOKEN_8866';
const PROJECT_TOKEN = 'ghp_PROJECT_ONLY_1234';
const LEGACY_TOKEN = 'ghp_LEGACY_TOKEN_4321';

const results = [];
let failed = 0;

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    results.push({ name, ok: false, err });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

// 可复现的加密适配器，用于模拟 Electron safeStorage（真实环境是 Windows DPAPI）
const adapter = {
  secure: true,
  encrypt: (s) => `enc:${Buffer.from(s, 'utf8').toString('base64')}`,
  decrypt: (s) => {
    if (!String(s).startsWith('enc:')) throw new Error('bad cipher');
    return Buffer.from(String(s).slice(4), 'base64').toString('utf8');
  },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesharing-cred-'));
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function open(cfg) {
  const s = new Store(cfg, adapter);
  s.load();
  return s;
}
const cfg = (name) => path.join(tmp, `${name}.json`);

function C(id, name, host, token, username = '') {
  return { id, name, host, username, token, createdAt: '2026-01-01T00:00:00.000Z' };
}
const GH = () => C('gh', 'GitHub 个人', 'github.com', GITHUB_TOKEN);
const GL = () => C('gl', '公司 GitLab', 'git.corp.com', GITLAB_TOKEN, 'build-bot');

function globals(o = {}) {
  return {
    auth: { username: '', token: '' },
    credentials: [],
    defaultCredentialId: '',
    autoMatchCredential: true,
    proxyMode: 'none',
    ...o,
  };
}
function project(o = {}) {
  return {
    ...defaultProject(),
    name: 'test',
    localDir: tmp,
    remoteUrl: 'https://github.com/acme/repo.git',
    branch: 'main',
    ...o,
  };
}
function engineFor(p, g) {
  return new RepoEngine(p, { logger, gitPath: 'git', gitEnv: {}, getGlobals: () => g });
}
/** 从 git -c 参数里把 Authorization Basic 解回 user:token */
function authHeader(auth, remote = 'https://github.com/acme/repo.git') {
  const args = buildAuthArgs(auth, remote);
  const prefix = 'http.extraHeader=Authorization: Basic ';
  const item = args.find((a) => String(a).startsWith(prefix));
  return item ? Buffer.from(item.slice(prefix.length), 'base64').toString('utf8') : '';
}

async function main() {
  console.log(`临时目录：${tmp}\n`);

  console.log('场景 0 · Git 错误的中文提示');
  check('错误 Token 提示要指出检查凭据', () => {
    const m = git.explainGitError('fatal: unable to get password from user');
    assert.ok(m.includes('认证失败') && m.includes('Token'), m);
  });
  check('401 / 403 也归到认证失败', () => {
    assert.ok(git.explainGitError('remote: 403 Forbidden').includes('认证失败'));
    assert.ok(git.explainGitError('fatal: Authentication failed for ...').includes('Token'));
  });
  check('仓库不存在给出可读提示', () =>
    assert.ok(git.explainGitError('remote: Repository not found.').includes('仓库不存在')));
  check('网络错误提示检查代理', () =>
    assert.ok(git.explainGitError('fatal: Could not resolve host: github.com').includes('代理')));
  check('非快进提示先同步', () =>
    assert.ok(git.explainGitError('error: failed to push some refs (non-fast-forward)').includes('推送被拒绝')));

  // ================= 场景 1：多条 Token 加密落盘 =================
  console.log('场景 1 · 凭据库保存多个 Token');
  const c1 = cfg('multi');
  const s1 = open(c1);
  s1.updateGlobals(cred.applyGlobalsPatch(s1.globals, {
    credentials: [GH(), GL()],
    defaultCredentialId: 'gh',
    autoMatchCredential: true,
  }));
  const raw1 = fs.readFileSync(c1, 'utf8');
  check('配置文件不含任何明文 Token', () =>
    assert.ok(!raw1.includes(GITHUB_TOKEN) && !raw1.includes(GITLAB_TOKEN)));
  check('两条 Token 都以 tokenEnc 加密', () =>
    assert.strictEqual((raw1.match(/"tokenEnc"/g) || []).length, 2));
  check('代理密码也加密存储', () => {
    s1.updateGlobals({ proxyPass: 'proxy-secret' });
    const raw = fs.readFileSync(c1, 'utf8');
    assert.ok(!raw.includes('proxy-secret') && raw.includes('"proxyPassEnc"'));
  });

  const s2 = open(c1);
  check('重启后两条凭据都在', () => assert.strictEqual(s2.globals.credentials.length, 2));
  check('重启后 GitHub Token 可解密', () =>
    assert.strictEqual(s2.globals.credentials.find((c) => c.id === 'gh').token, GITHUB_TOKEN));
  check('重启后 GitLab Token 与用户名可解密', () => {
    const c = s2.globals.credentials.find((x) => x.id === 'gl');
    assert.strictEqual(c.token, GITLAB_TOKEN);
    assert.strictEqual(c.username, 'build-bot');
  });
  check('默认凭据指针保留', () => assert.strictEqual(s2.globals.defaultCredentialId, 'gh'));
  check('代理密码重启后可解密', () => assert.strictEqual(s2.globals.proxyPass, 'proxy-secret'));

  // ================= 场景 2：编辑留空沿用 / 删除条目 =================
  console.log('\n场景 2 · 编辑、删除与默认指针');
  const s3 = open(c1);
  s3.updateGlobals(cred.applyGlobalsPatch(s3.globals, {
    credentials: [{ id: 'gh', name: 'GitHub 工作号', host: 'github.com', username: '', token: '' }, GL()],
    defaultCredentialId: 'gh',
  }));
  const s4 = open(c1);
  check('编辑时密码框留空不会丢 Token', () =>
    assert.strictEqual(s4.globals.credentials.find((c) => c.id === 'gh').token, GITHUB_TOKEN));
  check('名称修改已生效', () =>
    assert.strictEqual(s4.globals.credentials.find((c) => c.id === 'gh').name, 'GitHub 工作号'));
  check('凭据库接管后旧的单 Token 字段被清空', () => assert.strictEqual(s4.globals.auth.token, ''));

  s4.updateGlobals(cred.applyGlobalsPatch(s4.globals, {
    credentials: [GL()],
    defaultCredentialId: 'gh', // 指向已删除的条目
  }));
  const s5 = open(c1);
  check('删除后只剩一条凭据', () => assert.strictEqual(s5.globals.credentials.length, 1));
  check('默认指针指向已删除条目时自动清空', () =>
    assert.strictEqual(s5.globals.defaultCredentialId, ''));
  check('删光凭据后不带任何认证', () =>
    assert.strictEqual(cred.effectiveAuth(project(), s5.globals).mode, 'none'));

  // ================= 场景 3：按仓库域名自动匹配 =================
  console.log('\n场景 3 · 多个 Token 按域名自动匹配');
  const gMulti = globals({ credentials: [GH(), GL()], defaultCredentialId: 'gh' });
  const pick = (url, g = gMulti) => cred.pickCredential(project({ remoteUrl: url }), g);
  check('github.com 命中 GitHub Token', () =>
    assert.strictEqual(pick('https://github.com/acme/repo.git').token, GITHUB_TOKEN));
  check('git.corp.com 命中公司 GitLab Token', () =>
    assert.strictEqual(pick('https://git.corp.com/team/repo.git').token, GITLAB_TOKEN));
  check('公司域名的下级子域也能命中', () =>
    assert.strictEqual(pick('https://code.git.corp.com/team/repo.git').token, GITLAB_TOKEN));
  check('同级域名不会误命中（回落到默认凭据）', () =>
    assert.strictEqual(pick('https://git.sub.corp.com/team/repo.git').token, GITHUB_TOKEN));
  check('匹配不到时回落到默认凭据', () =>
    assert.strictEqual(pick('https://gitee.com/someone/repo.git').token, GITHUB_TOKEN));
  check('关闭自动匹配后始终用默认凭据', () =>
    assert.strictEqual(pick('https://git.corp.com/team/repo.git',
      globals({ ...gMulti, autoMatchCredential: false })).token, GITHUB_TOKEN));
  check('没有默认凭据且匹配不到时返回空', () =>
    assert.strictEqual(pick('https://gitee.com/x/y.git',
      globals({ credentials: [GH(), GL()] })), null));
  check('SSH 形式 git@host:path 也能识别域名', () =>
    assert.strictEqual(cred.hostOf('git@github.com:acme/repo.git'), 'github.com'));
  check('相似域名不会被误匹配', () =>
    assert.strictEqual(cred.hostMatches('github.com', 'evilgithub.com'), false));

  // ================= 场景 4：四态实际生效凭据 =================
  console.log('\n场景 4 · 四种认证方式');
  check('global 走域名自动匹配', () =>
    assert.strictEqual(cred.effectiveAuth(project({ remoteUrl: 'https://git.corp.com/a/b.git' }), gMulti).token, GITLAB_TOKEN));
  check('credential 模式固定使用指定凭据', () =>
    assert.strictEqual(cred.effectiveAuth(project({ auth: { mode: 'credential', credentialId: 'gl' } }), gMulti).token, GITLAB_TOKEN));
  check('credential 模式带出该凭据的用户名', () =>
    assert.strictEqual(cred.effectiveAuth(project({ auth: { mode: 'credential', credentialId: 'gl' } }), gMulti).username, 'build-bot'));
  check('custom 模式覆盖凭据库', () =>
    assert.strictEqual(cred.effectiveAuth(project({ auth: { mode: 'custom', token: PROJECT_TOKEN } }), gMulti).token, PROJECT_TOKEN));
  check('none 模式即使有凭据也不认证', () =>
    assert.strictEqual(cred.effectiveAuth(project({ auth: { mode: 'none' } }), gMulti).mode, 'none'));
  check('指定的凭据被删后不会偷偷换用别的账号', () =>
    assert.strictEqual(cred.effectiveAuth(project({ auth: { mode: 'credential', credentialId: 'gone' } }), gMulti).mode, 'none'));
  check('旧配置 mode:token 等价 custom', () =>
    assert.strictEqual(cred.effectiveAuth(project({ auth: { mode: 'token', token: PROJECT_TOKEN } }), gMulti).token, PROJECT_TOKEN));
  check('凭据库为空时兼容旧 globals.auth', () =>
    assert.strictEqual(cred.effectiveAuth(project(), globals({ auth: { username: 'u', token: LEGACY_TOKEN } })).token, LEGACY_TOKEN));
  check('界面标签不含明文 Token', () =>
    assert.ok(!cred.credentialLabel(project({ remoteUrl: 'https://git.corp.com/a/b.git' }), gMulti).includes(GITLAB_TOKEN)));

  // ================= 场景 5：引擎与 git 命令行 =================
  console.log('\n场景 5 · 引擎与 git 命令行注入');
  const engGlobal = engineFor(project({ remoteUrl: 'https://github.com/acme/repo.git' }), gMulti);
  const engCorp = engineFor(project({ remoteUrl: 'https://git.corp.com/team/repo.git' }), gMulti);
  const engPicked = engineFor(project({ auth: { mode: 'credential', credentialId: 'gl' } }), gMulti);
  const engNone = engineFor(project({ auth: { mode: 'none' } }), gMulti);
  check('引擎对 github.com 用 GitHub Token', () =>
    assert.strictEqual(engGlobal._effectiveAuth().token, GITHUB_TOKEN));
  check('引擎对公司仓库用 GitLab Token', () =>
    assert.strictEqual(engCorp._effectiveAuth().token, GITLAB_TOKEN));
  check('引擎对指定凭据用指定 Token', () =>
    assert.strictEqual(engPicked._effectiveAuth().token, GITLAB_TOKEN));
  check('引擎 none 不带认证', () => assert.strictEqual(engNone._effectiveAuth().mode, 'none'));
  check('GitHub Token 写进 Authorization 头', () =>
    assert.strictEqual(authHeader(engGlobal._effectiveAuth()), `x-access-token:${GITHUB_TOKEN}`));
  check('公司 Token 连用户名一起写进 Authorization 头', () =>
    assert.strictEqual(authHeader(engCorp._effectiveAuth()), `build-bot:${GITLAB_TOKEN}`));
  check('none 模式不生成 Authorization 头', () =>
    assert.strictEqual(buildAuthArgs(engNone._effectiveAuth(), 'https://x/y.git').length, 0));

  // ================= 场景 6：测试连接按当前认证方式 =================
  console.log('\n场景 6 · 测试连接');
  const testAuth = (auth, remote = 'https://github.com/a/b.git', prev = null) =>
    cred.resolveTestAuth(auth, prev, gMulti);
  check('global 按域名取 Token', () =>
    assert.strictEqual(testAuth({ mode: 'global', remoteUrl: 'https://git.corp.com/a/b.git' }).token, GITLAB_TOKEN));
  check('credential 取指定 Token', () =>
    assert.strictEqual(testAuth({ mode: 'credential', credentialId: 'gl' }).token, GITLAB_TOKEN));
  check('指定凭据不存在时明确报错', () =>
    assert.throws(() => testAuth({ mode: 'credential', credentialId: 'gone' }), /不存在/));
  check('custom 用输入框的 Token', () =>
    assert.strictEqual(testAuth({ mode: 'custom', token: PROJECT_TOKEN }).token, PROJECT_TOKEN));
  check('custom 没填 Token 时报错', () =>
    assert.throws(() => testAuth({ mode: 'custom', token: '' }), /请填写/));
  check('none 不带认证', () => assert.strictEqual(testAuth({ mode: 'none' }).mode, 'none'));

  // ================= 场景 7：项目保存校验 =================
  console.log('\n场景 7 · 项目保存的认证校验');
  check('credential 模式必须选一条凭据', () =>
    assert.throws(() => cred.normalizeProjectAuth({ mode: 'credential', credentialId: '' }, null), /请选择/));
  check('credential 模式保存 credentialId', () =>
    assert.strictEqual(cred.normalizeProjectAuth({ mode: 'credential', credentialId: 'gl' }, null).credentialId, 'gl'));
  check('custom 模式不填 Token 被拦下', () =>
    assert.throws(() => cred.normalizeProjectAuth({ mode: 'custom' }, null), /需要填写 Token/));
  check('清除 Token 后仍停在 custom 被拦下', () =>
    assert.throws(() => cred.normalizeProjectAuth({ mode: 'custom', clearToken: true }, { token: PROJECT_TOKEN }), /改成/));
  check('编辑时留空沿用已保存 Token', () =>
    assert.strictEqual(cred.normalizeProjectAuth({ mode: 'custom' }, { token: PROJECT_TOKEN }).token, PROJECT_TOKEN));

  // ================= 场景 8：一键应用到全部目录 =================
  console.log('\n场景 8 · 一键应用到全部目录');
  const projects = [
    project({ id: 'p1', auth: { mode: 'global' } }),
    project({ id: 'p2', auth: { mode: 'none' } }),
    project({ id: 'p3', auth: { mode: 'credential', credentialId: 'gh' } }),
  ];
  const n = cred.applyCredentialToProjects(projects, gMulti.credentials, 'gl');
  check('一键应用覆盖全部 3 个目录', () => assert.strictEqual(n, 3));
  check('每个目录都指向指定凭据', () =>
    assert.ok(projects.every((p) => p.auth.mode === 'credential' && p.auth.credentialId === 'gl')));
  check('不存在的凭据无法应用', () =>
    assert.throws(() => cred.applyCredentialToProjects(projects, gMulti.credentials, 'gone'), /不存在/));
  const s8 = open(cfg('apply'));
  s8.updateGlobals(cred.applyGlobalsPatch(s8.globals, { credentials: [GH(), GL()], defaultCredentialId: 'gl' }));
  for (const p of projects) s8.upsertProject(p);
  const s8b = open(cfg('apply'));
  check('一键应用后重启仍保持指定凭据', () =>
    assert.ok(s8b.listProjects().every((p) => p.auth.mode === 'credential' && p.auth.credentialId === 'gl')));
  check('重启后每个目录实际用的都是公司 Token', () =>
    assert.ok(s8b.listProjects().every((p) => cred.effectiveAuth(p, s8b.globals).token === GITLAB_TOKEN)));

  // ================= 场景 9：旧配置迁移 =================
  console.log('\n场景 9 · 旧版单 Token 配置升级');
  const legacyCfg = cfg('legacy');
  fs.writeFileSync(legacyCfg, JSON.stringify({
    version: 1,
    globals: {
      proxyMode: 'none',
      auth: { username: 'old-user', tokenEnc: adapter.encrypt(LEGACY_TOKEN) },
      proxyPassEnc: adapter.encrypt('old-proxy'),
    },
    projects: [{
      id: 'legacy-id', name: 'legacy', localDir: tmp,
      remoteUrl: 'https://github.com/acme/repo.git', branch: 'main',
      auth: { mode: 'token', username: 'old-user', tokenEnc: adapter.encrypt(PROJECT_TOKEN) },
      proxy: { mode: 'inherit' },
      sync: { intervalSec: 60, pushMode: 'confirm', autoCommit: false, watchFiles: true },
    }],
  }, null, 2), 'utf8');
  const legacy = open(legacyCfg);
  check('旧全局 Token 自动升级成凭据库第一条', () =>
    assert.strictEqual(legacy.globals.credentials.length, 1));
  check('升级后 Token 内容不变', () =>
    assert.strictEqual(legacy.globals.credentials[0].token, LEGACY_TOKEN));
  check('升级后自动设为默认凭据', () =>
    assert.strictEqual(legacy.globals.defaultCredentialId, legacy.globals.credentials[0].id));
  check('旧项目 tokenEnc 可解密', () =>
    assert.strictEqual(legacy.getProject('legacy-id').auth.token, PROJECT_TOKEN));
  check('旧项目 mode:token 归一化为 custom', () =>
    assert.strictEqual(legacy.getProject('legacy-id').auth.mode, 'custom'));
  check('旧项目专属 Token 仍优先于全局', () =>
    assert.strictEqual(cred.effectiveAuth(legacy.getProject('legacy-id'), legacy.globals).token, PROJECT_TOKEN));
  check('旧全局代理密码可解密', () => assert.strictEqual(legacy.globals.proxyPass, 'old-proxy'));

  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
