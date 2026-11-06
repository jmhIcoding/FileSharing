'use strict';
/**
 * 普通目录初始化回归测试（不依赖 Electron）
 * 用法：node build/test-init.js
 *
 * 复现并守住这个 bug：refreshRules() 提前创建 .git/info/exclude，
 * 使「.git 目录存在」被误判为仓库，随后 git status 报
 * "fatal: not a git repository (or any of the parent directories): .git"。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const { RepoEngine } = require('../core/engine');
const { defaultProject } = require('../core/store');

const results = [];
let failed = 0;
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

const GIT = process.env.FILESHARING_TEST_GIT || 'git';
const GIT_ENV = process.env.FILESHARING_TEST_GIT_ENV ? JSON.parse(process.env.FILESHARING_TEST_GIT_ENV) : {};
const GIT_BASE = ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'core.longpaths=true'];
function sh(args, cwd) {
  return execFileSync(GIT, [...GIT_BASE, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, GIT_TERMINAL_PROMPT: '0' },
  });
}
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesharing-init-'));

function project(localDir, remoteUrl, extra = {}) {
  return {
    ...defaultProject(),
    name: 'init-test',
    localDir,
    remoteUrl,
    branch: 'main',
    auth: { mode: 'none', credentialId: '', username: '', token: '' },
    sync: { ...defaultProject().sync, trackedChangePolicy: 'confirm', newFilePolicy: 'auto', ...extra },
  };
}
function engineFor(p) {
  return new RepoEngine(p, { logger, gitPath: GIT, gitEnv: GIT_ENV, getGlobals: () => ({}) });
}
function write(rel, content) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

async function main() {
  console.log(`临时目录：${tmp}\n`);

  // 准备一个带初始提交的远端裸仓库
  const remote = path.join(tmp, 'remote.git');
  fs.mkdirSync(remote, { recursive: true });
  sh(['init', '--bare', '-b', 'main'], remote);
  const seed = path.join(tmp, 'seed');
  sh(['clone', remote, seed], tmp);
  sh(['config', 'user.email', 't@test.local'], seed);
  sh(['config', 'user.name', 'T'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), '# hello\n');
  sh(['add', '-A'], seed);
  sh(['commit', '-m', 'init'], seed);
  sh(['push', '-u', 'origin', 'main'], seed);

  // ================= 1. 普通目录不能被当成仓库 =================
  console.log('场景 1 · 普通目录的仓库判定');
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  write('plain/我的文档.docx', 'local only\n');
  const eng = engineFor(project(plain, remote));
  check('普通目录 isRepo() 为 false', () => assert.strictEqual(eng.isRepo(), false));

  await eng.refreshRules();
  check('refreshRules 不会凭空创建 .git', () =>
    assert.strictEqual(fs.existsSync(path.join(plain, '.git')), false));
  check('refreshRules 后 isRepo() 仍为 false', () => assert.strictEqual(eng.isRepo(), false));

  const st0 = await eng.readStatus();
  check('readStatus 给出友好提示而不是 fatal', () =>
    assert.strictEqual(st0.ok, false) && assert.ok(!/not a git repository/.test(st0.raw)));

  const snap0 = await eng.inspect({ silent: false });
  check('inspect 停在 uninitialized 相位', () => assert.strictEqual(snap0.phase, 'uninitialized'));
  check('inspect 不产生状态读取失败', () =>
    assert.ok(!/状态读取失败|not a git repository/.test(snap0.lastError || '')));

  // ================= 2. 完整保存流程（顺序同 project:save）=================
  console.log('\n场景 2 · 普通目录走完保存流程能成功接管');
  await eng.refreshRules();
  await eng.inspect({ silent: false });
  const snap1 = await eng.syncNow({ manual: true });
  check('同步没有报错', () =>
    assert.notStrictEqual(snap1.phase, 'error'), `phase=${snap1.phase} err=${snap1.lastError}`);
  check('没有出现 not a git repository', () =>
    assert.ok(!/not a git repository/.test(snap1.lastError || ''), snap1.lastError));
  check('目录已变成真正的 Git 仓库', () => assert.strictEqual(eng.isRepo(), true));
  check('.git/HEAD 存在', () => assert.strictEqual(fs.existsSync(path.join(plain, '.git', 'HEAD')), true));
  check('本地原有文件保留', () =>
    assert.strictEqual(fs.readFileSync(path.join(plain, '我的文档.docx'), 'utf8'), 'local only\n'));
  check('远端文件已拉入', () => assert.strictEqual(fs.existsSync(path.join(plain, 'README.md')), true));
  check('忽略规则在初始化后才写入', () =>
    assert.ok(fs.existsSync(path.join(plain, '.git', 'info', 'exclude'))));

  // ================= 3. 空目录 clone =================
  console.log('\n场景 3 · 空目录克隆');
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  const eng2 = engineFor(project(empty, remote));
  await eng2.refreshRules();
  check('空目录 refreshRules 后仍无 .git', () =>
    assert.strictEqual(fs.existsSync(path.join(empty, '.git')), false));
  const snap2 = await eng2.syncNow({ manual: true });
  check('空目录克隆成功', () =>
    assert.notStrictEqual(snap2.phase, 'error'), `phase=${snap2.phase} err=${snap2.lastError}`);
  check('克隆后是真正的仓库', () => assert.strictEqual(eng2.isRepo(), true));
  check('克隆后文件齐全', () => assert.strictEqual(fs.existsSync(path.join(empty, 'README.md')), true));

  // ================= 4. 已中招目录的自愈 =================
  console.log('\n场景 4 · 清理早期版本留下的 .git 空壳');
  const broken = path.join(tmp, 'broken');
  fs.mkdirSync(broken, { recursive: true });
  write('broken/报表.xlsx', 'local\n');
  fs.mkdirSync(path.join(broken, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(broken, '.git', 'info', 'exclude'), '~$*\n', 'utf8');
  const eng3 = engineFor(project(broken, remote));
  check('空壳目录被判定为「不是仓库」', () => assert.strictEqual(eng3.isRepo(), false));
  const snap3 = await eng3.syncNow({ manual: true });
  check('自愈后同步成功', () =>
    assert.notStrictEqual(snap3.phase, 'error'), `phase=${snap3.phase} err=${snap3.lastError}`);
  check('自愈后 .git/HEAD 存在', () =>
    assert.strictEqual(fs.existsSync(path.join(broken, '.git', 'HEAD')), true));
  check('原有本地文件保留', () =>
    assert.strictEqual(fs.readFileSync(path.join(broken, '报表.xlsx'), 'utf8'), 'local\n'));
  check('远端文件已拉入', () => assert.strictEqual(fs.existsSync(path.join(broken, 'README.md')), true));

  // ================= 5. 真正的仓库不受影响 =================
  console.log('\n场景 5 · 真正的 Git 仓库仍被正确识别');
  const real = path.join(tmp, 'real');
  sh(['clone', remote, real], tmp);
  const eng4 = engineFor(project(real, remote));
  check('clone 出来的目录 isRepo() 为 true', () => assert.strictEqual(eng4.isRepo(), true));
  await eng4.refreshRules();
  check('refreshRules 在真仓库里正常写规则', () =>
    assert.ok(fs.readFileSync(path.join(real, '.git', 'info', 'exclude'), 'utf8').includes('~$*')));

  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
