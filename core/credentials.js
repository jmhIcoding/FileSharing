'use strict';
/**
 * 凭据解析（纯函数，不依赖 Electron，便于自测）。
 *
 * 「设置 → Git 凭据库」可以保存任意多条 Token，每条带名称与适用域名：
 *   { id, name, host, username, token }
 * 全局另有 defaultCredentialId 与 autoMatchCredential 开关。
 *
 * 项目认证四态（project.auth.mode）：
 *   global     — 自动按仓库域名匹配凭据库；匹配不到就用默认凭据（新目录默认）
 *   credential — 明确指定凭据库里的某一条
 *   custom     — 本目录自己的 Token，覆盖凭据库
 *   none       — 公开仓库，不带任何认证
 *
 * 兼容旧配置：mode:'token' 等价 custom；只有凭据库为空时才回落到
 * 老字段 globals.auth.token / project.auth.token。
 */

const MODES = ['global', 'credential', 'custom', 'none'];

function normalizeMode(mode, hasToken) {
  if (mode === 'token') return hasToken ? 'custom' : 'global';
  return MODES.includes(mode) ? mode : 'global';
}

/** 从任意 HTTPS / SSH 仓库地址里取主机名 */
function hostOf(url) {
  if (!url) return '';
  const s = String(url).trim();
  try {
    return new URL(s).hostname.toLowerCase();
  } catch (_) {
    const m = s.match(/^[^@/]+@([^:/]+):/); // git@host:path
    return m ? m[1].toLowerCase() : '';
  }
}

/** 规则可以是 github.com / git.corp.com，支持子域名匹配 */
function hostMatches(rule, host) {
  const r = String(rule || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  const h = String(host || '').toLowerCase();
  if (!r || !h) return false;
  return h === r || h.endsWith(`.${r}`);
}

function findCredential(credentials, id) {
  if (!id) return null;
  const c = (credentials || []).find((x) => x && x.id === id);
  return c && c.token ? c : null;
}

/**
 * 为项目挑一条凭据。返回凭据对象或 null。
 * 明确指定（credential）时找不到就返回 null，绝不偷偷换用别的账号。
 */
function pickCredential(project, globals) {
  const g = globals || {};
  const creds = g.credentials || [];
  const a = (project && project.auth) || {};
  const mode = normalizeMode(a.mode, !!a.token);

  if (mode === 'none') return null;
  if (mode === 'custom') {
    if (!a.token) return null;
    return { id: '', name: '本目录专属 Token', username: a.username || '', token: a.token };
  }
  if (mode === 'credential') {
    return findCredential(creds, a.credentialId);
  }

  // global：优先按仓库域名自动匹配
  if (g.autoMatchCredential !== false) {
    const host = hostOf(project && project.remoteUrl);
    if (host) {
      const hit = creds.find((c) => c && c.token && c.host && hostMatches(c.host, host));
      if (hit) return hit;
    }
  }
  const def = findCredential(creds, g.defaultCredentialId);
  if (def) return def;

  // 旧配置兜底：凭据库还没建起来时才读老字段
  if (!creds.length && g.auth && g.auth.token) {
    return { id: '', name: '默认凭据', username: g.auth.username || '', token: g.auth.token };
  }
  if (!creds.length && a.token) {
    return { id: '', name: '旧配置 Token', username: a.username || '', token: a.token };
  }
  return null;
}

/** 引擎 / 主进程实际生效的凭据 */
function effectiveAuth(project, globals) {
  const c = pickCredential(project, globals);
  if (!c || !c.token) return { mode: 'none' };
  return { mode: 'token', username: c.username || '', token: c.token };
}

/** 给界面用的可读名称（不含任何明文） */
function credentialLabel(project, globals) {
  const a = (project && project.auth) || {};
  if (normalizeMode(a.mode, !!a.token) === 'none') return '无认证（公开仓库）';
  const c = pickCredential(project, globals);
  return c ? (c.name || '未命名凭据') : '未匹配到凭据';
}

/**
 * 处理「设置」页提交。
 * 密码框留空 = 不修改；只有显式 clearToken 才真正清空老字段。
 * 凭据库按 id 合并：编辑时 token 留空表示沿用已保存的那条。
 * 返回值可直接交给 store.updateGlobals()。
 */
function applyGlobalsPatch(globals, incoming) {
  const patch = { ...(incoming || {}) };
  const clearToken = !!patch.clearToken;
  const explicitAuthToken = !!(incoming && incoming.auth && incoming.auth.token);
  delete patch.clearToken;
  delete patch.applyCredentialToAll; // 由独立 IPC 处理

  // 老字段：兼容旧版界面 / 旧配置
  const prevAuth = (globals && globals.auth) || {};
  patch.auth = { ...prevAuth, ...(patch.auth || {}) };
  if (clearToken) patch.auth.token = '';
  else if (!patch.auth.token && prevAuth.token) patch.auth.token = prevAuth.token;

  if (Array.isArray(patch.credentials)) {
    const prev = (globals && globals.credentials) || [];
    patch.credentials = patch.credentials.map((c) => {
      const old = prev.find((x) => x && x.id === c.id) || {};
      return {
        id: c.id,
        name: c.name || old.name || '未命名凭据',
        host: c.host !== undefined ? c.host : (old.host || ''),
        username: c.username !== undefined ? c.username : (old.username || ''),
        token: c.token || old.token || '',
        createdAt: old.createdAt || c.createdAt || new Date().toISOString(),
      };
    }).filter((c) => !!c.token); // 没有 Token 的条目不入库
    // 凭据库由新界面接管后，旧的单个 Token 不再参与解析（避免"删了还在用"）
    if (!explicitAuthToken && !clearToken) patch.auth.token = '';
  }
  return patch;
}

/** 一键把某条凭据应用到所有监控目录（原地修改项目对象，由调用方负责落盘） */
function applyCredentialToProjects(projects, credentials, credentialId) {
  const c = findCredential(credentials, credentialId);
  if (!c) throw new Error('凭据不存在，请先在「设置 → Git 凭据库」里添加');
  let count = 0;
  for (const p of projects || []) {
    p.auth = { ...(p.auth || {}), mode: 'credential', credentialId };
    count += 1;
  }
  return count;
}

/** 默认凭据被删掉时把指针清空，避免指向不存在的条目 */
function normalizeGlobals(globals) {
  const g = globals || {};
  g.credentials = Array.isArray(g.credentials) ? g.credentials : [];
  if (g.defaultCredentialId && !g.credentials.some((c) => c && c.id === g.defaultCredentialId)) {
    g.defaultCredentialId = '';
  }
  if (typeof g.autoMatchCredential !== 'boolean') g.autoMatchCredential = true;
  return g;
}

/**
 * 处理项目保存：归一化认证方式、兼容旧配置、沿用已保存的 token。
 * 输入不合法时抛错，由 IPC 层转成界面提示。
 */
function normalizeProjectAuth(inputAuth, prevAuth) {
  if (!inputAuth) return undefined;
  const a = { ...inputAuth };
  const clear = !!a.clearToken;
  delete a.clearToken;
  delete a.remoteUrl;
  a.mode = normalizeMode(a.mode, !!a.token);
  const prevToken = (prevAuth && prevAuth.token) || '';
  if (clear) {
    a.token = '';
    if (a.mode === 'custom') {
      throw new Error('已清除本目录 Token，请把「认证方式」改成「自动匹配 / 使用全局 Token」或「公开仓库」');
    }
  } else if (!a.token && prevToken) {
    // 编辑时密码框留空 = 不修改；切到别的模式也保留，方便以后切回 custom
    a.token = prevToken;
  }
  if (a.mode === 'custom' && !a.token) {
    throw new Error('「为此目录单独设置」需要填写 Token，或改选「使用全局 Token」');
  }
  if (a.mode === 'credential' && !a.credentialId) {
    throw new Error('请选择一条已保存的凭据');
  }
  return a;
}

/**
 * 「测试连接」按弹窗当前选择的认证方式解析凭据。
 * globals 为完整 store.globals（含 credentials / defaultCredentialId / autoMatchCredential）。
 */
function resolveTestAuth(inputAuth, prevAuth, globals) {
  const incoming = { ...(inputAuth || {}) };
  const mode = normalizeMode(incoming.mode || 'global', !!incoming.token);
  if (mode === 'none') return { mode: 'none' };
  if (mode === 'custom') {
    const token = incoming.token || (prevAuth && prevAuth.token) || '';
    if (!token) {
      throw new Error('请填写本目录专用的 Token，或把「认证方式」改成「使用全局 Token」');
    }
    return {
      mode: 'token',
      username: incoming.username || (prevAuth && prevAuth.username) || '',
      token,
    };
  }
  const project = {
    auth: { mode, credentialId: incoming.credentialId || (prevAuth && prevAuth.credentialId) || '' },
    remoteUrl: incoming.remoteUrl || '',
  };
  if (mode === 'credential' && !findCredential((globals || {}).credentials, project.auth.credentialId)) {
    throw new Error('这条凭据已不存在，请到「设置 → Git 凭据库」重新选择');
  }
  const c = pickCredential(project, globals);
  return c
    ? { mode: 'token', username: c.username || '', token: c.token }
    : { mode: 'none' };
}

module.exports = {
  MODES,
  normalizeMode,
  hostOf,
  hostMatches,
  findCredential,
  pickCredential,
  effectiveAuth,
  credentialLabel,
  applyGlobalsPatch,
  applyCredentialToProjects,
  normalizeGlobals,
  normalizeProjectAuth,
  resolveTestAuth,
};
