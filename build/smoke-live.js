'use strict';
/**
 * 真实 GitHub + 真实 Token 的 Electron 界面 / IPC 冒烟。
 *   FILESHARING_LIVE_TOKEN=xxx npx electron build/smoke-live.js
 *
 * 用 FILESHARING_USER_DATA 指向临时目录，Token 绝不写进用户真实配置。
 * 本地目录也用临时目录，不碰 D:\JMH\科研。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = path.join(__dirname, '..', 'build', 'shots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesharing-live-ui-'));
process.env.FILESHARING_USER_DATA = tmp;

const TOKEN = process.env.FILESHARING_LIVE_TOKEN || '';
const REMOTE = process.env.FILESHARING_LIVE_REMOTE || 'https://github.com/jmhIcoding/FileSharing_GUNST.git';
const PROXY = process.env.FILESHARING_LIVE_PROXY || process.env.HTTPS_PROXY || '';
const scrub = (s) => String(s || '').replace(/ghp_[A-Za-z0-9_]+/g, 'ghp_***');
if (!TOKEN) { console.error('缺少 FILESHARING_LIVE_TOKEN'); app.exit(1); }

const work = path.join(tmp, 'workspace');
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, '本地笔记.md'), '# 这是本地已有文件，不应被覆盖\n', 'utf8');
fs.writeFileSync(path.join(work, '~$打开的文档.docx'), 'office lock', 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

require('../main.js');

let phase = 0;
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (...args) => {
    const d = args[0];
    const msg = d && typeof d === 'object' && 'message' in d ? d.message : args[2];
    if (/error|fail/i.test(String(msg))) console.log('RENDERER_ERR:', scrub(msg));
  });
  win.webContents.on('did-finish-load', async () => {
    if (phase === 1) {
      phase = 2;
      // 刷新后 boot() 会重新读取已持久化的配置，模拟真实重启
      await wait(3200);
      const ui = await win.webContents.executeJavaScript(`(() => JSON.stringify({
        pendingPanel: !!document.querySelector('#pendingNewPanel'),
        pendingRows: document.querySelectorAll('#pendingNewPanel .file-row').length,
        lockFileShown: [...document.querySelectorAll('.file-path')].some(e => e.textContent.startsWith('~$')),
        credentialLabel: (document.querySelector('.detail-meta') || {}).textContent || '',
        hasErrorBanner: !!document.querySelector('.banner.err'),
        plainLeaked: document.body.innerText.includes(${JSON.stringify(TOKEN)}),
      }))()`);
      console.log('LIVE_UI_AFTER_RELOAD=' + scrub(ui));
      let img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '21-live-main.png'), img.toPNG());

      await win.webContents.executeJavaScript(`(() => { document.querySelector('#btnSettings').click(); return 'ok'; })()`);
      await wait(800);
      const settingsUi = await win.webContents.executeJavaScript(`(() => JSON.stringify({
        rows: document.querySelectorAll('.cred-row').length,
        previews: [...document.querySelectorAll('.cred-sub .mono')].map(e => e.textContent),
        plainLeaked: document.body.innerText.includes(${JSON.stringify(TOKEN)}),
      }))()`);
      console.log('LIVE_SETTINGS_UI=' + scrub(settingsUi));
      img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '22-live-settings.png'), img.toPNG());

      const realCfg = path.join(process.env.APPDATA || '', 'FileSharing', 'config.json');
      const realRaw = fs.existsSync(realCfg) ? fs.readFileSync(realCfg, 'utf8') : '';
      console.log('REAL_USER_CONFIG_UNTOUCHED=' + !realRaw.includes(TOKEN));
      console.log('LIVE_SMOKE_OK');
      setTimeout(() => app.exit(0), 400);
      return;
    }
    if (phase !== 0) return;
    phase = 1;
    fs.mkdirSync(OUT, { recursive: true });
    try {
      await wait(3500);
      let img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '20-live-start.png'), img.toPNG());

      const initState = await win.webContents.executeJavaScript(`(async () => {
        const d = await window.api.init();
        return JSON.stringify({
          api: typeof window.api, version: d.version,
          gitOk: d.git.ok, bundled: d.git.bundled,
          builtinRules: (d.builtinIgnoreRules || []).length,
          projects: d.config.projects.length,
        });
      })()`);
      console.log('LIVE_INIT=' + initState);

      // 1) 真实凭据写入临时配置目录
      const credState = await win.webContents.executeJavaScript(`(async () => {
        const cfg = await window.api.saveGlobals({
          credentials: [{ id: 'live-gh', name: 'GitHub 测试凭据', host: 'github.com',
                          username: '', token: ${JSON.stringify(TOKEN)} }],
          defaultCredentialId: 'live-gh',
          autoMatchCredential: true,
          proxyMode: ${JSON.stringify(PROXY ? 'custom' : 'none')},
          proxyUrl: ${JSON.stringify(PROXY)},
        });
        return JSON.stringify({
          count: cfg.globals.credentials.length,
          hasToken: cfg.globals.credentials[0].hasToken,
          preview: cfg.globals.credentials[0].tokenPreview,
          defaultId: cfg.globals.defaultCredentialId,
          plainLeaked: JSON.stringify(cfg).includes(${JSON.stringify(TOKEN)}),
        });
      })()`);
      console.log('LIVE_CREDENTIALS=' + scrub(credState));

      const cfgPath = path.join(tmp, 'config.json');
      const cfgRaw = fs.readFileSync(cfgPath, 'utf8');
      console.log('LIVE_CONFIG_ENCRYPTED=' + (cfgRaw.includes('"tokenEnc"') && !cfgRaw.includes(TOKEN)));

      // 2) 真实 project:test（走凭据库按域名匹配 → 真实 GitHub ls-remote）
      const testState = await win.webContents.executeJavaScript(`(async () => {
        try {
          const r = await window.api.project.test({
            remoteUrl: ${JSON.stringify(REMOTE)},
            auth: { mode: 'global' },
            proxy: { mode: 'inherit', url: '' },
          });
          return JSON.stringify({ ok: true, branches: r.branches });
        } catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
      })()`);
      console.log('LIVE_PROJECT_TEST=' + scrub(testState));

      // 3) 真实 project:save（非空普通目录接管 + 真实 clone/fetch）
      const saveState = await win.webContents.executeJavaScript(`(async () => {
        try {
          const cfg = await window.api.project.save({
            name: '真实仓库测试', localDir: ${JSON.stringify(work)},
            remoteUrl: ${JSON.stringify(REMOTE)}, branch: 'main', enabled: true,
            auth: { mode: 'global' }, proxy: { mode: 'inherit', url: '' },
            sync: { intervalSec: 60, pushMode: 'confirm', trackedChangePolicy: 'confirm', autoCommit: false,
                    watchFiles: true, builtinIgnore: true, newFilePolicy: 'ask' },
            exclude: [],
          });
          const p = cfg.projects.find(x => x.localDir === ${JSON.stringify(work)});
          const snap = await window.api.project.inspect(p.id);
          return JSON.stringify({ ok: true, phase: snap.phase,
            lastError: snap.lastError || '', pending: (snap.pendingNew || []).map(c => c.path) });
        } catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
      })()`);
      console.log('LIVE_PROJECT_SAVE=' + scrub(saveState));

      await wait(2500);
      console.log('LIVE_WORK_HAS_HEAD=' + fs.existsSync(path.join(work, '.git', 'HEAD')));
      console.log('LIVE_LOCAL_FILE_KEPT=' + fs.existsSync(path.join(work, '本地笔记.md')));
      console.log('LIVE_LOCAL_FILE_CONTENT=' + JSON.stringify(
        fs.readFileSync(path.join(work, '本地笔记.md'), 'utf8')));
      console.log('LIVE_REMOTE_FILE_PULLED=' + fs.existsSync(path.join(work, 'README.md')));
      console.log('LIVE_GIT_CONFIG_CLEAN=' + !fs.readFileSync(path.join(work, '.git', 'config'), 'utf8').includes(TOKEN));

      // 4) 刷新页面，让渲染层重新读取已持久化的配置（等同真实重启）
      img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '20-live-after-save.png'), img.toPNG());
      await win.webContents.executeJavaScript('location.reload()').catch(() => {});
    } catch (err) {
      console.error('LIVE_SMOKE_FAIL', scrub(err && err.message));
      setTimeout(() => app.exit(1), 300);
    }
  });
});

setTimeout(() => { console.error('LIVE_SMOKE_FAIL 超时'); app.exit(1); }, 120000);
