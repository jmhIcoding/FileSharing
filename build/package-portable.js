'use strict';
/**
 * 生成绿色免安装版（不依赖联网下载打包工具）。
 * 用法：node build/package-portable.js
 * 产物：dist/FileSharing/FileSharing.exe
 *
 * 复制大量文件时调用系统命令（robocopy / cp），
 * 比 fs.cpSync 更快，也不会在受限环境下被中断。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outDir = path.join(root, 'dist', 'FileSharing');
const appDir = path.join(outDir, 'resources', 'app');

if (!fs.existsSync(electronDist)) {
  console.error('未找到 electron 运行时，请先执行 npm install');
  process.exit(1);
}

function copyTree(src, dst, label) {
  fs.mkdirSync(dst, { recursive: true });
  if (process.platform === 'win32') {
    // robocopy 成功退出码为 0-7
    const res = spawnSync('robocopy', [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'], { stdio: 'pipe' });
    if (res.status !== null && res.status > 7) {
      console.error(`${label} 复制失败，robocopy 退出码 ${res.status}`);
      console.error(String(res.stderr || ''));
      process.exit(1);
    }
  } else {
    const res = spawnSync('cp', ['-r', `${src}/.`, dst], { stdio: 'pipe' });
    if (res.status !== 0) {
      console.error(`${label} 复制失败`);
      process.exit(1);
    }
  }
}

console.log('[1/5] 清理旧产物…');
fs.rmSync(outDir, { recursive: true, force: true });

console.log('[2/5] 复制 Electron 运行时（约 325MB）…');
copyTree(electronDist, outDir, '运行时');

console.log('[3/5] 清理默认入口…');
for (const name of ['default_app.asar', 'default_app']) {
  const p = path.join(outDir, 'resources', name);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

// 内置 Git 运行时：没有就尝试现场提取，失败也不阻断打包
const vendorDir = path.join(root, 'vendor', 'git');
if (!fs.existsSync(path.join(vendorDir, 'mingw64', 'bin', 'git.exe'))) {
  console.log('未找到内置 Git，尝试自动提取…');
  spawnSync(process.execPath, [path.join(__dirname, 'vendor-git.js')], { stdio: 'pipe' });
}
const hasVendor = fs.existsSync(path.join(vendorDir, 'mingw64', 'bin', 'git.exe'));
if (!hasVendor) console.warn('警告：未内置 Git，目标机器需自行安装 Git for Windows。');

console.log('[4/5] 复制应用代码…');
fs.mkdirSync(appDir, { recursive: true });
for (const f of ['main.js', 'preload.js']) {
  fs.copyFileSync(path.join(root, f), path.join(appDir, f));
}
for (const dir of ['core', 'renderer', 'assets']) {
  copyTree(path.join(root, dir), path.join(appDir, dir), dir);
}
if (hasVendor) {
  console.log('      附带内置 Git 运行时…');
  copyTree(vendorDir, path.join(appDir, 'vendor', 'git'), '内置 Git');
}

// 精简后的 package.json
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  main: pkg.main,
  author: pkg.author,
  license: pkg.license,
}, null, 2), 'utf8');

console.log('[5/5] 重命名可执行文件…');
const exeSrc = path.join(outDir, 'electron.exe');
const exeDst = path.join(outDir, 'FileSharing.exe');
if (fs.existsSync(exeSrc)) fs.renameSync(exeSrc, exeDst);

fs.writeFileSync(path.join(outDir, '使用说明.txt'), [
  'FileSharing — 本地目录 Git 自动同步监控',
  '',
  '1. 双击 FileSharing.exe 启动。',
  '2. 首次使用请在「设置」里确认 Git 可执行文件路径（需要本机已安装 Git for Windows）。',
  '3. 点击左上角 + 添加要监控的目录，填写 Git 仓库的 HTTPS 地址与访问 Token。',
  '4. 需要访问 GitHub 时，在「设置 → 网络代理」里填写本地代理地址（如 http://127.0.0.1:7890）。',
  '',
  '配置与日志位置：%APPDATA%\\FileSharing',
  '',
].join('\r\n'), 'utf8');

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
console.log(`体积：${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`可执行：${exeDst}`);
console.log(`内置 Git：${hasVendor ? '是（目标机器零依赖）' : '否'}`);
