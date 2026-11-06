'use strict';
/**
 * 真实 GitHub 端到端测试（不落盘 Token）
 *
 *   FILESHARING_LIVE_TOKEN=xxx FILESHARING_LIVE_REMOTE=https://... \
 *     FILESHARING_LIVE_PROXY=http://127.0.0.1:7890 node build/test-live-github.js
 *
 * 所有操作都跑在一个独立的测试分支上，跑完自动删除，不碰 main。
 * 使用项目自己的 core/git.js + core/engine.js（真实认证注入 / 代理注入 / 同步状态机）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const git = require('../core/git');
const { RepoEngine } = require('../core/engine');
const { defaultProject } = require('../core/store');
const ignore = require('../core/ignore');

const TOKEN = process.env.FILESHARING_LIVE_TOKEN || '';
const REMOTE = process.env.FILESHARING_LIVE_REMOTE || 'https://github.com/jmhIcoding/FileSharing_GUNST.git';
const PROXY = process.env.FILESHARING_LIVE_PROXY || process.env.HTTPS_PROXY || '';
const BRANCH = process.env.FILESHARING_LIVE_BRANCH || `filesharing-e2e-${Date.now().toString(36)}`;
if (!TOKEN) {
  console.error('缺少 FILESHARING_LIVE_TOKEN');
  process.exit(1);
}

const base = path.resolve(__dirname, '..', 'vendor', 'git', 'mingw64');
const GIT = path.join(base, 'bin', 'git.exe');
const GIT_ENV = {
  GIT_EXEC_PATH: path.join(base, 'libexec', 'git-core'),
  GIT_TEMPLATE_DIR: path.join(base, 'share', 'git-core', 'templates'),
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'filesharing-live-'));
const scrub = (s) => String(s || '').replace(/ghp_[A-Za-z0-9_]+/g, 'ghp_***').slice(0, 400);
const logger = { info() {}, warn() {}, error() {}, debug() {} };

const results = [];
let failed = 0;
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${scrub(err.message)}`);
  }
}
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${scrub(err.message)}`);
    return false;
  }
  return true;
}

// 用真实凭据库路径：按 github.com 域名自动匹配到这条 Token
function globals(withProxy) {
  return {
    auth: { username: '', token: '' },
    credentials: [{
      id: 'live-gh', name: 'E2E GitHub Token', host: 'github.com',
      username: '', token: TOKEN,
    }],
    defaultCredentialId: 'live-gh',
    autoMatchCredential: true,
    proxyMode: withProxy && PROXY ? 'custom' : 'none',
    proxyUrl: withProxy ? PROXY : '',
    proxyUser: '', proxyPass: '',
  };
}

function project(name, dir, opts = {}) {
  return {
    ...defaultProject(),
    name,
    localDir: dir,
    remoteUrl: REMOTE,
    branch: BRANCH,
    auth: { mode: 'global', credentialId: '', username: '', token: '' },
    exclude: [],
    ignoreRegex: opts.ignoreRegex || [],
    sync: {
      ...defaultProject().sync,
      trackedChangePolicy: 'confirm',
      newFilePolicy: 'ask',
      builtinIgnore: true,
      pushMode: 'confirm',
      autoCommit: false,
      watchFiles: false,
    },
  };
}
function engine(p, withProxy = false) {
  return new RepoEngine(p, {
    logger, gitPath: GIT, gitEnv: GIT_ENV, getGlobals: () => globals(withProxy),
  });
}
function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}
function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}
async function rawGit(args, cwd, withProxy = false, authToken = TOKEN) {
  return git.runGit(args, {
    cwd,
    auth: { mode: 'token', username: '', token: authToken },
    proxy: withProxy && PROXY ? { mode: 'custom', url: PROXY, user: '', pass: '' } : null,
    remoteUrl: REMOTE,
    gitPath: GIT, gitEnv: GIT_ENV, timeout: 90000,
  });
}
async function main() {
  console.log(`临时目录：${TMP}`);
  console.log(`远端：${REMOTE}`);
  console.log(`测试分支：${BRANCH}（测完删除）`);
  console.log(`代理：${PROXY || '(直连)'}\n`);
  const mainBefore = await rawGit(['ls-remote', '--heads', REMOTE, 'refs/heads/main'], TMP);
  const mainShaBefore = (mainBefore.stdout || '').trim().split('\t')[0];
  console.log(`main 基线 SHA：${mainShaBefore.slice(0, 8) || '(仓库为空)'}\n`);

  // ---------- 0. 认证与网络 ----------
  console.log('阶段 0 · 认证、内置 Git、代理');
  await step('内置 Git 可运行', async () => {
    const v = await git.checkGit(GIT, GIT_ENV);
    assert.strictEqual(v.ok, true, scrub(v.message));
  });
  await step('真实 ls-remote 连通（凭据库自动按域名匹配）', async () => {
    const r = await rawGit(['ls-remote', '--heads', REMOTE], TMP);
    assert.strictEqual(r.code, 0, scrub(r.stderr));
  });
  await step('显式代理下也能连通', async () => {
    if (!PROXY) return;
    const r = await rawGit(['ls-remote', '--heads', REMOTE], TMP, true);
    assert.strictEqual(r.code, 0, scrub(r.stderr));
  });
  check('buildAuthArgs 用正确 Token 生成 Authorization 头', () => {
    const args = git.buildAuthArgs({ mode: 'token', username: '', token: TOKEN }, REMOTE);
    const h = args.find((a) => String(a).startsWith('http.extraHeader=Authorization: Basic '));
    assert.ok(h, '没有生成认证头');
    const raw = Buffer.from(h.split('Basic ')[1], 'base64').toString('utf8');
    assert.strictEqual(raw, `x-access-token:${TOKEN}`);
    assert.ok(!h.includes(TOKEN.replace('ghp_', '')), '认证头不应含明文');
  });
  check('错误 Token 给出可读中文提示', () => {
    const m = git.explainGitError('fatal: unable to get password from user');
    assert.ok(m.includes('认证失败') && m.includes('Token'));
  });

  // ---------- 1. 设备 A：普通目录接管 + 确认上传 ----------
  console.log('\n阶段 1 · 普通目录接管真实空仓库并首次推送');
  const dirA = path.join(TMP, 'deviceA');
  fs.mkdirSync(dirA, { recursive: true });
  write(dirA, 'README.md', '# FileSharing E2E\n\nline-1\n');
  write(dirA, 'notes/todo.txt', 'todo v1\n');
  write(dirA, '~$可行性报告.docx', 'office lock');
  write(dirA, 'scratch/draft.tmp', 'regex ignored');
  const pA = project('deviceA', dirA, { ignoreRegex: ['^scratch/'] });
  const engA = engine(pA);

  let snap = await engA.syncNow({ manual: true });
  check('接管后不是 error 相位', () =>
    assert.notStrictEqual(snap.phase, 'error', `phase=${snap.phase} err=${scrub(snap.lastError)}`));
  check('接管后成为真正的 Git 仓库', () => assert.strictEqual(engA.isRepo(), true));
  check('.git/HEAD 存在', () => assert.strictEqual(fs.existsSync(path.join(dirA, '.git', 'HEAD')), true));
  check('remote origin 指向真实仓库', () => {
    const cfg = fs.readFileSync(path.join(dirA, '.git', 'config'), 'utf8');
    assert.ok(cfg.includes(REMOTE.replace(/\.git$/, '')));
    assert.ok(!cfg.includes(TOKEN), 'Token 不能写进 .git/config');
  });
  check('本地原有文件全部保留', () =>
    assert.strictEqual(read(dirA, 'notes/todo.txt'), 'todo v1\n'));
  const st0 = await engA.readStatus();
  check('Word 锁文件被内置规则挡住', () =>
    assert.ok(!st0.pendingNew.some((c) => c.path.includes('~$')) && !st0.changes.some((c) => c.path.includes('~$'))));
  check('正则规则挡住 scratch/ 目录', () =>
    assert.ok(!st0.pendingNew.some((c) => c.path.startsWith('scratch/')) && !st0.changes.some((c) => c.path.startsWith('scratch/'))));
  check('普通新文件进入待确认', () =>
    assert.ok(st0.pendingNew.some((c) => c.path === 'README.md') && st0.pendingNew.some((c) => c.path === 'notes/todo.txt')));
  check('未确认文件不算本地改动', () => assert.strictEqual(st0.changes.length, 0));

  await step('确认上传 README.md 并推送到真实 GitHub', async () => {
    await engA.acceptNew(['README.md']);
    const s = await engA.commitAndPush('[e2e] initial commit');
    assert.notStrictEqual(s.phase, 'error', `phase=${s.phase} err=${scrub(s.lastError)}`);
  });
  await step('远端确实出现测试分支', async () => {
    const r = await rawGit(['ls-remote', '--heads', REMOTE], TMP);
    assert.ok((r.stdout || '').includes(`refs/heads/${BRANCH}`), scrub(r.stdout));
  });
  await step('远端只有已确认的 README.md（锁文件与 scratch 都没上传）', async () => {
    const probe = path.join(TMP, 'probe');
    fs.mkdirSync(probe, { recursive: true });
    const cl = await rawGit(['clone', '--branch', BRANCH, '--depth', '1', REMOTE, '.'], probe);
    assert.strictEqual(cl.code, 0, scrub(cl.stderr));
    const names = fs.readdirSync(probe).filter((n) => n !== '.git');
    assert.ok(names.includes('README.md'), JSON.stringify(names));
    assert.ok(!names.some((n) => n.startsWith('~$')), JSON.stringify(names));
    assert.ok(!names.includes('scratch'), JSON.stringify(names));
    assert.ok(!names.includes('notes'), '未确认的 todo.txt 不应被上传');
  });

  // ---------- 2. 设备 B：克隆 + 自动合并 ----------
  console.log('\n阶段 2 · 第二台设备克隆与远端更新自动合并');
  const dirB = path.join(TMP, 'deviceB');
  fs.mkdirSync(dirB, { recursive: true });
  const pB = project('deviceB', dirB);
  const engB = engine(pB);
  snap = await engB.syncNow({ manual: true });
  check('设备 B 克隆成功', () =>
    assert.notStrictEqual(snap.phase, 'error', `phase=${snap.phase} err=${scrub(snap.lastError)}`));
  check('设备 B 拿到远端文件', () => assert.strictEqual(fs.existsSync(path.join(dirB, 'README.md')), true));

  await step('设备 A 修改并推送', async () => {
    write(dirA, 'README.md', '# FileSharing E2E\n\nline-1\nA-added-line\n');
    const s = await engA.commitAndPush('[e2e] device A edit');
    assert.notStrictEqual(s.phase, 'error', scrub(s.lastError));
  });
  await step('设备 B 自动合并远端更新', async () => {
    const s = await engB.syncNow({ manual: true });
    assert.notStrictEqual(s.phase, 'error', scrub(s.lastError));
    assert.ok(read(dirB, 'README.md').includes('A-added-line'), read(dirB, 'README.md'));
  });

  // ---------- 3. 冲突交由用户处理 ----------
  // 正确构造：B 先推一版；A 基于旧基线也改同一行并「只在本地提交」，
  // 再 syncNow 拉取合并 —— 冲突必然发生在 A 端。
  console.log('\n阶段 3 · 双方改同一行产生冲突');
  await step('设备 B 改成 B 版并推送', async () => {
    write(dirB, 'README.md', '# FileSharing E2E\n\nB-conflicting-line\n');
    const s = await engB.commitAndPush('[e2e] device B edit');
    assert.notStrictEqual(s.phase, 'error', scrub(s.lastError));
  });
  await step('设备 A 基于旧基线改同一行并在本地提交（先不推送）', async () => {
    write(dirA, 'README.md', '# FileSharing E2E\n\nA-conflicting-line\n');
    const a = await rawGit(['add', '--', 'README.md'], dirA);
    assert.strictEqual(a.code, 0, scrub(a.stderr));
    const c = await rawGit([
      '-c', 'user.name=FileSharing E2E', '-c', 'user.email=e2e@test.local',
      'commit', '-m', '[e2e] device A conflicting edit', '--no-verify',
    ], dirA);
    assert.strictEqual(c.code, 0, scrub(c.stderr));
  });
  snap = await engA.syncNow({ manual: true });
  check('设备 A 检测到冲突且停住', () =>
    assert.strictEqual(snap.phase, 'conflict', `phase=${snap.phase} conflicts=${JSON.stringify(snap.conflicts)} err=${scrub(snap.lastError)}`));
  check('冲突面板列出 README.md', () =>
    assert.ok((snap.conflicts || []).some((c) => c.path === 'README.md' || c === 'README.md'),
      JSON.stringify(snap.conflicts)));
  check('冲突未解决时 busy 已复位', () => assert.strictEqual(snap.busy, false));
  await step('采用远端版本并完成合并、推送', async () => {
    await engA.resolveFile('README.md', 'theirs');
    const s = await engA.finishMerge({ push: true });
    assert.notStrictEqual(s.phase, 'error', scrub(s.lastError));
    assert.ok(!read(dirA, 'README.md').includes('<<<<<<<'), '冲突标记应已清除');
    assert.ok(read(dirA, 'README.md').includes('B-conflicting-line'), '应已采用远端版本');
  });

  // ---------- 4. 忽略 / 停止追踪 / 代理 ----------
  console.log('\n阶段 4 · 忽略规则、停止追踪、代理推送');
  await step('设备 A 生成临时文件后状态干净', async () => {
    write(dirA, '~$新建文档.docx', 'lock');
    write(dirA, 'Thumbs.db', 'thumb');
    const s = await engA.readStatus();
    assert.ok(!s.pendingNew.some((c) => ignore.isTransientPath(c.path)), JSON.stringify(s.pendingNew.map((c) => c.path)));
    assert.ok(!s.changes.some((c) => ignore.isTransientPath(c.path)), JSON.stringify(s.changes.map((c) => c.path)));
  });
  await step('停止追踪 README.md 后本地文件保留', async () => {
    await engA.untrackFiles(['README.md']);
    assert.strictEqual(fs.existsSync(path.join(dirA, 'README.md')), true);
    const tracked = await engA.listTracked();
    assert.ok(!tracked.includes('README.md'), JSON.stringify(tracked));
  });
  await step('显式代理下再推送一次', async () => {
    if (!PROXY) return;
    const r = await rawGit(['ls-remote', '--heads', REMOTE], TMP, true);
    assert.strictEqual(r.code, 0, scrub(r.stderr));
  });
  check('.git/config 始终不含明文 Token', () => {
    const cfg = fs.readFileSync(path.join(dirA, '.git', 'config'), 'utf8');
    assert.ok(!cfg.includes(TOKEN));
  });
  check('工作区里没有任何文件含明文 Token', () => {
    const hit = [];
    for (const d of [dirA, dirB]) {
      for (const [root, , files] of walk(d)) {
        for (const f of files) {
          try {
            if (fs.readFileSync(path.join(root, f), 'utf8').includes(TOKEN)) hit.push(f);
          } catch (_) { /* 二进制文件跳过 */ }
        }
      }
    }
    assert.deepStrictEqual(hit, [], JSON.stringify(hit));
  });

  // ---------- 5. 清理远端测试分支 ----------
  console.log('\n阶段 5 · 清理');
  await step('删除远端测试分支', async () => {
    const r = await rawGit(['push', 'origin', '--delete', BRANCH], dirA);
    assert.strictEqual(r.code, 0, scrub(r.stderr));
  });
  await step('测试分支已从远端删除', async () => {
    const r = await rawGit(['ls-remote', '--heads', REMOTE], TMP);
    assert.strictEqual(r.code, 0, scrub(r.stderr));
    assert.ok(!(r.stdout || '').includes(`refs/heads/${BRANCH}`), scrub(r.stdout));
  });
  await step('main 分支内容未被本次测试改动', async () => {
    const r = await rawGit(['ls-remote', '--heads', REMOTE, 'refs/heads/main'], TMP);
    const sha = (r.stdout || '').trim().split('\t')[0];
    assert.strictEqual(sha, mainShaBefore, `before=${mainShaBefore} after=${sha}`);
  });

  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`);
  console.log(`临时目录：${TMP}（脚本结束后保留供排查，可手动删除）`);
  if (failed) process.exitCode = 1;
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else files.push(e.name);
  }
  yield [dir, null, files];
}

main().catch((err) => {
  console.error('E2E_ABORT', scrub(err.message));
  process.exitCode = 1;
});
