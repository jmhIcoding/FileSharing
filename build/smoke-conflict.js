'use strict';
/**
 * 冲突场景冒烟测试：构造真实的合并冲突，验证冲突面板与解决流程。
 * 用法：npx electron build/smoke-conflict.js
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'build', 'shots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesharing-conflict-'));
process.env.FILESHARING_USER_DATA = tmp;

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 构造冲突 ----------
const remote = path.join(tmp, 'remote.git');
const work = path.join(tmp, 'workspace');
fs.mkdirSync(remote, { recursive: true });
git(['init', '--bare', '-b', 'main'], remote);

const seed = path.join(tmp, 'seed');
git(['clone', remote, seed], tmp);
git(['config', 'user.email', 'demo@local'], seed);
git(['config', 'user.name', 'Demo'], seed);
fs.mkdirSync(path.join(seed, 'config'), { recursive: true });
fs.writeFileSync(path.join(seed, 'config', 'server.json'), '{\n  "host": "10.0.0.1",\n  "port": 8080\n}\n');
fs.writeFileSync(path.join(seed, 'README.md'), '# 配置中心\n');
git(['add', '-A'], seed);
git(['commit', '-m', 'init'], seed);
git(['push', '-u', 'origin', 'main'], seed);

git(['clone', remote, work], tmp);
git(['config', 'user.email', 'demo@local'], work);
git(['config', 'user.name', 'Demo'], work);

// 远端改一行
fs.writeFileSync(path.join(seed, 'config', 'server.json'), '{\n  "host": "10.0.0.9",\n  "port": 8080\n}\n');
git(['add', '-A'], seed);
git(['commit', '-m', '远端修改 host'], seed);
git(['push'], seed);

// 本地改同一行
fs.writeFileSync(path.join(work, 'config', 'server.json'), '{\n  "host": "127.0.0.1",\n  "port": 8080\n}\n');
git(['add', '-A'], work);
git(['commit', '-m', '本地修改 host'], work);

// 触发冲突合并
git(['fetch', 'origin'], work);
let conflicted = false;
try {
  git(['merge', 'origin/main'], work);
} catch (_) {
  conflicted = true;
}

// ---------- 配置 ----------
const projectId = '22222222-2222-2222-2222-222222222222';
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  version: 1,
  deviceId: 'smoke-conflict',
  deviceName: 'DESKTOP-DEMO',
  globals: {
    proxyMode: 'none', proxyUrl: '', proxyUser: '', proxyPass: '',
    startAtLogin: false, startMinimized: false, closeToTray: true,
    scanIntervalSec: 4, gitPath: 'git', logLevel: 'info', theme: 'light',
  },
  projects: [{
    id: projectId,
    name: '服务配置',
    localDir: work,
    remoteUrl: remote,
    branch: 'main',
    enabled: true,
    auth: { mode: 'none', username: '', token: '' },
    proxy: { mode: 'inherit', url: '', user: '', pass: '' },
    sync: { intervalSec: 60, pushMode: 'confirm', trackedChangePolicy: 'confirm', autoCommit: false, allowUnrelatedMerge: false, watchFiles: true, newFilePolicy: "auto" },
    exclude: [],
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
  }],
}, null, 2), 'utf8');

require('../main.js');

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (...args) => {
    const d = args[0];
    if (d && typeof d === 'object' && 'message' in d) console.log('RENDERER:', d.message);
    else console.log('RENDERER:', args[2]);
  });

  win.webContents.on('did-finish-load', async () => {
    fs.mkdirSync(OUT, { recursive: true });
    try {
      if (!conflicted) throw new Error('未能构造冲突');
      await wait(4200);
      let img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '10-conflict.png'), img.toPNG());

      const cnt = await win.webContents.executeJavaScript(
        `document.querySelectorAll('[data-action="resolve-theirs"]').length + '|' + (document.querySelector('.status-pill')||{}).textContent + '|' + [...document.querySelectorAll('[data-action]')].map(e=>e.dataset.action).join(',')`
      );
      console.log('DIAG=' + cnt);

      // 点"采用远端"解决冲突
      await win.webContents.executeJavaScript(
        `(document.querySelector('[data-action="resolve-theirs"]')||{click(){}}).click()`
      );
      await wait(1500);
      img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '11-resolved.png'), img.toPNG());

      // 完成合并
      await win.webContents.executeJavaScript(
        `(document.querySelector('[data-action="finish-merge"]')||{click(){console.log('NO_FINISH_BTN')}}).click()`
      );
      await wait(2500);
      img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '12-merged.png'), img.toPNG());

      const state = await win.webContents.executeJavaScript(`JSON.stringify({
        phase: (document.querySelector('.status-pill')||{}).textContent,
        conflictPanel: !!document.querySelector('.panel.conflict'),
        fileTag: (document.querySelector('.file-tag')||{}).textContent || ''
      })`);
      console.log('SMOKE_STATE=' + state);
      console.log('SMOKE_OK');
    } catch (err) {
      console.error('SMOKE_FAIL', err && err.message);
    } finally {
      setTimeout(() => app.exit(0), 400);
    }
  });
});

setTimeout(() => { console.error('SMOKE_FAIL 超时'); app.exit(1); }, 60000);
