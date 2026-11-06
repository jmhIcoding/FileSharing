'use strict';
/**
 * 核心同步引擎自测（不依赖 Electron）
 * 用法：node build/selftest.js
 *
 * 覆盖：首次克隆 / 本地改动检测 / 推送 / 远端更新自动合并 /
 *      冲突检测 / 单文件解决 / 完成合并 / 放弃合并 / 普通目录接管
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { RepoEngine } = require('../core/engine');
const { defaultProject } = require('../core/store');

const GIT = process.env.FILESHARING_TEST_GIT || 'git';
const GIT_ENV = process.env.FILESHARING_TEST_GIT_ENV ? JSON.parse(process.env.FILESHARING_TEST_GIT_ENV) : {};
const results = [];
let failed = 0;

// 与引擎保持一致的行尾策略，避免测试里混用两套 git 配置产生假冲突
const GIT_BASE = ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'core.longpaths=true'];
function sh(args, cwd) {
  return execFileSync(GIT, [...GIT_BASE, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  if (!cond) failed += 1;
  const mark = cond ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${extra && !cond ? ` — ${extra}` : ''}`);
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const globals = { proxyMode: 'none' };

function makeEngine(project) {
  return new RepoEngine(project, { logger, gitPath: GIT, gitEnv: GIT_ENV, getGlobals: () => globals });
}

function write(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function read(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesharing-test-'));
  console.log(`临时目录：${tmp}\n`);

  // ---- 准备远端（裸仓库）----
  const remote = path.join(tmp, 'remote.git');
  fs.mkdirSync(remote, { recursive: true });
  sh(['init', '--bare', '-b', 'main'], remote);

  // ---- 设备 A：先建立初始内容 ----
  const devA = path.join(tmp, 'devA');
  sh(['clone', remote, devA], tmp);
  sh(['config', 'user.email', 'a@test.local'], devA);
  sh(['config', 'user.name', 'A'], devA);
  write(devA, 'README.md', '# hello\n');
  write(devA, 'src/app.txt', 'line1\nline2\nline3\n');
  sh(['add', '-A'], devA);
  sh(['commit', '-m', 'init'], devA);
  sh(['push', '-u', 'origin', 'main'], devA);
  console.log('已准备远端初始提交\n');

  // ================= 场景 1：空目录自动克隆 =================
  console.log('场景 1 · 空目录首次同步');
  const dirB = path.join(tmp, 'devB');
  fs.mkdirSync(dirB, { recursive: true });
  const projB = {
    ...defaultProject(),
    name: 'devB',
    localDir: dirB,
    remoteUrl: remote,
    branch: 'main',
    auth: { mode: 'none', username: '', token: '' },
    sync: { ...defaultProject().sync, trackedChangePolicy: 'confirm', intervalSec: 60, pushMode: 'confirm', newFilePolicy: 'auto' },
  };
  const engB = makeEngine(projB);

  let snap = await engB.syncNow({ manual: true });
  check('克隆成功并进入已同步状态', snap.phase === 'synced', `phase=${snap.phase} err=${snap.lastError}`);
  check('文件已拉取到本地', fs.existsSync(path.join(dirB, 'README.md')) && read(dirB, 'README.md') === '# hello\n');
  check('本地是干净的', snap.changes.length === 0, `changes=${JSON.stringify(snap.changes)}`);

  // 仅为测试脚本自身的直接 git 操作补充身份；engine 内部有兜底身份，不依赖这个
  sh(['config', 'user.email', 'b@test.local'], dirB);
  sh(['config', 'user.name', 'B'], dirB);

  // ================= 场景 2：本地改动检测 =================
  console.log('\n场景 2 · 本地改动检测与推送确认');
  write(dirB, 'src/app.txt', 'line1\nline2-changed\nline3\n');
  snap = await engB.inspect({ silent: true });
  check('检测到本地修改', snap.changes.length === 1 && snap.changes[0].path.includes('app.txt'), JSON.stringify(snap.changes));
  check('状态为有本地改动', snap.phase === 'dirty', `phase=${snap.phase}`);

  snap = await engB.commitAndPush(null);
  check('提交并推送成功', snap.phase === 'synced', `phase=${snap.phase} err=${snap.lastError}`);
  const remoteLog = sh(['log', '--oneline', '-1', 'main'], remote);
  const remoteFiles = sh(['ls-tree', '-r', '--name-only', 'main'], remote);
  check('远端已收到提交', remoteFiles.includes('src/app.txt'), remoteFiles);

  // ================= 场景 3：远端更新自动合并 =================
  console.log('\n场景 3 · 远端更新后自动合并（无冲突）');
  write(devA, 'docs/guide.md', 'guide v1\n');
  sh(['add', '-A'], devA);
  sh(['commit', '-m', 'add guide'], devA);
  sh(['pull', '--no-rebase', '--no-edit'], devA);
  sh(['push'], devA);

  snap = await engB.syncNow({ manual: true });
  check('自动合并远端提交', snap.phase === 'synced', `phase=${snap.phase} err=${snap.lastError}`);
  check('新文件已合并到本地', fs.existsSync(path.join(dirB, 'docs/guide.md')));
  check('本地修改仍然保留', read(dirB, 'src/app.txt').includes('line2-changed'));

  // ================= 场景 4：推送前自动合并远端 =================
  console.log('\n场景 4 · 推送前自动合并远端新提交');
  sh(['pull', '--no-rebase', '--no-edit'], devA);
  write(devA, 'docs/other.md', 'other v1\n');
  sh(['add', '-A'], devA);
  sh(['commit', '-m', 'A add other'], devA);
  sh(['push'], devA);

  write(dirB, 'src/app.txt', 'line1\nB-version\nline3\n');
  snap = await engB.commitAndPush(null);
  check('推送前自动合并远端', snap.phase === 'synced', `phase=${snap.phase} err=${snap.lastError}`);
  check('远端新文件已合并到本地', fs.existsSync(path.join(dirB, 'docs/other.md')));
  check('本地改动保留', read(dirB, 'src/app.txt').includes('B-version'));

  // ================= 场景 5：冲突检测 =================
  console.log('\n场景 5 · 双方改同一行 → 冲突交由用户处理');
  sh(['pull', '--no-rebase', '--no-edit'], devA);
  write(devA, 'src/app.txt', 'line1\nA-conflict\nline3\n');
  sh(['add', '-A'], devA);
  sh(['commit', '-m', 'A conflict'], devA);
  sh(['push'], devA);

  write(dirB, 'src/app.txt', 'line1\nB-conflict\nline3\n');
  snap = await engB.commitAndPush(null);
  check('检测到合并冲突', snap.phase === 'conflict', `phase=${snap.phase} err=${snap.lastError}`);
  check('冲突文件列表正确', snap.conflicts.includes('src/app.txt'), JSON.stringify(snap.conflicts));

  snap = await engB.syncNow({ manual: true });
  check('冲突未解决时同步保持暂停', snap.phase === 'conflict', `phase=${snap.phase}`);

  // ================= 场景 6：解决冲突 =================
  console.log('\n场景 6 · 采用远端版本并完成合并');
  await engB.resolveFile('src/app.txt', 'theirs');
  check('冲突已清空', (await engB.readConflicts()).length === 0);
  check('文件内容为远端版本', read(dirB, 'src/app.txt').includes('A-conflict'), read(dirB, 'src/app.txt'));

  snap = await engB.finishMerge({ push: true });
  check('合并完成并推送', snap.phase === 'synced', `phase=${snap.phase} err=${snap.lastError}`);
  const finalRemote = sh(['log', '--oneline', '-1', 'main'], remote);
  check('远端历史包含合并提交', /Merge|merge/.test(finalRemote), finalRemote);

  // ================= 场景 7：放弃合并 =================
  console.log('\n场景 7 · 冲突后放弃合并');
  write(devA, 'src/app.txt', 'line1\nA-abort\nline3\n');
  sh(['add', '-A'], devA); sh(['commit', '-m', 'A abort'], devA);
  sh(['pull', '--no-rebase', '--no-edit'], devA); sh(['push'], devA);
  write(dirB, 'src/app.txt', 'line1\nB-abort\nline3\n');
  sh(['add', '-A'], dirB); sh(['commit', '-m', 'B abort'], dirB);
  const r6 = await engB.syncNow({ manual: true });
  check('产生冲突', r6.phase === 'conflict', `phase=${r6.phase}`);

  snap = await engB.abortMerge();
  check('放弃合并后回到干净状态', snap.phase !== 'conflict' && snap.conflicts.length === 0, `phase=${snap.phase}`);
  check('本地内容已还原', read(dirB, 'src/app.txt').includes('B-abort'));

  // ================= 场景 8：接管非空普通目录 =================
  console.log('\n场景 8 · 接管已有文件的普通目录');
  const dirC = path.join(tmp, 'devC');
  fs.mkdirSync(dirC, { recursive: true });
  write(dirC, 'README.md', '# hello from C\n');
  write(dirC, 'local-only.txt', 'c only\n');
  const projC = {
    ...defaultProject(),
    name: 'devC',
    localDir: dirC,
    remoteUrl: remote,
    branch: 'main',
    auth: { mode: 'none', username: '', token: '' },
    sync: { ...defaultProject().sync, trackedChangePolicy: 'confirm', pushMode: 'confirm', newFilePolicy: 'auto' },
  };
  const engC = makeEngine(projC);
  snap = await engC.syncNow({ manual: true });
  check('非空目录成功初始化', snap.phase !== 'error', `phase=${snap.phase} err=${snap.lastError}`);
  check('目录内原有文件保留', fs.existsSync(path.join(dirC, 'local-only.txt')));
  check('原有文件内容未被覆盖', read(dirC, 'README.md') === '# hello from C\n', read(dirC, 'README.md'));
  check('远端文件已拉入', fs.existsSync(path.join(dirC, 'src/app.txt')));
  check('差异被识别为本地改动', snap.changes.length > 0, JSON.stringify(snap.changes.map((c) => c.path)));

  // ================= 场景 9：忽略规则 =================
  console.log('\n场景 9 · 忽略规则生效');
  projC.exclude = ['*.tmp', 'build/'];
  await engC._applyExcludeRules();
  write(dirC, 'temp.tmp', 'x');
  write(dirC, 'build/out.js', 'y');
  // 模拟 Word / WPS 打开文档时生成的锁文件与备份
  write(dirC, '~$周报.docx', 'lock');
  write(dirC, 'docs/~$报价单.xlsx', 'lock');
  write(dirC, '~WRL0001.tmp', 'autosave');
  write(dirC, '.~lock.方案.docx#', 'lock');
  write(dirC, 'Thumbs.db', 'thumb');
  await engC.syncNow({ manual: true });
  const st = await engC.readStatus();
  check('忽略规则未出现在改动中', !st.changes.some((c) => c.path.endsWith('.tmp')), JSON.stringify(st.changes.map((c) => c.path)));
  check('Office / WPS 锁文件不会被扫描上传', !st.changes.some((c) => /~\$|\.~lock|Thumbs\.db/.test(c.path)), JSON.stringify(st.changes.map((c) => c.path)));
  check('干净仓库没有已跟踪的历史遗留临时文件', (await engC.readTrackedTransient()).length === 0);

  // ================= 场景 10：本地新增文件需要确认 =================
  console.log('\n场景 10 · 新文件默认不上传，确认后才推到远端');
  const dirD = path.join(tmp, 'devD');
  sh(['clone', remote, dirD], tmp);
  const projD = {
    ...defaultProject(),
    name: 'devD',
    localDir: dirD,
    remoteUrl: remote,
    branch: 'main',
    auth: { mode: 'none', username: '', token: '' },
    sync: { ...defaultProject().sync, trackedChangePolicy: 'confirm', pushMode: 'confirm', newFilePolicy: 'ask' },
  };
  const engD = makeEngine(projD);
  write(dirD, 'new-note.md', '需要我确认\n');
  snap = await engD.syncNow({ manual: true });
  check('未确认的新文件挂在待确认列表', (snap.pendingNew || []).some((c) => c.path === 'new-note.md'), JSON.stringify(snap.pendingNew));
  check('未确认的新文件不算本地改动', !(snap.changes || []).some((c) => c.path === 'new-note.md'));
  check('自动同步没有把它推到远端', !sh(['ls-tree', '-r', '--name-only', 'main'], remote).includes('new-note.md'));
  await engD.acceptNew(['new-note.md']);
  snap = await engD.commitAndPush(null);
  check('确认后提交并推送成功', snap.phase === 'synced', `phase=${snap.phase} err=${snap.lastError}`);
  check('远端已收到确认上传的文件', sh(['ls-tree', '-r', '--name-only', 'main'], remote).includes('new-note.md'));

  // ================= 场景 11：两类文件的策略分离 =================
  console.log('\n场景 11 · 已跟踪改动自动上传，新增文件仍需确认');
  const dirE = path.join(tmp, 'devE');
  sh(['clone', remote, dirE], tmp);
  const projE = {
    ...defaultProject(),
    name: 'devE',
    localDir: dirE,
    remoteUrl: remote,
    branch: 'main',
    auth: { mode: 'none', username: '', token: '' },
    // 故意保留 pushMode: confirm，验证 auto 策略能覆盖它
    sync: {
      ...defaultProject().sync,
      trackedChangePolicy: 'auto', newFilePolicy: 'ask',
      pushMode: 'confirm', autoCommit: false,
    },
  };
  const engE = makeEngine(projE);
  write(dirE, 'README.md', '# hello\n\ntracked-edit\n');
  write(dirE, 'brand-new.txt', 'new file\n');
  snap = await engE.syncNow({ manual: true });
  check('已跟踪文件的改动被自动提交并推送', () =>
    assert.ok(sh(['show', 'main:README.md'], remote).includes('tracked-edit')),
    sh(['show', 'main:README.md'], remote));
  check('自动上传后不再停在 dirty / ahead', () =>
    assert.strictEqual(snap.phase, 'synced', `phase=${snap.phase} err=${snap.lastError}`));
  check('新增文件仍挂在待确认', () =>
    assert.ok((snap.pendingNew || []).some((c) => c.path === 'brand-new.txt'), JSON.stringify(snap.pendingNew)));
  check('新增文件没有被自动推到远端', () =>
    assert.ok(!sh(['ls-tree', '-r', '--name-only', 'main'], remote).includes('brand-new.txt')));
  await engE.acceptNew(['brand-new.txt']);
  await engE.commitAndPush(null);
  check('确认后新文件才上传', () =>
    assert.ok(sh(['ls-tree', '-r', '--name-only', 'main'], remote).includes('brand-new.txt')));

  const dirF = path.join(tmp, 'devF');
  sh(['clone', remote, dirF], tmp);
  const projF = {
    ...projE,
    name: 'devF', localDir: dirF,
    sync: { ...projE.sync, trackedChangePolicy: 'confirm' },
  };
  const engF = makeEngine(projF);
  write(dirF, 'README.md', '# hello\n\nconfirm-mode-edit\n');
  snap = await engF.syncNow({ manual: true });
  check('confirm 策略下改动不会自动上传', () =>
    assert.ok(!sh(['show', 'main:README.md'], remote).includes('confirm-mode-edit')));
  check('confirm 策略下界面显示有本地改动', () =>
    assert.strictEqual(snap.phase, 'dirty', `phase=${snap.phase}`));

  // ---- 汇总 ----
  console.log(`\n${'='.repeat(56)}`);
  console.log(`共 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`);
  if (failed) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  - ${r.name}${r.extra ? ` (${r.extra})` : ''}`);
    }
  }
  console.log(`\n临时目录保留在：${tmp}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常：', err);
  process.exit(1);
});
