'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu,
  nativeImage, safeStorage, Notification, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_VERSION = (() => {
  try { return require('./package.json').version || app.getVersion(); }
  catch (_) { return app.getVersion(); }
})();

const { Logger } = require('./core/logger');
const { Store } = require('./core/store');
const { RepoEngine } = require('./core/engine');
const { Scheduler } = require('./core/scheduler');
const cred = require('./core/credentials');
const ignoreRules = require('./core/ignore');
const git = require('./core/git');

const isDev = process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');

// 统一应用名，保证开发模式和打包版使用同一个配置目录（%APPDATA%\FileSharing）
// 允许用 FILESHARING_USER_DATA 指定独立配置目录（便携使用 / 测试）
app.setName('FileSharing');
try {
  app.setPath(
    'userData',
    process.env.FILESHARING_USER_DATA ||
      process.env.GITSYNC_USER_DATA ||
      path.join(app.getPath('appData'), 'FileSharing')
  );
} catch (_) { /* 忽略：某些环境不允许改路径 */ }

let mainWindow = null;
let tray = null;
let store = null;
let logger = null;
let scheduler = null;
const engines = new Map();
let activeGit = { path: 'git', env: {}, bundled: false, source: 'system' };

// ---------- 单实例 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });
}

// ---------- 路径 ----------
function userDataPath(...p) {
  return path.join(app.getPath('userData'), ...p);
}

// ---------- 日志/配置 ----------
function initServices() {
  logger = new Logger(userDataPath('logs'), { level: 'info' });

  const cryptoAdapter = {
    secure: safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.encryptString(plain).toString('base64');
      }
      return Buffer.from(plain, 'utf8').toString('base64');
    },
    decrypt: (enc) => {
      const buf = Buffer.from(enc, 'base64');
      if (safeStorage.isEncryptionAvailable()) {
        try {
          return safeStorage.decryptString(buf);
        } catch (_) {
          return buf.toString('utf8');
        }
      }
      return buf.toString('utf8');
    },
  };

  store = new Store(userDataPath('config.json'), cryptoAdapter);
  store.load();
  if (!store.data.deviceName) {
    store.data.deviceName = os.hostname();
    store.save();
  }

  logger.onLine((entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log:line', entry);
    }
  });
  logger.info('app', `FileSharing 启动，配置目录：${app.getPath('userData')}`);
  logger.info('app', `Token 加密：${cryptoAdapter.secure ? '系统 DPAPI' : '未启用（base64 混淆）'}`);

  scheduler = new Scheduler({
    getEngines: () => engines,
    logger,
    getGlobals: () => store.globals,
  });
  refreshGit();
}

// ---------- Git 运行时 ----------
/**
 * 选择 git 可执行文件：
 * - 用户在设置里显式填了路径 → 用他填的
 * - 否则优先用随程序分发的内置 Git（真正的零依赖）
 * - 都没有 → 退回 PATH 里的 'git'
 */
function detectGit() {
  const configured = (store && store.globals.gitPath ? store.globals.gitPath : '').trim();
  if (configured && configured !== 'git') {
    return { path: configured, env: {}, bundled: false, source: 'custom' };
  }
  const bundledExe = path.join(__dirname, 'vendor', 'git', 'mingw64', 'bin', 'git.exe');
  if (fs.existsSync(bundledExe)) {
    const base = path.join(__dirname, 'vendor', 'git', 'mingw64');
    const env = {};
    const execPath = path.join(base, 'libexec', 'git-core');
    const template = path.join(base, 'share', 'git-core', 'templates');
    if (fs.existsSync(execPath)) env.GIT_EXEC_PATH = execPath;
    if (fs.existsSync(template)) env.GIT_TEMPLATE_DIR = template;
    // 不要注入 GIT_SSL_CAINFO：Git for Windows 默认走 schannel（Windows 系统证书库），
    // 传 PEM 路径在含中文的安装目录下会报 "failed to open CA file"，反而连不上 HTTPS。
    return { path: bundledExe, env, bundled: true, source: 'bundled' };
  }
  return { path: 'git', env: {}, bundled: false, source: 'system' };
}

function refreshGit() {
  activeGit = detectGit();
  for (const [, e] of engines) e.setGit({ path: activeGit.path, env: activeGit.env });
  logger.info('app', `Git 运行时：${activeGit.path}（${activeGit.bundled ? '内置' : '外部'}）`);
  return activeGit;
}

// ---------- 引擎 ----------
function createEngine(project) {
  const engine = new RepoEngine(project, {
    logger,
    gitPath: activeGit.path,
    gitEnv: activeGit.env,
    getGlobals: () => store.globals,
  });

  engine.on('update', (snap) => pushState(snap));
  engine.on('synced', (snap) => {
    scheduler.suppress(project.id, 6000);
    pushState(snap);
  });
  engine.on('conflict', (snap) => {
    notifyConflict(engine, snap);
  });

  engines.set(project.id, engine);
  return engine;
}

function rebuildEngines() {
  const projects = store.listProjects();
  const ids = new Set(projects.map((p) => p.id));
  for (const id of [...engines.keys()]) {
    if (!ids.has(id)) engines.delete(id);
  }
  for (const p of projects) {
    const engine = engines.get(p.id);
    if (engine) {
      engine.updateProject(p);
      engine.setGit({ path: activeGit.path, env: activeGit.env });
    } else {
      createEngine(p);
    }
  }
  scheduler.refreshWatchers();
}

function pushState(snap) {
  const engine = engines.get(snap.projectId);
  const project = engine ? engine.project : store.getProject(snap.projectId);
  if (project) {
    // 只把非敏感的展示信息带给渲染进程
    const payload = {
      ...snap,
      project: {
        id: project.id,
        name: project.name,
        localDir: project.localDir,
        branch: project.branch,
        enabled: project.enabled,
        pushMode: project.sync.pushMode,
      },
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine:update', payload);
    }
    updateTray();
  }
}

function notifyConflict(engine, snap) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: '需要处理合并冲突',
    body: `${engine.project.name}：${snap.conflicts.length} 个文件冲突，请打开 FileSharing 处理`,
    silent: false,
  });
  n.on('click', () => {
    showWindow();
    if (mainWindow) mainWindow.webContents.send('ui:focus-project', engine.project.id);
  });
  n.show();
}

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#f5f6f8',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#475569',
      height: 46,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('close', (e) => {
    if (store && store.globals.closeToTray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------- 托盘 ----------
function buildTrayIcon() {
  const p = path.join(__dirname, 'assets', 'tray.png');
  if (fs.existsSync(p)) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function createTray() {
  try {
    tray = new Tray(buildTrayIcon());
  } catch (_) {
    return;
  }
  tray.setToolTip('FileSharing 目录同步');
  updateTray();
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
}

function updateTray() {
  if (!tray) return;
  const projects = store ? store.listProjects() : [];
  const items = [];

  items.push({
    label: `监控中 ${projects.filter((p) => p.enabled).length} 个目录`,
    enabled: false,
  });
  items.push({ type: 'separator' });

  for (const p of projects.slice(0, 8)) {
    const snap = engines.get(p.id) ? engines.get(p.id).state : null;
    const icon = phaseText(snap ? snap.phase : 'idle');
    items.push({
      label: `${icon} ${p.name || p.localDir}`,
      click: () => {
        showWindow();
        if (mainWindow) mainWindow.webContents.send('ui:focus-project', p.id);
      },
    });
  }

  items.push({ type: 'separator' });
  items.push({
    label: '全部立即同步',
    click: () => { if (scheduler) scheduler.syncAll(); },
  });
  items.push({ label: '打开主窗口', click: showWindow });
  items.push({ type: 'separator' });
  items.push({
    label: '退出 FileSharing',
    click: () => {
      app.isQuitting = true;
      app.quit();
    },
  });

  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function phaseText(phase) {
  switch (phase) {
    case 'synced': return '✓';
    case 'conflict': return '!';
    case 'error': return '×';
    case 'syncing': return '…';
    case 'ahead': return '↑';
    case 'behind': return '↓';
    case 'dirty': return '•';
    default: return '·';
  }
}

// ---------- 开机自启 ----------
function applyLoginItem(enabled) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: ['--hidden'],
    });
  } catch (err) {
    logger.warn('app', `设置开机自启失败：${err.message}`);
  }
}

// ---------- IPC ----------
function registerIpc() {
  const guard = (fn) => async (event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (err) {
      logger.error('ipc', `${err.message}`);
      return { ok: false, error: err.message || String(err) };
    }
  };

  ipcMain.handle('app:init', guard(async () => {
    const gitInfo = await git.checkGit(activeGit.path, activeGit.env);
    gitInfo.bundled = activeGit.bundled;
    gitInfo.path = activeGit.path;
    gitInfo.source = activeGit.source;
    const snapshots = [];
    for (const [, engine] of engines) {
      snapshots.push(engine.snapshot());
    }
    return {
      config: publicConfig(),
      snapshots,
      git: gitInfo,
      logs: logger.recent(200),
      version: APP_VERSION,
      builtinIgnoreRules: ignoreRules.BUILTIN_EXCLUDE_RULES,
      secureStorage: safeStorage.isEncryptionAvailable(),
      platform: process.platform,
      hostname: os.hostname(),
    };
  }));

  ipcMain.handle('app:check-git', guard(async () => {
    const info = await git.checkGit(activeGit.path, activeGit.env);
    info.bundled = activeGit.bundled;
    info.path = activeGit.path;
    return info;
  }));

  ipcMain.handle('app:save-globals', guard(async (incoming) => {
    const before = { ...store.globals };
    const patch = cred.applyGlobalsPatch(store.globals, incoming);
    store.updateGlobals(patch);
    if (before.gitPath !== store.globals.gitPath) refreshGit();
    if (before.startAtLogin !== store.globals.startAtLogin) {
      applyLoginItem(store.globals.startAtLogin);
    }
    if (before.scanIntervalSec !== store.globals.scanIntervalSec) scheduler.refreshWatchers();
    return publicConfig();
  }));

  // 一键把某条凭据应用到所有监控目录
  ipcMain.handle('app:apply-credential', guard(async (credentialId) => {
    const item = cred.findCredential(store.globals.credentials, credentialId);
    if (!item) throw new Error('凭据不存在，请先在「设置 → Git 凭据库」里添加');
    const count = cred.applyCredentialToProjects(
      store.listProjects(), store.globals.credentials, credentialId
    );
    store.save();
    rebuildEngines();
    for (const [, engine] of engines) engine.inspect({ silent: true });
    logger.info('凭据', `已将「${item.name}」一键应用到 ${count} 个目录`);
    return publicConfig();
  }));

  ipcMain.handle('app:pick-folder', guard(async (defaultPath) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要同步的本地目录',
      defaultPath: defaultPath || app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择此目录',
    });
    if (res.canceled || !res.filePaths.length) return '';
    return res.filePaths[0];
  }));

  ipcMain.handle('app:open-path', guard(async (target) => {
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return true;
  }));

  ipcMain.handle('app:show-in-folder', guard(async (target) => {
    shell.showItemInFolder(target);
    return true;
  }));

  ipcMain.handle('app:open-logs', guard(async () => {
    await shell.openPath(userDataPath('logs'));
    return true;
  }));

  ipcMain.handle('app:copy', guard(async (text) => {
    clipboard.writeText(String(text || ''));
    return true;
  }));

  ipcMain.handle('app:quit', guard(async () => {
    app.isQuitting = true;
    app.quit();
    return true;
  }));

  ipcMain.handle('app:minimize', guard(async () => {
    if (mainWindow) mainWindow.minimize();
    return true;
  }));

  ipcMain.handle('app:hide', guard(async () => {
    if (mainWindow) mainWindow.hide();
    return true;
  }));

  ipcMain.handle('app:set-titlebar-theme', guard(async (theme) => {
    if (mainWindow && process.platform === 'win32') {
      try {
        mainWindow.setTitleBarOverlay({
          color: theme === 'dark' ? '#1a1d24' : '#ffffff',
          symbolColor: theme === 'dark' ? '#cbd5e1' : '#475569',
          height: 46,
        });
      } catch (_) { /* 旧版本忽略 */ }
    }
    return true;
  }));

  // ---- 项目 ----
  ipcMain.handle('project:save', guard(async (input) => {
    if (!input.localDir || !input.remoteUrl) {
      throw new Error('本地目录与 Git 地址都必须填写');
    }
    if (git.isSshUrl(input.remoteUrl)) {
      throw new Error('SSH 地址不支持 Token 认证，请改用 HTTPS 地址（如 https://github.com/user/repo.git）');
    }
    if (!fs.existsSync(input.localDir)) {
      fs.mkdirSync(input.localDir, { recursive: true });
    }
    const prev = input.id ? store.getProject(input.id) : null;
    if (input.auth) {
      // 归一化三态认证、兼容旧配置、沿用已保存 token；不合法时给出可读提示
      input.auth = cred.normalizeProjectAuth(input.auth, prev && prev.auth);
    }
    if (prev) {
      if (input.proxy && !input.proxy.pass && prev.proxy.pass) {
        input.proxy = { ...input.proxy, pass: prev.proxy.pass };
      }
    }
    const saved = store.upsertProject(input);
    rebuildEngines();
    const engine = engines.get(saved.id);
    if (engine) {
      engine.inspect({ silent: false });
      // 新建项目或更换了本地目录时立即跑一次完整同步（克隆 / 关联远端），
      // 否则要等一个自动同步周期用户才看得到结果
      const dirChanged = prev && prev.localDir !== saved.localDir;
      if (!prev || dirChanged) {
        engine.syncNow({ manual: true }).catch(() => {});
      }
      // 规则重写排在初始化之后：_applyExcludeRules 对未初始化的目录会自动跳过，
      // 不会提前造出只有 info/exclude 的 .git 空壳
      engine.refreshRules();
    }
    return publicConfig();
  }));

  ipcMain.handle('project:delete', guard(async (id) => {
    const engine = engines.get(id);
    if (engine && engine.state.busy) throw new Error('该项目正在同步，请稍后再删除');
    store.removeProject(id);
    rebuildEngines();
    return publicConfig();
  }));

  ipcMain.handle('project:test', guard(async (input) => {
    const url = input.remoteUrl;
    if (!url) throw new Error('请先填写 Git 地址');
    // 按弹窗当前选择的认证方式解析凭据，避免「看起来测的是 A，实际用的是 B」
    const prev = input.id ? store.getProject(input.id) : null;
    const auth = cred.resolveTestAuth(
      { ...(input.auth || {}), remoteUrl: url },
      prev && prev.auth,
      store.globals
    );
    const res = await git.runGitNet(['ls-remote', '--heads', url], {
      cwd: os.tmpdir(),
      auth,
      proxy: resolveProxyFor(input),
      remoteUrl: url,
      gitPath: activeGit.path,
      gitEnv: activeGit.env,
      timeout: 45000,
    });
    if (res.code !== 0) {
      throw new Error(git.explainGitError(res.stderr) || '连接失败');
    }
    const branches = (res.stdout || '')
      .split('\n')
      .map((l) => l.replace(/^.*refs\/heads\//, '').trim())
      .filter(Boolean);
    return { branches };
  }));

  ipcMain.handle('project:sync', guard(async (id) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    return engine.syncNow({ manual: true });
  }));

  ipcMain.handle('project:inspect', guard(async (id) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    return engine.inspect({ silent: false });
  }));

  ipcMain.handle('project:commit-push', guard(async ({ id, message }) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    return engine.commitAndPush(message);
  }));

  ipcMain.handle('project:push', guard(async (id) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    return engine.pushNow({ manual: true });
  }));

  ipcMain.handle('project:discard', guard(async (id) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    return engine.discardTracked();
  }));

  /**
   * 本地文件决策：
   *   accept   — 确认把新文件上传（git add）
   *   ignore   — 加入正则/glob 忽略规则
   *   untrack  — git rm --cached 停止追踪（本地文件保留），并自动加规则防止又变回待确认
   *   add-rule / remove-rule — 单独增删正则规则
   */
  ipcMain.handle('project:file-decision', guard(async ({ id, action, files, rule, caseSensitive }) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    const p = store.getProject(id);
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    let snap = engine.snapshot();

    if (action === 'accept') {
      if (!list.length) throw new Error('没有选择文件');
      snap = await engine.acceptNew(list);
    } else if (action === 'untrack') {
      if (!list.length) throw new Error('没有选择文件');
      snap = await engine.untrackFiles(list);
      // 停止追踪后文件会变成未跟踪，加精确规则防止它又出现在待确认列表
      const exact = list.map((f) => `^${ignoreRules.escapeRegex(String(f).replace(/\\/g, '/'))}$`);
      p.ignoreRegex = [...new Set([...(p.ignoreRegex || []), ...exact])];
    } else if (action === 'ignore' || action === 'add-rule') {
      const r = String(rule || '').trim();
      if (!r) throw new Error('规则不能为空');
      if (caseSensitive !== undefined) p.sync.regexCaseSensitive = !!caseSensitive;
      // add-rule 来自正则工具，一律按正则校验；简单 glob 形式的规则放进 exclude
      if (action === 'add-rule' || /[\\^$()[\]{}|+?]/.test(r)) {
        ignoreRules.compileRegex(r, ignoreRules.regexOptions(p));
        p.ignoreRegex = [...new Set([...(p.ignoreRegex || []), r])];
      } else {
        p.exclude = [...new Set([...(p.exclude || []), r])];
      }
    } else if (action === 'remove-rule') {
      const r = String(rule || '');
      const before = (p.ignoreRegex || []).length + (p.exclude || []).length;
      p.ignoreRegex = (p.ignoreRegex || []).filter((x) => x !== r);
      p.exclude = (p.exclude || []).filter((x) => x !== r);
      if ((p.ignoreRegex || []).length + (p.exclude || []).length === before) {
        throw new Error('规则不存在');
      }
    } else {
      throw new Error('未知操作：' + action);
    }

    store.save();
    rebuildEngines();
    await engines.get(id).refreshRules();
    snap = await engines.get(id).inspect({ silent: true });
    return { config: publicConfig(), snapshot: snap };
  }));

  ipcMain.handle('project:resolve', guard(async ({ id, file, strategy }) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    return engine.resolveFile(file, strategy);
  }));

  ipcMain.handle('project:finish-merge', guard(async ({ id, push }) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    return engine.finishMerge({ push });
  }));

  ipcMain.handle('project:abort-merge', guard(async (id) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    return engine.abortMerge();
  }));

  ipcMain.handle('project:open-file', guard(async ({ id, file }) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    const abs = engine.absPath(file);
    if (!fs.existsSync(abs)) throw new Error('文件不存在');
    const err = await shell.openPath(abs);
    if (err) throw new Error(err);
    return true;
  }));

  ipcMain.handle('project:show-file', guard(async ({ id, file }) => {
    const engine = engines.get(id);
    if (!engine) throw new Error('项目不存在');
    shell.showItemInFolder(engine.absPath(file));
    return true;
  }));

  ipcMain.handle('sync:all', guard(async () => {
    await scheduler.syncAll();
    return true;
  }));

  ipcMain.handle('logs:recent', guard(async (limit) => logger.recent(limit || 300)));
}

function maskToken(t) {
  return `${'\u2022'.repeat(Math.min(12, Math.max(4, t.length - 4)))}${t.slice(-4)}`;
}

/**
 * 计算项目真正生效的认证信息。
 * custom → 项目自己的 token；global / 未填 → 设置里的全局默认；none → 不带认证。
 */
function resolveAuth(project) {
  return cred.effectiveAuth(project, store.globals);
}

function resolveProxyFor(project) {
  const g = store.globals;
  const p = project.proxy || {};
  if (p.mode === 'none') return null;
  if (p.mode === 'custom' && p.url) return { mode: 'custom', url: p.url, user: p.user, pass: p.pass };
  if (g.proxyMode === 'custom' && g.proxyUrl) {
    return { mode: 'custom', url: g.proxyUrl, user: g.proxyUser, pass: g.proxyPass };
  }
  return null;
}

/** 提供给渲染进程的配置（未加密，token 用占位符代替真实值） */
function publicConfig() {
  const g = store.globals;
  const ga = g.auth || {};
  const globalsPublic = {
    ...g,
    gitPath: g.gitPath === 'git' ? '' : g.gitPath,
    // 绝不把明文凭据送进渲染进程
    auth: {
      username: ga.username || '',
      hasToken: !!ga.token,
      tokenPreview: ga.token ? maskToken(ga.token) : '',
    },
    credentials: (g.credentials || []).map((c) => ({
      id: c.id,
      name: c.name || '未命名凭据',
      host: c.host || '',
      username: c.username || '',
      hasToken: !!c.token,
      tokenPreview: c.token ? maskToken(c.token) : '',
    })),
    hasProxyPass: !!g.proxyPass,
  };
  delete globalsPublic.proxyPass;
  delete globalsPublic.proxyPassEnc;
  return {
    deviceName: store.data.deviceName,
    globals: globalsPublic,
    projects: store.listProjects().map(serializeProject),
  };
}

function serializeProject(p) {
  const hasToken = !!(p.auth && p.auth.token);
  // 旧配置里的 'token' 归一化成新的四态
  let mode = (p.auth && p.auth.mode) || 'global';
  if (mode === 'token') mode = hasToken ? 'custom' : 'global';
  if (!cred.MODES.includes(mode)) mode = 'global';
  const gToken = !!((store.globals && store.globals.auth) || {}).token;
  return {
    id: p.id,
    name: p.name,
    localDir: p.localDir,
    remoteUrl: p.remoteUrl,
    branch: p.branch,
    enabled: p.enabled,
    auth: {
      mode,
      credentialId: p.auth.credentialId || '',
      username: p.auth.username || '',
      hasToken,
      tokenPreview: hasToken ? maskToken(p.auth.token) : '',
      usesGlobal: mode === 'global' && (gToken || (store.globals.credentials || []).length > 0),
      credentialName: cred.credentialLabel(p, store.globals),
    },
    proxy: { mode: p.proxy.mode, url: p.proxy.url, user: p.proxy.user, hasPass: !!p.proxy.pass },
    sync: p.sync,
    exclude: p.exclude,
    ignoreRegex: p.ignoreRegex || [],
    createdAt: p.createdAt,
    lastSyncAt: p.lastSyncAt,
  };
}

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  initServices();
  registerIpc();
  rebuildEngines();
  createWindow();
  createTray();
  scheduler.start();

  // 首次启动后异步补齐状态
  setTimeout(() => {
    for (const [, engine] of engines) {
      if (engine.project.enabled) engine.inspect({ silent: true });
    }
  }, 800);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('window-all-closed', () => {
  if (!store || !store.globals.closeToTray) {
    app.isQuitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (scheduler) scheduler.stop();
});
