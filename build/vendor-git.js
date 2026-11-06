'use strict';
/**
 * 把本机可用的精简 Git 运行时提取到 vendor/git，让成品无需用户预装 Git。
 * 用法：node build/vendor-git.js
 *
 * 来源优先级：
 *   1. 环境变量 FILESHARING_GIT_SOURCE（指向含 mingw64/ 的 Git 根目录）
 *   2. 本机常见 PortableGit / Git for Windows 安装位置
 *   3. 由 `git --exec-path` 反推
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'vendor', 'git');

const CANDIDATES = [
  process.env.FILESHARING_GIT_SOURCE || process.env.GITSYNC_GIT_SOURCE,
  'C:\\Program Files\\WorkBuddy\\resources\\vendor\\PortableGit',
  'C:\\Program Files\\Git',
  'C:\\Program Files (x86)\\Git',
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git'),
].filter(Boolean);

function findSource() {
  for (const dir of CANDIDATES) {
    if (!dir || !fs.existsSync(dir)) continue;
    const gitExe = path.join(dir, 'mingw64', 'bin', 'git.exe');
    if (fs.existsSync(gitExe)) return dir;
    // 标准 Git for Windows 也可能用 ucrt64
    const alt = path.join(dir, 'ucrt64', 'bin', 'git.exe');
    if (fs.existsSync(alt)) return dir;
  }

  // 从当前 PATH 里的 git 反推
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const norm = execPath.replace(/\//g, path.sep);
    // .../mingw64/libexec/git-core  → .../..
    const idx = norm.indexOf(`${path.sep}libexec${path.sep}git-core`);
    if (idx > 0) {
      const base = norm.slice(0, idx);           // .../mingw64
      const top = path.dirname(base);            // PortableGit 根
      if (fs.existsSync(path.join(base, 'bin', 'git.exe'))) return top;
    }
  } catch (_) { /* ignore */ }
  return null;
}

function robocopy(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const res = spawnSync('robocopy', [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'], { stdio: 'pipe' });
  if (res.status !== null && res.status > 7) {
    throw new Error(`robocopy 失败（退出码 ${res.status}）：${String(res.stderr || '')}`);
  }
}

const source = findSource();
if (!source) {
  console.error([
    '未找到可提取的 Git 运行时。',
    '请安装 Git for Windows，或用环境变量指定：',
    '  set FILESHARING_GIT_SOURCE=C:\\Program Files\\Git',
    '  node build/vendor-git.js',
    '',
    '跳过此步仍然可以打包，只是成品需要目标机器自己装 Git。',
  ].join('\n'));
  process.exit(2);
}

console.log(`来源：${source}`);
const archDir = fs.existsSync(path.join(source, 'mingw64', 'bin', 'git.exe')) ? 'mingw64' : 'ucrt64';
const gitExe = path.join(source, archDir, 'bin', 'git.exe');

console.log('[1/3] 清理旧文件…');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

console.log('[2/3] 复制 Git 运行时…');
robocopy(path.join(source, archDir), path.join(outDir, 'mingw64'));

// 许可与来源说明（Git for Windows 为 GPL 系列，必须随分发附带许可）
console.log('[3/3] 写入许可信息…');
for (const name of ['LICENSE.txt', 'LICENSE', 'COPYING']) {
  const p = path.join(source, name);
  if (fs.existsSync(p)) {
    fs.copyFileSync(p, path.join(outDir, name));
    break;
  }
}
fs.writeFileSync(path.join(outDir, 'THIRD-PARTY.txt'), [
  '本目录包含 Git for Windows 的可执行文件与运行库。',
  `提取来源：${source}`,
  `版本：${execFileSync(gitExe, ['--version'], { encoding: 'utf8' }).trim()}`,
  '',
  'Git for Windows 遵循 GNU General Public License v2（及所含组件的各自许可证）。',
  '完整许可文本见同目录 LICENSE.txt；源码与构建方式见 https://gitforwindows.org/',
  '',
  'FileSharing 仅以独立子进程方式调用 git.exe，未静态链接或改写其代码。',
  '',
].join('\r\n'), 'utf8');

// 验证提取结果可独立运行
const extracted = path.join(outDir, 'mingw64', 'bin', 'git.exe');
const check = spawnSync(extracted, ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: 'C:\\Windows\\System32' } });
if (check.status !== 0) {
  console.error('提取后的 git 无法运行：', String(check.stderr || check.error));
  process.exit(1);
}

let bytes = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else bytes += fs.statSync(p).size;
  }
})(outDir);

console.log('');
console.log(`完成：${outDir}`);
console.log(`版本：${String(check.stdout).trim()}`);
console.log(`体积：${(bytes / 1024 / 1024).toFixed(1)} MB`);
