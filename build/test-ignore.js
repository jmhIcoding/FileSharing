'use strict';
/**
 * Office / WPS 临时文件忽略自测（不依赖 Electron）
 * 用法：node build/test-ignore.js
 *
 * 覆盖：临时文件名匹配、内置 + 自定义规则合并与去重、开关关闭、
 *      真实 Git 仓库里 git status 确实看不到临时文件、旧规则块替换、
 *      已跟踪临时文件检测、fs.watch 层不再因打开 Word 触发同步。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const { RepoEngine } = require('../core/engine');
const { Scheduler } = require('../core/scheduler');
const { defaultProject } = require('../core/store');
const ignore = require('../core/ignore');

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesharing-ignore-'));

function write(rel, content = 'x') {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}
function project(extra = {}) {
  const { sync, ...rest } = extra;
  return {
    ...defaultProject(),
    name: 'ignore-test',
    localDir: tmp,
    remoteUrl: 'https://example.invalid/repo.git',
    branch: 'main',
    auth: { mode: 'none', credentialId: '', username: '', token: '' },
    // 这些场景测的是忽略规则，沿用「全部自动纳入」的旧语义
    sync: { ...defaultProject().sync, trackedChangePolicy: 'confirm', newFilePolicy: 'auto', ...(sync || {}) },
    ...rest,
  };
}
function engineFor(p) {
  return new RepoEngine(p, { logger, gitPath: GIT, gitEnv: GIT_ENV, getGlobals: () => ({}) });
}
function trackedFiles() {
  return sh(['ls-files', '-z'], tmp).split('\0').filter(Boolean);
}
function statusPaths() {
  return sh(['status', '--porcelain=v1', '-z', '--untracked-files=all'], tmp)
    .split('\0').filter(Boolean).map((s) => s.slice(3));
}

async function main() {
  console.log(`临时目录：${tmp}\n`);

  // ================= 1. 文件名匹配 =================
  console.log('场景 1 · 识别 Office / WPS 临时文件');
  const transient = [
    '~$报价单.docx', '~$report.xlsx', '~$演示.pptx', '~$表.et', '~$文稿.wps', '~$模板.dps',
    '~WRL0001.tmp', '~WRD1234.tmp', '.~lock.文档.docx#',
    'a.tmp', 'a.temp', '.a.swp', '.a.swo', 'note.txt~', '备份.bak',
    'Thumbs.db', 'desktop.ini', '.DS_Store',
    'docs/~$a.docx', 'sub/dir/a.tmp',
  ];
  const normal = ['报价单.docx', 'report.xlsx', 'README.md', 'src/app.js', 'build/out.js', 'notes.txt', 'a.tempfile'];
  check(`${transient.length} 种临时文件全部识别`, () =>
    assert.ok(transient.every((p) => ignore.isTransientPath(p)), JSON.stringify(transient.filter((p) => !ignore.isTransientPath(p)))));
  check(`${normal.length} 种正常文件不误判`, () =>
    assert.ok(normal.every((p) => !ignore.isTransientPath(p)), JSON.stringify(normal.filter((p) => ignore.isTransientPath(p)))));
  check('空路径不报错', () => assert.strictEqual(ignore.isTransientPath(''), false));
  check('Windows 反斜杠路径也能识别', () =>
    assert.strictEqual(ignore.isTransientPath('docs\\~$b.docx'), true));

  // ================= 2. 规则合并 =================
  console.log('\n场景 2 · 内置 + 自定义规则合并');
  const lines = ignore.buildExcludeLines(['*.log', 'node_modules/', '*.tmp'], true);
  check('内置规则全部写入', () =>
    assert.ok(ignore.BUILTIN_EXCLUDE_RULES.every((r) => lines.includes(r))));
  check('自定义规则保留', () =>
    assert.ok(lines.includes('*.log') && lines.includes('node_modules/')));
  check('与内置重复的规则自动去重', () =>
    assert.strictEqual(lines.filter((l) => l === '*.tmp').length, 1));
  check('关闭开关后不写内置规则', () => {
    const off = ignore.buildExcludeLines(['*.log'], false);
    assert.ok(!off.includes('~$*') && !off.includes(ignore.BUILTIN_HEADER));
    assert.ok(off.includes('*.log'));
  });
  check('空规则时关闭开关返回空数组', () =>
    assert.deepStrictEqual(ignore.buildExcludeLines([], false), []));
  check('老项目缺 builtinIgnore 字段时默认开启', () =>
    assert.strictEqual(ignore.builtinEnabled(project({ sync: { watchFiles: true } })), true));
  check('显式关闭时返回 false', () =>
    assert.strictEqual(ignore.builtinEnabled(project({ sync: { builtinIgnore: false } })), false));
  check('缺省策略为「新增文件需要确认」', () =>
    assert.strictEqual(ignore.needsConfirm(project({ sync: { newFilePolicy: undefined } })), true));
  check('auto 策略跳过确认', () =>
    assert.strictEqual(ignore.needsConfirm(project({ sync: { newFilePolicy: 'auto' } })), false));
  check('合法正则可编译', () =>
    assert.strictEqual(ignore.compileRegex('\\.tmp$').test('a.tmp'), true));
  check('非法正则抛出可读错误', () =>
    assert.throws(() => ignore.compileRegex('([a-z'), /无效/));
  check('超长正则被拒绝', () =>
    assert.throws(() => ignore.compileRegex('a'.repeat(300)), /过长/));
  check('正则同时匹配完整路径与文件名', () => {
    assert.strictEqual(ignore.matchesAnyRegex('docs/draft/a.tmp', ['^docs/']), true);
    assert.strictEqual(ignore.matchesAnyRegex('docs/draft/a.tmp', ['^a\\.tmp$']), true);
  });
  check('大小写默认不敏感，可切换', () => {
    assert.strictEqual(ignore.matchesAnyRegex('A.TMP', ['\\.tmp$']), true);
    assert.strictEqual(ignore.matchesAnyRegex('A.TMP', ['\\.tmp$'], { caseSensitive: true }), false);
  });
  check('无效正则不会让同步崩溃', () =>
    assert.strictEqual(ignore.matchesAnyRegex('a.txt', ['([a-z']), false));
  check('isExcluded 同时覆盖内置规则与用户正则', () => {
    const p = project({ ignoreRegex: ['^draft/'] });
    assert.strictEqual(ignore.isExcluded(p, '~$a.docx'), true);
    assert.strictEqual(ignore.isExcluded(p, 'draft/x.tmp'), true);
    assert.strictEqual(ignore.isExcluded(p, 'src/app.js'), false);
  });
  check('escapeRegex 转义特殊字符', () =>
    assert.strictEqual(ignore.escapeRegex('~$a.docx'), '~\\$a\\.docx'));

  // ================= 3. 真实 Git 仓库 =================
  console.log('\n场景 3 · git status 不再看到临时文件（不会上传）');
  sh(['init', '-b', 'main'], tmp);
  sh(['config', 'user.email', 't@test.local'], tmp);
  sh(['config', 'user.name', 'T'], tmp);
  write('README.md', '# docs\n');
  sh(['add', 'README.md'], tmp);
  sh(['commit', '-m', 'init'], tmp);

  for (const f of transient) write(f, 'tmp');
  write('报价单.docx', 'real document\n');
  write('docs/周报.docx', 'real\n');

  const eng = engineFor(project());
  await eng._applyExcludeRules();
  const excludeFile = path.join(tmp, '.git', 'info', 'exclude');
  const excludeText = fs.readFileSync(excludeFile, 'utf8');
  check('规则写入 .git/info/exclude', () => assert.ok(excludeText.includes('~$*')));
  check('规则带 FileSharing managed 块头', () =>
    assert.ok(excludeText.includes('# --- FileSharing managed rules ---')));
  check('没有写进仓库可提交的 .gitignore', () => assert.ok(!fs.existsSync(path.join(tmp, '.gitignore'))));

  const st1 = statusPaths();
  check('临时文件不出现在 git status', () =>
    assert.ok(!st1.some((p) => ignore.isTransientPath(p)), JSON.stringify(st1)));
  check('真实文档仍被识别为改动', () =>
    assert.ok(st1.some((p) => p.includes('报价单.docx')) && st1.some((p) => p.includes('周报.docx'))));
  const snap1 = await eng.readStatus();
  check('引擎 readStatus 过滤掉锁文件', () =>
    assert.ok(!snap1.changes.some((c) => ignore.isTransientPath(c.path))));
  check('引擎 readStatus 保留真实文档', () =>
    assert.ok(snap1.changes.some((c) => c.path.includes('报价单.docx'))));

  // ================= 4. 旧规则块替换 / 用户规则共存 =================
  console.log('\n场景 4 · 规则块升级与自定义共存');
  const withUser = engineFor(project({ exclude: ['*.log', 'build/'] }));
  fs.appendFileSync(excludeFile, '\n# --- GitSync managed rules ---\nOLD\n', 'utf8');
  await withUser._applyExcludeRules();
  const text2 = fs.readFileSync(excludeFile, 'utf8');
  check('旧 GitSync 规则块被替换掉', () => assert.ok(!text2.includes('--- GitSync managed rules ---')));
  check('managed 块只出现一次', () =>
    assert.strictEqual((text2.match(/--- FileSharing managed rules ---/g) || []).length, 1));
  check('用户自定义规则写入', () => assert.ok(text2.includes('*.log') && text2.includes('build/')));
  write('build/out.js', 'y');
  write('debug.log', 'z');
  const st2 = statusPaths();
  check('自定义规则同样生效', () =>
    assert.ok(!st2.some((p) => p.includes('debug.log') || p.includes('build/out.js'))));

  // ================= 5. 关闭开关 =================
  console.log('\n场景 5 · 关掉开关后临时文件恢复可见');
  const off = engineFor(project({ sync: { ...defaultProject().sync, builtinIgnore: false }, exclude: [] }));
  await off._applyExcludeRules();
  const text3 = fs.readFileSync(excludeFile, 'utf8');
  check('关闭后 .git/info/exclude 不含内置规则', () => assert.ok(!text3.includes('~$*')));
  const st3 = statusPaths();
  check('关闭后锁文件重新出现在 git status', () =>
    assert.ok(st3.some((p) => ignore.isTransientPath(p)), JSON.stringify(st3)));

  // ================= 6. 已跟踪的历史遗留 =================
  console.log('\n场景 6 · 已被 Git 跟踪的临时文件能被检出');
  sh(['add', '-f', '~$报价单.docx'], tmp);
  check('强制加入的锁文件确实被跟踪', () => assert.ok(trackedFiles().includes('~$报价单.docx')));
  const trackedOn = await eng.readTrackedTransient();
  check('内置规则开启时能检出已跟踪临时文件', () => assert.ok(trackedOn.includes('~$报价单.docx')));
  const trackedOff = await off.readTrackedTransient();
  check('开关关闭时不检出', () => assert.strictEqual(trackedOff.length, 0));
  check('正常文件不会被误列为遗留', () =>
    assert.ok(!trackedOn.includes('README.md')));

  // ================= 7. 文件监控层过滤 =================
  console.log('\n场景 7 · 打开 Word 不触发同步');
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filesharing-watch-'));
  const wp = project({ localDir: watchDir });
  const weng = engineFor(wp);
  const engines = new Map([['w1', weng]]);
  const scheduler = new Scheduler({ getEngines: () => engines, logger, getGlobals: () => ({}) });
  scheduler._watch('w1', weng);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  fs.writeFileSync(path.join(watchDir, '~$打开文档.docx'), 'lock', 'utf8');
  await wait(900);
  check('锁文件事件不会设置 watchAt', () =>
    assert.strictEqual(scheduler._rt('w1').watchAt, 0));
  fs.writeFileSync(path.join(watchDir, '真实文档.docx'), 'real', 'utf8');
  await wait(900);
  check('真实文档事件仍会触发 watchAt', () =>
    assert.ok(scheduler._rt('w1').watchAt > 0));
  const w = scheduler.watchers.get('w1');
  if (w) { try { w.close(); } catch (_) { /* ignore */ } }

  // ================= 8. 新文件确认 / 正则 / 停止追踪 =================
  console.log('\n场景 8 · 本地新增文件需要确认，已跟踪文件可反悔');
  const askDir = path.join(tmp, 'askrepo');
  fs.mkdirSync(askDir, { recursive: true });
  sh(['init', '-b', 'main'], askDir);
  sh(['config', 'user.email', 't@test.local'], askDir);
  sh(['config', 'user.name', 'T'], askDir);
  write('askrepo/README.md', 'base\n');
  sh(['add', 'README.md'], askDir);
  sh(['commit', '-m', 'init'], askDir);
  write('askrepo/note.txt', 'wanted\n');
  write('askrepo/report.docx', 'not sure\n');
  write('askrepo/draft/scratch.tmp', 'skip\n');

  const askProj = project({
    localDir: askDir,
    sync: { newFilePolicy: 'ask' },
    ignoreRegex: ['^draft/'],
  });
  const askEng = engineFor(askProj);
  const s0 = await askEng.readStatus();
  check('未确认的新文件进入 pendingNew', () =>
    assert.deepStrictEqual(s0.pendingNew.map((c) => c.path).sort(), ['note.txt', 'report.docx']));
  check('未确认的新文件不算本地改动', () => assert.strictEqual(s0.changes.length, 0));
  check('正则命中的文件既不待确认也不算改动', () =>
    assert.ok(!s0.pendingNew.some((c) => c.path.startsWith('draft/')) && !s0.changes.some((c) => c.path.startsWith('draft/'))));

  await askEng.acceptNew(['note.txt']);
  const s1 = await askEng.readStatus();
  check('确认上传后从 pendingNew 移到 changes', () =>
    assert.ok(!s1.pendingNew.some((c) => c.path === 'note.txt') && s1.changes.some((c) => c.path === 'note.txt')));
  check('未确认的文件仍在等待', () => assert.ok(s1.pendingNew.some((c) => c.path === 'report.docx')));

  await askEng._commitAll('only confirmed');
  const trackedInAsk = sh(['ls-files', '-z'], askDir).split('\0').filter(Boolean);
  check('提交只纳入已确认的文件', () =>
    assert.ok(trackedInAsk.includes('note.txt') && !trackedInAsk.includes('report.docx')));
  check('正则命中的文件没有被提交', () =>
    assert.ok(!trackedInAsk.some((p) => p.startsWith('draft/'))));

  await askEng.untrackFiles(['note.txt']);
  const trackedAfter = sh(['ls-files', '-z'], askDir).split('\0').filter(Boolean);
  check('停止追踪后本地文件仍然保留', () =>
    assert.ok(fs.existsSync(path.join(askDir, 'note.txt'))));
  check('停止追踪后不再被 git 跟踪', () => assert.ok(!trackedAfter.includes('note.txt')));

  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  try { fs.rmSync(watchDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
