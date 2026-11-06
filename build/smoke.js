'use strict';
/**
 * 启动冒烟测试：用临时配置真实启动 Electron 界面并截图。
 * 用法：npx electron build/smoke.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'build', 'shots');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'filesharing-smoke-'));
process.env.FILESHARING_USER_DATA = tmp;

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 准备一个真实的测试仓库 ----------
const remote = path.join(tmp, 'remote.git');
const work = path.join(tmp, 'workspace');
fs.mkdirSync(remote, { recursive: true });
git(['init', '--bare', '-b', 'main'], remote);

const seed = path.join(tmp, 'seed');
git(['clone', remote, seed], tmp);
git(['config', 'user.email', 'demo@local'], seed);
git(['config', 'user.name', 'Demo'], seed);
fs.mkdirSync(path.join(seed, 'docs'), { recursive: true });
fs.writeFileSync(path.join(seed, 'README.md'), '# 团队知识库\n\n这里是共享文档。\n');
fs.writeFileSync(path.join(seed, 'docs', 'meeting.md'), '# 周会记录\n\n- 讨论同步方案\n');
git(['add', '-A'], seed);
git(['commit', '-m', 'init'], seed);
git(['push', '-u', 'origin', 'main'], seed);

// 工作副本：制造一个本地改动，方便截图展示改动列表
git(['clone', remote, work], tmp);
git(['config', 'user.email', 'demo@local'], work);
git(['config', 'user.name', 'Demo'], work);
fs.writeFileSync(path.join(work, 'README.md'), '# 团队知识库\n\n这里是共享文档（本机修改过）。\n');
fs.writeFileSync(path.join(work, 'docs', 'new-note.md'), '新增笔记\n');

// ---------- 写配置 ----------
const projectId = '11111111-1111-1111-1111-111111111111';
const config = {
  version: 1,
  deviceId: 'smoke-device',
  deviceName: 'DESKTOP-DEMO',
  globals: {
    proxyMode: 'none', proxyUrl: '', proxyUser: '', proxyPass: '',
    startAtLogin: false, startMinimized: false, closeToTray: true,
    scanIntervalSec: 4, gitPath: 'git', logLevel: 'info', theme: 'light',
  },
  projects: [{
    id: projectId,
    name: '团队知识库',
    localDir: work,
    remoteUrl: remote,
    branch: 'main',
    enabled: true,
    auth: { mode: 'none', username: '', token: '' },
    proxy: { mode: 'inherit', url: '', user: '', pass: '' },
    sync: { intervalSec: 60, pushMode: 'confirm', trackedChangePolicy: 'confirm', autoCommit: false, allowUnrelatedMerge: false, watchFiles: true, newFilePolicy: "ask" },
    exclude: [],
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
  }],
};
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

// ---------- 启动主程序 ----------
require('../main.js');

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (...args) => {
    const d = args[0];
    if (d && typeof d === 'object' && 'message' in d) console.log('RENDERER:', d.level, d.message);
    else console.log('RENDERER:', args[2]);
  });
  win.webContents.on('did-fail-load', (_ev, code, desc, url) => console.log('LOADFAIL:', code, desc, url));
  win.webContents.on('preload-error', (_ev, path, err) => console.log('PRELOAD_ERR:', path, err && err.message));
  win.webContents.on('did-finish-load', async () => {
    fs.mkdirSync(OUT, { recursive: true });
    try {
      await wait(4000);
      let img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '01-main.png'), img.toPNG());

      const click = async (sel) => {
        const r = await win.webContents.executeJavaScript(
          `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'MISSING'; e.click(); return 'ok';})()`
        );
        if (r !== 'ok') console.log('CLICK_FAIL=' + sel);
        return r;
      };

      const setVal = async (sel, value) => win.webContents.executeJavaScript(
        `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'MISSING'; e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()`
      );
      const setCheck = async (sel, checked) => win.webContents.executeJavaScript(
        `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'MISSING'; e.checked=${checked ? 'true' : 'false'}; return 'ok';})()`
      );

      // ---- 设置页：凭据库 UI ----
      await click('#btnSettings');
      await wait(700);
      img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '02-settings.png'), img.toPNG());

      const credUi = await win.webContents.executeJavaScript(`(() => JSON.stringify({
        hasList: !!document.querySelector('#credList'),
        hasAdd: !!document.querySelector('#btnAddCred'),
        hasApply: !!document.querySelector('#btnApplyAll'),
        hasAuto: !!document.querySelector('#g-autoMatch'),
        section: [...document.querySelectorAll('.form-section')].some((e) => e.textContent.includes('Git 凭据库')),
      }))()`);
      console.log('SETTINGS_CRED_UI=' + credUi);

      // 一键添加第 1 条（GitHub，设为默认）
      await click('#btnAddCred');
      await wait(250);
      await setVal('#c-name', 'GitHub 冒烟');
      await setVal('#c-host', 'github.com');
      await setVal('#c-token', 'ghp_SMOKE_TOKEN_A_1234');
      await click('#c-save');
      await wait(700);

      // 一键添加第 2 条（公司 GitLab，不设默认）
      await click('#btnAddCred');
      await wait(250);
      await setVal('#c-name', '公司 GitLab');
      await setVal('#c-host', 'git.corp.com');
      await setVal('#c-token', 'glpat_SMOKE_TOKEN_B_5678');
      await setCheck('#c-default', false);
      await click('#c-save');
      await wait(700);

      const listState = await win.webContents.executeJavaScript(`(() => JSON.stringify({
        rows: document.querySelectorAll('.cred-row').length,
        defaults: document.querySelectorAll('.cred-badge').length,
        previews: [...document.querySelectorAll('.cred-sub .mono')].map((e) => e.textContent),
        banner: (document.querySelector('#credBannerTitle') || {}).textContent || '',
      }))()`);
      console.log('CRED_LIST=' + listState);

      const rawCfg = fs.readFileSync(path.join(tmp, 'config.json'), 'utf8');
      console.log('CONFIG_TOKENS_ENC=' + (
        rawCfg.includes('"tokenEnc"') &&
        !rawCfg.includes('ghp_SMOKE_TOKEN_A_1234') &&
        !rawCfg.includes('glpat_SMOKE_TOKEN_B_5678')
      ));
      img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '05-settings-token.png'), img.toPNG());

      // ---- 一键应用到全部目录 ----
      await click('#btnApplyAll');
      await wait(1000);
      const cfgAfter = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
      console.log('APPLY_ALL=' + JSON.stringify({
        projects: cfgAfter.projects.length,
        allCredential: cfgAfter.projects.every((p) => p.auth.mode === 'credential'),
        sameId: cfgAfter.projects.every((p) => p.auth.credentialId === cfgAfter.globals.defaultCredentialId),
      }));

      await click('[data-close]');
      await wait(300);

      // ---- 项目弹窗：四态认证 ----
      await click('[data-action="edit"]');
      await wait(900);
      img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '03-project.png'), img.toPNG());

      const authUi = await win.webContents.executeJavaScript(`(() => {
        const sel = document.querySelector('#f-authMode');
        if (!sel) return 'NO_AUTH_MODE';
        const opts = [...sel.options].map((o) => o.value);
        const custom = document.querySelector('#customAuthFields');
        const pick = document.querySelector('#credentialPick');
        sel.value = 'custom';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const customOn = getComputedStyle(custom).display;
        sel.value = 'credential';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const pickOn = getComputedStyle(pick).display;
        const credCount = document.querySelectorAll('#f-credentialId option').length;
        sel.value = 'global';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ opts, customOn, pickOn, credCount });
      })()`);
      console.log('PROJECT_AUTH_UI=' + authUi);

      const ignoreUi = await win.webContents.executeJavaScript(`(() => JSON.stringify({
        switchOn: (document.querySelector('#f-builtinIgnore') || {}).classList?.contains('on'),
        chips: document.querySelectorAll('.rule-chip').length,
        hasTextarea: !!document.querySelector('#f-exclude'),
      }))()`);
      console.log('IGNORE_UI=' + ignoreUi);
      const scrollDiag = await win.webContents.executeJavaScript(`(() => {
        const chips = document.querySelector('.rule-chips');
        if (chips) chips.scrollIntoView({ block: 'center' });
        const b = document.querySelector('.modal-body');
        if (b) b.scrollTop = b.scrollHeight;
        return JSON.stringify({
          title: (document.querySelector('.modal-title') || {}).textContent || '',
          scrollTop: b ? b.scrollTop : -1,
          scrollHeight: b ? b.scrollHeight : -1,
          clientHeight: b ? b.clientHeight : -1,
        });
      })()`);
      console.log('IGNORE_SCROLL=' + scrollDiag);
      await wait(700);
      img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '06-ignore-rules.png'), img.toPNG());

      const policyUi = await win.webContents.executeJavaScript(`(() => JSON.stringify({
        tracked: (document.querySelector('#f-trackedChangePolicy') || {}).value,
        trackedOptions: [...(document.querySelector('#f-trackedChangePolicy') || {options:[]}).options].map(o => o.value),
        newFile: (document.querySelector('#f-newFilePolicy') || {}).value,
        hasOldPushMode: !!document.querySelector('#f-pushMode'),
        hasOldAutoCommit: !!document.querySelector('#f-autoCommit'),
      }))()`);
      console.log('POLICY_UI=' + policyUi);

      await click('[data-close]');
      await wait(300);
      await click('#btnAdd');
      await wait(600);
      const newPolicy = await win.webContents.executeJavaScript(`(() => JSON.stringify({
        tracked: (document.querySelector('#f-trackedChangePolicy') || {}).value,
        newFile: (document.querySelector('#f-newFilePolicy') || {}).value,
      }))()`);
      console.log('NEW_PROJECT_POLICY=' + newPolicy);
      await click('[data-close]');
      await wait(300);

      // ---- 待确认新文件 + 正则快速匹配工具 ----
      const pending = await win.webContents.executeJavaScript(`(() => JSON.stringify({
        panel: !!document.querySelector('#pendingNewPanel'),
        rows: document.querySelectorAll('#pendingNewPanel .file-row').length,
      }))()`);
      console.log('PENDING_NEW=' + pending);

      await click('[data-action="regex-tool"]');
      await wait(400);
      await setVal('#rx-pattern', '\\.md$');
      await wait(200);
      const rx = await win.webContents.executeJavaScript(`(() => JSON.stringify({
        hint: (document.querySelector('#rx-hint') || {}).textContent || '',
        hits: document.querySelectorAll('.rx-row.hit').length,
        enabled: !(document.querySelector('#rx-add') || {}).disabled,
      }))()`);
      console.log('REGEX_TOOL=' + rx);
      img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '07-regex-tool.png'), img.toPNG());
      await click('#rx-add');
      await wait(700);
      const cfgRx = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
      console.log('REGEX_RULE_SAVED=' + JSON.stringify((cfgRx.projects[0].ignoreRegex || [])));
      await click('[data-close]');
      await wait(300);

      // 触发一次同步，观察状态变化
      await click('[data-action="sync"]');
      await wait(3500);
      img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, '04-after-sync.png'), img.toPNG());

      const excludePath = path.join(tmp, 'workspace', '.git', 'info', 'exclude');
      const excludeText = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
      console.log('EXCLUDE_HAS_LOCK_RULE=' + excludeText.includes('~$*'));

      // ---- 复现用户场景：添加一个完全不是 git 仓库的普通目录 ----
      const plainDir = path.join(tmp, 'plain-workspace');
      fs.mkdirSync(plainDir, { recursive: true });
      fs.writeFileSync(path.join(plainDir, '本地文档.txt'), 'hello\n', 'utf8');
      const plainRes = await win.webContents.executeJavaScript(`(async () => {
        try {
          const dir = ${JSON.stringify(plainDir)};
          const cfg = await window.api.project.save({
            name: '普通目录测试', localDir: dir, remoteUrl: ${JSON.stringify(remote)},
            branch: 'main', enabled: true,
            auth: { mode: 'none' }, proxy: { mode: 'inherit', url: '' },
            sync: { intervalSec: 60, pushMode: 'confirm', trackedChangePolicy: 'confirm', autoCommit: false,
                    watchFiles: true, builtinIgnore: true, newFilePolicy: 'ask' },
            exclude: [],
          });
          const p = cfg.projects.find((x) => x.localDir === dir);
          const snap = await window.api.project.inspect(p.id);
          return JSON.stringify({ ok: true, phase: snap.phase, lastError: snap.lastError || '' });
        } catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
      })()`);
      console.log('PLAIN_DIR_SAVE=' + plainRes);
      await wait(1200);
      console.log('PLAIN_DIR_HAS_HEAD=' + fs.existsSync(path.join(plainDir, '.git', 'HEAD')));
      console.log('PLAIN_DIR_LOCAL_FILE_KEPT=' + fs.existsSync(path.join(plainDir, '本地文档.txt')));

      const state = await win.webContents.executeJavaScript(
        `JSON.stringify({ api: typeof window.api, phase: (document.querySelector('.status-pill')||{}).textContent, files: document.querySelectorAll('.file-row').length })`
      ).catch((e) => 'EVAL_ERR ' + e.message);
      console.log('SMOKE_STATE=' + state);
      console.log('SMOKE_OK');
    } catch (err) {
      console.error('SMOKE_FAIL', err && err.message);
    } finally {
      setTimeout(() => app.exit(0), 400);
    }
  });
});

setTimeout(() => {
  console.error('SMOKE_FAIL 超时');
  app.exit(1);
}, 60000);
