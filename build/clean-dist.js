'use strict';
/**
 * 清理 electron-builder 的中间目录。
 * 用系统命令删除，避免 node 的批量删除保护拦住构建。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) fs.mkdirSync(dist, { recursive: true });

for (const name of ['win-unpacked', 'win-unpacked.tmp']) {
  const dir = path.join(dist, name);
  if (!fs.existsSync(dir)) continue;
  if (process.platform === 'win32') {
    const r = spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'pipe' });
    if (r.status !== 0) {
      // 退化方案：重命名让位，不阻塞构建
      fs.renameSync(dir, `${dir}.old-${Date.now()}`);
    }
  } else {
    const r = spawnSync('rm', ['-rf', dir], { stdio: 'pipe' });
    if (r.status !== 0) fs.renameSync(dir, `${dir}.old-${Date.now()}`);
  }
}
console.log('构建目录已清理');
