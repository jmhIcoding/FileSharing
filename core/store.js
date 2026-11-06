'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeGlobals } = require('./credentials');

const CONFIG_VERSION = 1;
const LEGACY_CREDENTIAL_ID = 'legacy-default-credential';

/** 默认全量配置 */
function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    deviceId: crypto.randomUUID(),
    deviceName: '',
    globals: {
      // none | system | custom
      proxyMode: 'none',
      proxyUrl: '',
      proxyUser: '',
      proxyPass: '',
      startAtLogin: false,
      startMinimized: false,
      closeToTray: true,
      scanIntervalSec: 4,
      gitPath: '',   // 空 = 自动选择（优先内置 Git）
      logLevel: 'info',
      theme: 'light',
      // 旧版单 Token 字段（保留兼容；新界面统一用 credentials）
      auth: { username: '', token: '' },
      // 凭据库：可保存任意多条 Token，按名称 / 适用域名区分
      credentials: [],
      defaultCredentialId: '',
      autoMatchCredential: true,
    },
    projects: [],
  };
}

/** 单个项目的默认值 */
function defaultProject() {
  return {
    id: crypto.randomUUID(),
    name: '',
    localDir: '',
    remoteUrl: '',
    branch: 'main',
    enabled: true,
    // global = 自动按域名匹配凭据库；credential = 指定某条；custom = 本目录专属；none = 公开仓库
    auth: { mode: 'global', credentialId: '', username: '', token: '' },
    proxy: { mode: 'inherit', url: '', user: '', pass: '' },
    sync: {
      intervalSec: 60,
      pushMode: 'confirm',      // confirm | auto
      autoCommit: false,         // 本地改动是否自动提交（不推送）
      allowUnrelatedMerge: false,
      watchFiles: true,
      builtinIgnore: true,       // 默认忽略 Office/WPS 临时文件，可在「忽略规则」里关闭
      newFilePolicy: 'ask',          // 本地「新增」文件：ask = 需确认才上传；auto = 自动纳入
      trackedChangePolicy: 'auto',   // 「已跟踪」文件的改动：auto = 自动提交并推送；confirm = 等我点按钮
      regexCaseSensitive: false,     // 正则忽略规则是否区分大小写
    },
    exclude: [],
    ignoreRegex: [],             // 正则忽略规则（对相对路径与文件名都匹配）
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
  };
}

const SECRET_FIELDS = [
  (p) => p.auth && p.auth.token ? (v) => { p.auth.token = v; } : null,
];

/**
 * 配置存储。
 * token 通过外部注入的 encrypt/decrypt（Electron safeStorage）加密后落盘，
 * 内存中始终是明文，避免各处解密。
 */
class Store {
  constructor(filePath, cryptoAdapter = {}) {
    this.filePath = filePath;
    this.encrypt = cryptoAdapter.encrypt || ((s) => Buffer.from(s, 'utf8').toString('base64'));
    this.decrypt = cryptoAdapter.decrypt || ((s) => Buffer.from(s, 'base64').toString('utf8'));
    this.secure = !!cryptoAdapter.secure;
    this.data = defaultConfig();
  }

  load() {
    let raw = null;
    try {
      if (fs.existsSync(this.filePath)) {
        raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (err) {
      // 配置损坏时备份并重建，不让应用起不来
      try {
        fs.copyFileSync(this.filePath, `${this.filePath}.broken-${Date.now()}`);
      } catch (_) { /* ignore */ }
      raw = null;
    }

    const base = defaultConfig();
    const data = { ...base, ...(raw || {}) };
    data.globals = { ...base.globals, ...(data.globals || {}) };
    // 全局凭据：兼容明文旧配置与加密后的 tokenEnc
    data.globals.auth = { ...base.globals.auth, ...(data.globals.auth || {}) };
    if (data.globals.auth.tokenEnc && !data.globals.auth.token) {
      try { data.globals.auth.token = this.decrypt(data.globals.auth.tokenEnc); }
      catch (_) { data.globals.auth.token = ''; }
    }
    delete data.globals.auth.tokenEnc;
    if (data.globals.proxyPassEnc && !data.globals.proxyPass) {
      try { data.globals.proxyPass = this.decrypt(data.globals.proxyPassEnc); }
      catch (_) { data.globals.proxyPass = ''; }
    }
    delete data.globals.proxyPassEnc;

    // 凭据库：逐条解密 tokenEnc
    data.globals.credentials = (Array.isArray(data.globals.credentials) ? data.globals.credentials : [])
      .map((c) => {
        const item = { ...c };
        if (item.tokenEnc && !item.token) {
          try { item.token = this.decrypt(item.tokenEnc); }
          catch (_) { item.token = ''; }
        }
        delete item.tokenEnc;
        return item;
      })
      .filter((c) => c && c.id && c.token);

    // 旧版单 Token 无缝升级成凭据库第一条（保留旧字段，兼容老项目）
    if (!data.globals.credentials.length && data.globals.auth && data.globals.auth.token) {
      data.globals.credentials = [{
        id: LEGACY_CREDENTIAL_ID,
        name: '默认凭据',
        host: '',
        username: data.globals.auth.username || '',
        token: data.globals.auth.token,
        createdAt: new Date().toISOString(),
      }];
      data.globals.defaultCredentialId = LEGACY_CREDENTIAL_ID;
    }
    normalizeGlobals(data.globals);

    data.projects = Array.isArray(data.projects) ? data.projects : [];
    data.projects = data.projects.map((p) => this._hydrateProject(p));
    this.data = data;
    return this.data;
  }

  _hydrateProject(p) {
    const d = defaultProject();
    const merged = { ...d, ...p };
    merged.auth = { ...d.auth, ...(p.auth || {}) };
    merged.proxy = { ...d.proxy, ...(p.proxy || {}) };
    merged.sync = { ...d.sync, ...(p.sync || {}) };
    merged.exclude = Array.isArray(p.exclude) ? p.exclude : [];
    merged.ignoreRegex = Array.isArray(p.ignoreRegex) ? p.ignoreRegex : [];

    if (p.auth && p.auth.tokenEnc && !merged.auth.token) {
      try {
        merged.auth.token = this.decrypt(p.auth.tokenEnc);
      } catch (_) {
        merged.auth.token = '';
      }
    }
    delete merged.auth.tokenEnc;
    // 旧配置的 mode:'token' 归一化成新的四态之一
    if (merged.auth.mode === 'token') {
      merged.auth.mode = merged.auth.token ? 'custom' : 'global';
    }
    if (!['global', 'credential', 'custom', 'none'].includes(merged.auth.mode)) {
      merged.auth.mode = 'global';
    }
    merged.auth.credentialId = merged.auth.credentialId || '';
    if (p.proxy && p.proxy.passEnc && !merged.proxy.pass) {
      try { merged.proxy.pass = this.decrypt(p.proxy.passEnc); }
      catch (_) { merged.proxy.pass = ''; }
    }
    delete merged.proxy.passEnc;
    return merged;
  }

  _serialize() {
    const out = JSON.parse(JSON.stringify(this.data));
    // 全局凭据与代理密码同样加密后落盘
    const g = out.globals || {};
    if (g.auth && g.auth.token) {
      try { g.auth.tokenEnc = this.encrypt(g.auth.token); } catch (_) { g.auth.tokenEnc = ''; }
      g.auth.token = '';
    }
    if (g.proxyPass) {
      try { g.proxyPassEnc = this.encrypt(g.proxyPass); } catch (_) { g.proxyPassEnc = ''; }
      g.proxyPass = '';
    }
    if (Array.isArray(g.credentials)) {
      g.credentials = g.credentials.map((c) => {
        const item = { ...c };
        if (item.token) {
          try { item.tokenEnc = this.encrypt(item.token); } catch (_) { item.tokenEnc = ''; }
          item.token = '';
        }
        return item;
      });
    }
    out.projects = out.projects.map((p) => {
      const copy = JSON.parse(JSON.stringify(p));
      if (copy.auth && copy.auth.token) {
        try {
          copy.auth.tokenEnc = this.encrypt(copy.auth.token);
        } catch (_) {
          copy.auth.tokenEnc = '';
        }
        copy.auth.token = '';
      }
      if (copy.proxy && copy.proxy.pass) {
        try {
          copy.proxy.passEnc = this.encrypt(copy.proxy.pass);
        } catch (_) {
          copy.proxy.passEnc = '';
        }
        copy.proxy.pass = '';
      }
      return copy;
    });
    return out;
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._serialize(), null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  get globals() { return this.data.globals; }

  updateGlobals(patch) {
    const next = { ...this.data.globals, ...patch };
    if (patch && patch.auth) {
      next.auth = { ...(this.data.globals.auth || {}), ...patch.auth };
    }
    this.data.globals = normalizeGlobals(next);
    this.save();
    return this.data.globals;
  }

  listProjects() { return this.data.projects; }

  getProject(id) {
    return this.data.projects.find((p) => p.id === id) || null;
  }

  /** 新增或更新项目，返回最新项目对象 */
  upsertProject(input) {
    const existing = input.id ? this.getProject(input.id) : null;
    let project;
    if (existing) {
      project = {
        ...existing,
        ...input,
        auth: { ...existing.auth, ...(input.auth || {}) },
        proxy: { ...existing.proxy, ...(input.proxy || {}) },
        sync: { ...existing.sync, ...(input.sync || {}) },
        exclude: input.exclude !== undefined ? input.exclude : existing.exclude,
      };
      const idx = this.data.projects.findIndex((p) => p.id === project.id);
      this.data.projects[idx] = project;
    } else {
      const d = defaultProject();
      project = {
        ...d,
        ...input,
        id: d.id,
        auth: { ...d.auth, ...(input.auth || {}) },
        proxy: { ...d.proxy, ...(input.proxy || {}) },
        sync: { ...d.sync, ...(input.sync || {}) },
      };
      this.data.projects.push(project);
    }
    this.save();
    return project;
  }

  removeProject(id) {
    const idx = this.data.projects.findIndex((p) => p.id === id);
    if (idx >= 0) {
      this.data.projects.splice(idx, 1);
      this.save();
      return true;
    }
    return false;
  }

  touchProject(id, patch) {
    const p = this.getProject(id);
    if (!p) return null;
    Object.assign(p, patch);
    this.save();
    return p;
  }
}

module.exports = { Store, defaultConfig, defaultProject, CONFIG_VERSION };
