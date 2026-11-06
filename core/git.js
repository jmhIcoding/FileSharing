'use strict';

const { spawn } = require('child_process');
const { URL } = require('url');

/**
 * Git 命令执行封装。
 * - 统一注入 Windows 友好配置（长路径、不转义中文路径）
 * - 统一注入代理配置
 * - 统一注入 token 认证（不写入 .git/config，避免凭据泄漏到仓库）
 */

/** 默认超时：本地命令较快，网络命令更宽松 */
const TIMEOUT_LOCAL = 60_000;
const TIMEOUT_NETWORK = 180_000;

class GitError extends Error {
  constructor(message, { code, stdout, stderr, args } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stdout = stdout || '';
    this.stderr = stderr || '';
    this.args = args || [];
  }
}

/**
 * 从 git 地址推导 host。
 * 支持 https://host/a/b.git、ssh://git@host/a/b.git、git@host:a/b.git
 */
function parseHost(remoteUrl) {
  if (!remoteUrl) return '';
  const s = String(remoteUrl).trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      return new URL(s).hostname.toLowerCase();
    }
    const m = s.match(/^[^@]+@([^:/]+)[:/]/);
    if (m) return m[1].toLowerCase();
  } catch (_) { /* ignore */ }
  return '';
}

/** 是否为 SSH 形式地址（token 认证不适用于纯 SSH） */
function isSshUrl(remoteUrl) {
  if (!remoteUrl) return false;
  const s = String(remoteUrl).trim();
  if (/^ssh:\/\//i.test(s)) return true;
  return /^[^@/\s]+@[^:/\s]+:/.test(s);
}

/** 根据 host 推断 Basic 认证的用户名 */
function defaultAuthUser(host) {
  const h = (host || '').toLowerCase();
  if (h.includes('github')) return 'x-access-token';
  if (h.includes('gitlab')) return 'oauth2';
  if (h.includes('gitee')) return 'token';
  if (h.includes('coding.net')) return 'token';
  if (h.includes('azure.com') || h.includes('visualstudio.com')) return 'pat';
  if (h.includes('bitbucket')) return 'x-token-auth';
  return 'x-access-token';
}

/**
 * 生成认证相关的 git 参数。
 * 使用 http.extraHeader 传递 Basic 认证，避免 token 落到 .git/config 里。
 */
function buildAuthArgs(auth, remoteUrl) {
  if (!auth || auth.mode !== 'token' || !auth.token) return [];
  const host = parseHost(remoteUrl);
  const user = (auth.username && auth.username.trim()) || defaultAuthUser(host);
  const raw = `${user}:${auth.token}`;
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  return [
    '-c', 'credential.helper=',
    '-c', 'credential.interactive=false',
    '-c', `http.extraHeader=Authorization: Basic ${b64}`,
  ];
}

/**
 * 生成代理相关参数。
 * @param {{mode:string,url:string,user:string,pass:string}} proxy
 */
function buildProxyArgs(proxy) {
  if (!proxy || proxy.mode !== 'custom' || !proxy.url) return [];
  let raw = String(proxy.url).trim();
  if (proxy.user) {
    try {
      const u = new URL(raw);
      u.username = encodeURIComponent(proxy.user);
      u.password = encodeURIComponent(proxy.pass || '');
      raw = u.toString();
    } catch (_) { /* 用户可能填了 host:port，交给 git 处理 */ }
  }
  return [
    '-c', `http.proxy=${raw}`,
    '-c', `https.proxy=${raw}`,
  ];
}

/** 全局基础配置，避免交互式提示、路径转义等问题 */
const BASE_CONFIG = [
  '-c', 'core.quotepath=false',
  '-c', 'core.longpaths=true',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'advice.detachedHead=false',
  '-c', 'gc.auto=0',
];

/**
 * 执行 git 命令。
 * @param {string[]} args
 * @param {object} opts
 * @param {string} opts.cwd 工作目录
 * @param {object} [opts.auth] 认证配置 {mode, username, token}
 * @param {object} [opts.proxy] 代理配置 {mode, url, user, pass}
 * @param {string} [opts.remoteUrl] 用于推断 host
 * @param {number} [opts.timeout]
 * @param {boolean} [opts.allowFail] 非 0 退出码不抛错
 */
function runGit(args, opts = {}) {
  const {
    cwd,
    auth,
    proxy,
    remoteUrl,
    timeout = TIMEOUT_LOCAL,
    allowFail = false,
    gitPath = 'git',
    env: extraEnv,
    gitEnv,
  } = opts;

  const fullArgs = [
    ...BASE_CONFIG,
    ...buildProxyArgs(proxy),
    ...buildAuthArgs(auth, remoteUrl || ''),
    ...args,
  ];

  const env = {
    ...process.env,
    // 内置 Git 运行时需要显式指定 exec-path / 模板 / CA 证书
    ...(gitEnv || {}),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C.UTF-8',
    LANG: 'C.UTF-8',
    ...extraEnv,
  };
  // 清掉可能触发交互弹窗的凭证助手配置
  delete env.GIT_ASKPASS;
  delete env.GIT_CONFIG_NOSYSTEM;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(gitPath, fullArgs, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      resolve({
        code: -1,
        stdout: '',
        stderr: `无法启动 git：${err.message}`,
        args: fullArgs,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      resolve({
        code: -2,
        stdout,
        stderr: `${stderr}\n命令执行超时（${Math.round(timeout / 1000)}s）：git ${args[0]}`,
        args: fullArgs,
        timedOut: true,
      });
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: `git 进程错误：${err.message}`,
        args: fullArgs,
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code: code === null ? -1 : code, stdout, stderr, args: fullArgs };

      if (!allowFail && result.code !== 0) {
        const msg = (stderr || stdout || '').trim() || `git ${args[0]} 退出码 ${result.code}`;
        const err = new GitError(msg, result);
        err.result = result;
        // 不 reject，改为标记，调用方用 unwrap() 取错误
        resolve({ ...result, error: err });
        return;
      }
      resolve(result);
    });
  });
}

/** 需要网络的操作使用更长超时 */
function runGitNet(args, opts = {}) {
  return runGit(args, { timeout: TIMEOUT_NETWORK, ...opts });
}

/** 检查 git 是否可用 */
async function checkGit(gitPath = 'git', gitEnv) {
  const r = await runGit(['--version'], { gitPath, gitEnv, timeout: 10_000, allowFail: true });
  if (r.code !== 0) {
    return { ok: false, version: '', message: (r.stderr || '').trim() || '未找到 git' };
  }
  return { ok: true, version: (r.stdout || '').trim(), message: '' };
}

/** 安全地把远程地址转成可展示形式（去掉内嵌凭据） */
function sanitizeUrl(remoteUrl) {
  if (!remoteUrl) return '';
  try {
    return String(remoteUrl).replace(/\/\/[^/@]+@/, '//***@');
  } catch (_) {
    return remoteUrl;
  }
}

/** 把 stderr 转成给用户看的简短原因 */
function explainGitError(stderr) {
  const s = String(stderr || '');
  if (/Authentication failed|Invalid username or password|Bad credentials|could not read Username|could not read Password|unable to get password|terminal prompts disabled|401|403/i.test(s)) {
    return '认证失败：Token 无效、已过期或权限不足。请到「设置 → Git 凭据库」检查该条凭据，必要时重新生成 Token（需 Contents 读写权限）';
  }
  if (/Repository not found|not found|404/i.test(s)) {
    return '仓库不存在或无权访问：请检查地址与 Token 权限';
  }
  if (/Could not resolve host|Failed to connect|Connection timed out|Couldn't connect/i.test(s)) {
    return '网络不可达：请检查代理设置（GitHub 通常需要代理）';
  }
  if (/Permission denied \(publickey\)/i.test(s)) {
    return 'SSH 认证失败：Token 模式请改用 HTTPS 地址';
  }
  if (/non-fast-forward|rejected/i.test(s)) {
    return '推送被拒绝：远端有新提交，需先同步合并';
  }
  if (/unrelated histories/i.test(s)) {
    return '本地与远端历史无关：需要允许合并无关历史';
  }
  if (/would be overwritten|Please commit your changes|local changes/i.test(s)) {
    return '本地存在未提交改动，会与远端更新冲突，请先处理本地改动';
  }
  if (/index\.lock|Another git process/i.test(s)) {
    return '仓库被其他 git 进程占用，请稍后重试';
  }
  const firstLine = s.split('\n').map((x) => x.trim()).filter(Boolean).slice(-1)[0] || s;
  return firstLine.slice(0, 400);
}

module.exports = {
  runGit,
  runGitNet,
  checkGit,
  buildAuthArgs,
  buildProxyArgs,
  parseHost,
  isSshUrl,
  defaultAuthUser,
  sanitizeUrl,
  explainGitError,
  GitError,
  TIMEOUT_LOCAL,
  TIMEOUT_NETWORK,
};
