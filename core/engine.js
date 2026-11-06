'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const git = require('./git');
const cred = require('./credentials');
const ignore = require('./ignore');

const UNMERGED_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** 解析 `git status --porcelain=v1 -z` 输出 */
function parsePorcelainZ(out) {
  const items = [];
  if (!out) return items;
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const p = entry.slice(3);
    const item = { index: x, worktree: y, path: p };
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      // rename/copy 的 -z 输出后面还跟一个原路径
      i += 1;
    }
    items.push(item);
  }
  return items;
}

/** 把 status 项映射成人类可读标签 */
function describeChange(item) {
  const code = item.index + item.worktree;
  if (UNMERGED_CODES.has(code)) return '冲突';
  if (code.includes('R')) return '重命名';
  if (code.includes('C')) return '复制';
  if (code.includes('A')) return '新增';
  if (code.includes('D')) return '删除';
  if (code === '??') return '未跟踪';
  if (code.includes('M')) return '修改';
  return '变更';
}

/** 判断目录是否为空（忽略 .git） */
function isEmptyDir(dir) {
  try {
    const names = fs.readdirSync(dir).filter((n) => n !== '.git');
    return names.length === 0;
  } catch (_) {
    return true;
  }
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

/**
 * 判断是否为真正可用的 Git 仓库。
 * 不能用「.git 目录存在」判断：写 .git/info/exclude 会提前建出一个只有
 * info/exclude、没有 HEAD 的空壳，此时 git status 仍会报 not a git repository。
 * 兼容 worktree / submodule 的 .git 文件（内容以 gitdir: 开头）。
 */
function isRealRepo(localDir) {
  const dot = path.join(localDir, '.git');
  try {
    const st = fs.statSync(dot);
    if (st.isFile()) return /^gitdir:/m.test(fs.readFileSync(dot, 'utf8'));
    return exists(path.join(dot, 'HEAD'));
  } catch (_) {
    return false;
  }
}

/** 早期版本留下的 .git 空壳是否可以直接清掉（没有 objects / refs 才算空壳） */
function isEmptyGitShell(localDir) {
  const dot = path.join(localDir, '.git');
  if (isRealRepo(localDir)) return false;
  try {
    if (!fs.statSync(dot).isDirectory()) return false;
    return !exists(path.join(dot, 'objects')) && !exists(path.join(dot, 'refs'));
  } catch (_) {
    return false;
  }
}

/** 从错误对象里取可读原因 */
function reasonOf(err) {
  if (!err) return '';
  const stderr = err.stderr || (err.result && err.result.stderr) || '';
  return git.explainGitError(stderr) || err.message || String(err);
}

class RepoEngine extends EventEmitter {
  constructor(project, deps) {
    super();
    this.project = project;
    this.logger = deps.logger;
    this.gitPath = deps.gitPath || 'git';
    this.gitEnv = deps.gitEnv || {};
    this.getGlobals = deps.getGlobals || (() => ({}));
    this.state = {
      projectId: project.id,
      phase: 'idle', // idle|checking|syncing|synced|dirty|ahead|behind|diverged|conflict|blocked|error|uninitialized
      branch: project.branch,
      head: '',
      remoteHead: '',
      ahead: 0,
      behind: 0,
      changes: [],
      pendingNew: [],          // 本地新增、等待用户确认是否上传的文件
      conflicts: [],
      inMerge: false,
      initialized: false,
      busy: false,
      lastCheckAt: null,
      lastSyncAt: project.lastSyncAt || null,
      lastError: '',
      lastMessage: '',
      progress: '',
      trackedTransient: [],   // 已被 git 跟踪的临时文件（gitignore 对它们无效）
    };
    this._chain = Promise.resolve();
    this._lastActivity = 0;
  }

  // ---------- 基础 ----------

  updateProject(project) {
    this.project = project;
    this.state.projectId = project.id;
    this.state.branch = project.branch;
    this._ident = undefined;
  }

  setGit({ path, env }) {
    this.gitPath = path || 'git';
    this.gitEnv = env || {};
    this._ident = undefined;
  }

  snapshot() {
    return {
      ...this.state,
      changes: this.state.changes.slice(0, 500),
      conflicts: this.state.conflicts.slice(),
    };
  }

  _set(patch) {
    Object.assign(this.state, patch);
    this.emit('update', this.snapshot());
  }

  _log(level, msg) {
    this.logger[level] ? this.logger[level](this.project.name || this.project.id, msg) : this.logger.info(this.project.name, msg);
  }

  /** 串行化所有 git 操作，避免并发写 index */
  _serial(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => {});
    return run;
  }

  _proxy() {
    const g = this.getGlobals() || {};
    const p = this.project.proxy || {};
    if (p.mode === 'none') return null;
    if (p.mode === 'custom' && p.url) {
      return { mode: 'custom', url: p.url, user: p.user, pass: p.pass };
    }
    // inherit
    if (g.proxyMode === 'custom' && g.proxyUrl) {
      return { mode: 'custom', url: g.proxyUrl, user: g.proxyUser, pass: g.proxyPass };
    }
    return null;
  }

  /**
   * 生效的凭据：
   * 项目 mode=custom → 用项目自己的 token
   * mode=global（默认）/ 项目没填 → 用设置里的全局默认 token
   * mode=none → 公开仓库，不带认证
   * 兼容旧配置：项目里直接存了 token 时优先沿用
   */
  _effectiveAuth() {
    // 传整个 project + globals：需要按 remoteUrl 的域名自动匹配凭据库
    return cred.effectiveAuth(this.project, this.getGlobals() || {});
  }

  _opts(extra = {}) {
    return {
      cwd: this.project.localDir,
      auth: this._effectiveAuth(),
      proxy: this._proxy(),
      remoteUrl: this.project.remoteUrl,
      gitPath: this.gitPath,
      gitEnv: this.gitEnv,
      ...extra,
    };
  }

  async _must(args, opts = {}) {
    const r = await git.runGit(args, this._opts(opts));
    if (r.error) throw r.error;
    return r;
  }

  async _try(args, opts = {}) {
    return git.runGit(args, this._opts({ allowFail: true, ...opts }));
  }

  async _mustNet(args, opts = {}) {
    const r = await git.runGitNet(args, this._opts(opts));
    if (r.error) throw r.error;
    return r;
  }

  // ---------- 仓库初始化 ----------

  isRepo() {
    return isRealRepo(this.project.localDir);
  }

  hasMergeInProgress() {
    return exists(path.join(this.project.localDir, '.git', 'MERGE_HEAD'));
  }

  /**
   * 确保本地存在可用仓库：
   * - 空目录 → clone
   * - 非空目录且无 .git → init + remote + fetch + reset --mixed（保留本地文件）
   * - 已有 .git → 校正 remote 地址、写入忽略规则
   */
  async ensureRepo() {
    const dir = this.project.localDir;
    if (!dir) throw new Error('未配置本地目录');

    if (!exists(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 自愈：早期版本可能在初始化前就写下 .git/info/exclude，留下一个没有 HEAD 的空壳。
    // 不清掉的话 git clone/init 会因为「目标非空」或仓库结构残缺而失败。
    if (isEmptyGitShell(dir)) {
      try {
        fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
        this._log('info', '已清理不完整的 .git 空壳，准备重新初始化');
      } catch (err) {
        this._log('warn', `清理 .git 空壳失败：${err.message}`);
      }
    }

    if (!this.isRepo()) {
      if (isEmptyDir(dir)) {
        this._set({ progress: '正在克隆仓库…', phase: 'syncing' });
        this._log('info', `空目录，开始克隆 ${git.sanitizeUrl(this.project.remoteUrl)}`);
        const r = await this._try(['clone', '--progress', this.project.remoteUrl, '.'], { timeout: git.TIMEOUT_NETWORK });
        if (r.code !== 0) {
          throw new Error(`克隆失败：${git.explainGitError(r.stderr)}`);
        }
        await this._ensureBranch();
      } else {
        this._set({ progress: '正在接管已有目录…', phase: 'syncing' });
        this._log('info', '目录非空且不是仓库，执行 init + 关联远端');
        await this._must(['init'], { allowFail: true });
        // 默认分支名统一
        await this._try(['symbolic-ref', 'HEAD', `refs/heads/${this.project.branch}`]);
        await this._setRemote();
        const ok = await this._fetchRemote();
        if (ok) {
          this._set({ progress: '正在对齐远端历史…' });
          // reset --mixed 只更新 HEAD 与索引，不动工作区文件
          const hasRemoteBranch = await this._remoteBranchExists();
          if (hasRemoteBranch) {
            await this._must(['reset', '--mixed', `origin/${this.project.branch}`]);
            // reset --mixed 只改 HEAD 与索引，不会把文件写到工作区。
            // checkout-index 会补出索引里存在、但工作区缺失的文件；
            // 已存在的本地文件不会被覆盖（保持"本地优先"）。
            await this._try(['checkout-index', '-a']);
            this._log('info', '已将索引对齐到远端分支，并补全缺失文件；本地已有文件保持原样');
          }
        }
      }
    } else {
      await this._setRemote();
    }

    await this._applyExcludeRules();
    this._set({ initialized: true });
  }

  /** 配置（忽略规则 / 开关）变化后立即重写 .git/info/exclude，不用等下一次同步 */
  refreshRules() {
    return this._serial(() => this._applyExcludeRules());
  }

  async _ensureBranch() {
    const branch = this.project.branch;
    const hasRemote = await this._remoteBranchExists();
    const cur = await this._try(['rev-parse', '--abbrev-ref', 'HEAD']);
    const current = (cur.stdout || '').trim();
    if (hasRemote && current !== branch) {
      await this._try(['checkout', '-B', branch, `origin/${branch}`]);
    } else if (!hasRemote && current !== branch) {
      await this._try(['checkout', '-B', branch]);
    }
  }

  async _setRemote() {
    const url = this.project.remoteUrl;
    if (!url) return;
    const r = await this._try(['remote', 'get-url', 'origin']);
    const current = (r.stdout || '').trim();
    if (r.code !== 0) {
      await this._try(['remote', 'add', 'origin', url]);
      this._log('info', `已设置远端 origin = ${git.sanitizeUrl(url)}`);
    } else if (current !== url) {
      await this._try(['remote', 'set-url', 'origin', url]);
      this._log('info', `已更新远端地址为 ${git.sanitizeUrl(url)}`);
    }
  }

  async _remoteBranchExists() {
    const r = await this._try(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${this.project.branch}`]);
    return r.code === 0 && !!(r.stdout || '').trim();
  }

  /** fetch 远端分支引用（失败不抛错，返回是否成功） */
  async _fetchRemote() {
    const r = await this._try(
      ['fetch', '--prune', '--no-tags', 'origin', `+refs/heads/*:refs/remotes/origin/*`],
      { timeout: git.TIMEOUT_NETWORK }
    );
    if (r.code !== 0) {
      // 远端为空的仓库 fetch 也会返回非 0，需要区分
      if (/couldn't find remote ref|no such remote branch|fatal: couldn't find remote ref/i.test(r.stderr || '')) {
        return false;
      }
      throw new Error(`拉取远端失败：${git.explainGitError(r.stderr)}`);
    }
    return true;
  }

  /** 把「内置临时文件规则 + 用户自定义规则」写入 .git/info/exclude（不进仓库、不影响协作者） */
  async _applyExcludeRules() {
    // 普通目录还没初始化成仓库时绝不创建 .git，否则会造出一个「假仓库」，
    // 后续 git status 直接报 not a git repository，clone/init 也可能被挡住。
    if (!this.isRepo()) return;
    const user = Array.isArray(this.project.exclude) ? this.project.exclude.filter(Boolean) : [];
    const rules = ignore.buildExcludeLines(user, ignore.builtinEnabled(this.project));
    const file = path.join(this.project.localDir, '.git', 'info', 'exclude');
    const header = '# --- FileSharing managed rules ---';
    // 旧版本写过的块头，用于升级后替换而不是叠加
    const legacyHeader = '# --- GitSync managed rules ---';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let base = '';
      if (exists(file)) {
        base = fs.readFileSync(file, 'utf8');
        // 兼容旧版本写过的块，避免升级后规则重复堆叠
        const cuts = [header, legacyHeader]
          .map((h) => base.indexOf(h))
          .filter((i) => i >= 0);
        if (cuts.length) base = base.slice(0, Math.min(...cuts));
      }
      if (!rules.length) {
        fs.writeFileSync(file, base.replace(/\s*$/, '\n'), 'utf8');
        return;
      }
      const block = `${header}\n${rules.join('\n')}\n`;
      fs.writeFileSync(file, `${base.replace(/\s*$/, '')}\n\n${block}`, 'utf8');
    } catch (err) {
      this._log('warn', `写入忽略规则失败：${err.message}`);
    }
  }

  // ---------- 状态检查 ----------

  async readStatus() {
    if (!this.isRepo()) {
      return { changes: [], pendingNew: [], ok: false, raw: '本地目录尚未初始化为 Git 仓库' };
    }
    const r = await this._try(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty']);
    if (r.code !== 0) {
      return { changes: [], pendingNew: [], ok: false, raw: r.stderr };
    }
    const items = parsePorcelainZ(r.stdout);
    const changes = [];
    const pendingNew = [];
    for (const it of items) {
      // 内置临时文件规则 / 用户正则规则：直接排除，既不扫描也不上传
      if (ignore.isExcluded(this.project, it.path)) continue;
      const item = {
        path: it.path,
        label: describeChange(it),
        code: it.index + it.worktree,
        unmerged: UNMERGED_CODES.has(it.index + it.worktree),
      };
      // '??' = 本地新增且未被 git 跟踪；ask 策略下先挂起等用户确认
      if (item.code === '??' && ignore.needsConfirm(this.project)) pendingNew.push(item);
      else changes.push(item);
    }
    return { changes, pendingNew, ok: true, raw: '' };
  }

  /** 列出所有已被 git 跟踪的路径（供正则规则评估影响范围） */
  async listTracked() {
    const r = await this._try(['ls-files', '-z']);
    if (r.code !== 0) return [];
    return (r.stdout || '').split('\0').filter(Boolean);
  }

  /**
   * 已被 git 跟踪的临时文件。
   * gitignore / .git/info/exclude 只对未跟踪文件有效，这类历史遗留会继续被同步，
   * 需要单独提示用户执行 git rm --cached（保留本地文件）。
   */
  async readTrackedTransient() {
    if (!ignore.builtinEnabled(this.project)) return [];
    const r = await this._try(['ls-files', '-z']);
    if (r.code !== 0) return [];
    return (r.stdout || '')
      .split('\0')
      .filter((p) => p && ignore.isTransientPath(p))
      .slice(0, 20);
  }

  async readAheadBehind() {
    if (!(await this._remoteBranchExists())) {
      // 远端还没有这个分支：本地提交都算 ahead
      const c = await this._try(['rev-list', '--count', 'HEAD']);
      const ahead = c.code === 0 ? parseInt((c.stdout || '0').trim(), 10) || 0 : 0;
      return { ahead, behind: 0 };
    }
    const r = await this._try(['rev-list', '--left-right', '--count', `HEAD...origin/${this.project.branch}`]);
    if (r.code !== 0) return { ahead: 0, behind: 0 };
    const [a, b] = (r.stdout || '').trim().split(/\s+/);
    return { ahead: parseInt(a, 10) || 0, behind: parseInt(b, 10) || 0 };
  }

  async readHead(rev = 'HEAD') {
    const r = await this._try(['rev-parse', '--short', rev]);
    return r.code === 0 ? (r.stdout || '').trim() : '';
  }

  async readConflicts() {
    const r = await this._try(['diff', '--name-only', '--diff-filter=U', '-z']);
    if (r.code !== 0) return [];
    return (r.stdout || '').split('\0').filter(Boolean);
  }

  /** 只读检查当前状态，供 UI 显示与轻量轮询 */
  async inspect({ silent = true } = {}) {
    return this._serial(() => this._inspectInner({ silent }));
  }

  /**
   * inspect 的无锁实现。
   * 已在 _serial 内部执行的操作必须调用这个版本，否则会重复申请锁导致死锁。
   */
  async _inspectInner({ silent = true } = {}) {
    if (!silent) this._set({ phase: 'checking' });
    if (!this.isRepo()) {
      this._set({
        phase: 'uninitialized',
        initialized: false,
        pendingNew: [],
        lastCheckAt: new Date().toISOString(),
      });
      return this.snapshot();
    }
    try {
      const [st, ab, head, trackedTransient] = await Promise.all([
        this.readStatus(), this.readAheadBehind(), this.readHead(), this.readTrackedTransient(),
      ]);
      const conflicts = await this.readConflicts();
      const inMerge = this.hasMergeInProgress();
      const dirty = st.changes.length > 0;
      let phase = 'synced';
      // 冲突文件全部标记解决、但合并尚未提交时，仍要保持冲突态，
      // 否则界面会收起面板，用户就找不到"完成合并"了
      if (conflicts.length || inMerge) phase = 'conflict';
      else if (ab.ahead > 0 && ab.behind > 0) phase = 'diverged';
      else if (ab.behind > 0) phase = 'behind';
      else if (ab.ahead > 0) phase = 'ahead';
      else if (dirty) phase = 'dirty';

      this._set({
        phase,
        head,
        remoteHead: await this.readHead(`origin/${this.project.branch}`),
        ahead: ab.ahead,
        behind: ab.behind,
        changes: st.changes,
        pendingNew: st.pendingNew,
        conflicts,
        inMerge,
        trackedTransient,
        initialized: true,
        lastCheckAt: new Date().toISOString(),
        lastError: st.ok ? '' : `状态读取异常：${st.raw}`,
      });
    } catch (err) {
      this._set({
        phase: 'error',
        lastError: reasonOf(err),
        lastCheckAt: new Date().toISOString(),
      });
    }
    return this.snapshot();
  }

  // ---------- 同步主流程 ----------

  /**
   * 一次完整同步：
   * fetch → 本地改动处理 → 合并远端 → 推送（按 pushMode）
   * 冲突时停在 conflict 状态，交给用户处理。
   */
  async syncNow({ manual = false } = {}) {
    return this._serial(async () => {
      const p = this.project;
      if (!p.enabled && !manual) return this.snapshot();
      if (!p.localDir || !p.remoteUrl) {
        this._set({ phase: 'error', lastError: '项目未配置完整（本地目录 / 远端地址）' });
        return this.snapshot();
      }

      this._set({ busy: true, phase: 'syncing', progress: '准备中…', lastError: '' });
      const started = Date.now();
      try {
        await this.ensureRepo();

        // 有未完成的合并 → 直接进入冲突处理
        if (this.hasMergeInProgress() || (await this.readConflicts()).length) {
          const conflicts = await this.readConflicts();
          this._set({
            phase: 'conflict',
            conflicts,
            inMerge: true,
            busy: false,
            progress: '',
            lastMessage: '存在未解决的合并冲突，请处理后继续',
            lastCheckAt: new Date().toISOString(),
          });
          return this.snapshot();
        }

        // 1) 本地改动
        this._set({ progress: '检查本地改动…' });
        let st = await this.readStatus();
        if (!st.ok && !this.isRepo()) {
          // 兜底自愈：目录在同步过程中还不是仓库，重新初始化后再读
          await this.ensureRepo();
          st = await this.readStatus();
        }
        if (!st.ok) throw new Error(`状态读取失败：${st.raw}`);
        const dirty = st.changes.length > 0;

        // 已跟踪文件的改动默认自动提交（trackedChangePolicy: auto）。
        // 只有「本地新增文件」才由 newFilePolicy: ask 挂起等确认，两者互不干扰。
        const autoTracked = p.sync.trackedChangePolicy !== 'confirm';
        if (dirty && (p.sync.autoCommit || autoTracked)) {
          this._set({ progress: '提交本地改动…' });
          await this._commitAll(this._autoMessage());
          st = await this.readStatus();
        }

        // 2) 拉远端
        this._set({ progress: '拉取远端引用…' });
        await this._fetchRemote();

        if (!(await this._remoteBranchExists())) {
          // 远端还没有该分支：把本地提交推上去
          this._log('info', `远端不存在分支 ${p.branch}，将创建`);
          await this._pushOrQueue(0, autoTracked);
          await this._finish(started, dirty, '已创建远端分支');
          return this.snapshot();
        }

        let ab = await this.readAheadBehind();

        // 3) 合并远端更新
        if (ab.behind > 0) {
          this._set({ progress: `合并远端 ${ab.behind} 个提交…` });
          const mergeRes = await this._mergeRemote();
          if (mergeRes.conflict) {
            this._set({
              phase: 'conflict',
              conflicts: mergeRes.conflicts,
              inMerge: true,
              ahead: ab.ahead,
              behind: ab.behind,
              busy: false,
              progress: '',
              lastMessage: `合并产生 ${mergeRes.conflicts.length} 个冲突文件，请手动处理`,
              lastSyncAt: new Date().toISOString(),
              lastCheckAt: new Date().toISOString(),
            });
            this._log('warn', `合并冲突：${mergeRes.conflicts.length} 个文件待处理`);
            this.emit('conflict', this.snapshot());
            return this.snapshot();
          }
          if (mergeRes.blocked) {
            this._set({
              phase: 'blocked',
              lastMessage: mergeRes.blocked,
              lastError: mergeRes.blocked,
              busy: false,
              progress: '',
              lastCheckAt: new Date().toISOString(),
            });
            this._log('warn', mergeRes.blocked);
            return this.snapshot();
          }
          if (mergeRes.merged) {
            this._log('info', `已合并远端更新（${mergeRes.summary || 'ok'}）`);
          }
          ab = await this.readAheadBehind();
        }

        // 4) 推送
        await this._pushOrQueue(ab.ahead, autoTracked);

        await this._finish(started, dirty, '');
        return this.snapshot();
      } catch (err) {
        const msg = reasonOf(err);
        this._set({
          phase: 'error',
          lastError: msg,
          busy: false,
          progress: '',
          lastCheckAt: new Date().toISOString(),
        });
        this._log('error', msg);
        return this.snapshot();
      }
    });
  }

  _autoMessage() {
    const name = this.project.name || path.basename(this.project.localDir || 'workspace');
    const host = os.hostname();
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    return `[auto-sync] ${name} @ ${host} ${ts}`;
  }

  /**
   * 提交身份兜底。
   * 用户机器上经常没有配置 user.email，直接 commit 会失败；
   * 这里只在缺失时注入参数，不覆盖用户已有的身份配置。
   */
  async _identityArgs() {
    if (this._ident !== undefined) return this._ident;
    const [n, e] = await Promise.all([
      this._try(['config', '--get', 'user.name']),
      this._try(['config', '--get', 'user.email']),
    ]);
    const host = (os.hostname() || 'device').replace(/[^a-zA-Z0-9.-]/g, '') || 'device';
    const args = [];
    if (!(n.stdout || '').trim()) args.push('-c', 'user.name=FileSharing');
    if (!(e.stdout || '').trim()) args.push('-c', `user.email=filesharing@${host}.local`);
    this._ident = args;
    return args;
  }

  async _commitAll(message) {
    const ident = await this._identityArgs();
    if (ignore.needsConfirm(this.project)) {
      // 绝不使用 add -A：只把「已确认上传 / 已跟踪且未被正则排除」的文件纳入索引。
      // 用户点「上传」时已显式 git add 过，那些文件在索引里会正常进入本次提交。
      const st = await this.readStatus();
      const paths = st.changes.map((c) => c.path);
      if (paths.length) await this._must(['add', '-u', '--', ...paths]);
    } else {
      await this._must(['add', '-A']);
    }
    const r = await this._try([...ident, 'commit', '-m', message, '--no-verify']);
    if (r.code !== 0) {
      if (/nothing to commit|no changes added/i.test(r.stdout + r.stderr)) return false;
      if (r.error) throw r.error;
      throw new Error(`提交失败：${git.explainGitError(r.stderr)}`);
    }
    this._log('info', `已提交本地改动：${message}`);
    return true;
  }

  /** 合并远端，返回 {merged, conflict, conflicts, blocked, summary} */
  async _mergeRemote() {
    const ident = await this._identityArgs();
    // 不加 --no-ff：能快进就快进，避免多设备自动同步产生大量无意义的 merge commit
    const args = [...ident, 'merge', '--no-edit', `origin/${this.project.branch}`];
    if (this.project.sync.allowUnrelatedMerge) args.push('--allow-unrelated-histories');
    const r = await this._try(args, { timeout: git.TIMEOUT_NETWORK });

    if (r.code === 0) {
      const summary = (r.stdout || '').trim().split('\n')[0] || 'ok';
      return { merged: true, conflict: false, conflicts: [], summary };
    }

    const conflicts = await this.readConflicts();
    if (conflicts.length) {
      return { merged: false, conflict: true, conflicts };
    }

    // 常见阻塞：本地有未提交改动
    const text = `${r.stdout}\n${r.stderr}`;
    if (/would be overwritten|Please commit your changes|Your local changes/i.test(text)) {
      return {
        merged: false,
        conflict: false,
        conflicts: [],
        blocked: '本地存在未提交改动，与远端更新重叠。请先提交本地改动，或把它们加入忽略规则。',
      };
    }
    throw new Error(`合并失败：${git.explainGitError(r.stderr)}`);
  }

  /** 按 pushMode 决定直接推送还是进入待确认状态 */
  async _pushOrQueue(ahead, forceAuto = false) {
    if (ahead <= 0) return { pushed: false, queued: false };
    if (forceAuto || this.project.sync.pushMode === 'auto') {
      this._set({ progress: '推送本地提交…' });
      // _pushOrQueue 是在 syncNow 的 _serial 锁内调用的，必须 insideLock，
      // 否则 pushNow 会再次申请同一把锁导致永久挂起（进程静默退出）。
      await this.pushNow({ manual: true, insideLock: true });
      return { pushed: true, queued: false };
    }
    this._set({ phase: 'ahead', lastMessage: `${ahead} 个本地提交等待推送确认` });
    return { pushed: false, queued: true };
  }

  async _finish(started, hadDirty, note) {
    const ab = await this.readAheadBehind();
    const st = await this.readStatus();
    const conflicts = await this.readConflicts();
    let phase = 'synced';
    if (conflicts.length) phase = 'conflict';
    else if (ab.ahead > 0 && this.project.sync.pushMode === 'confirm'
             && this.project.sync.trackedChangePolicy === 'confirm') phase = 'ahead';
    else if (ab.ahead > 0 && ab.behind > 0) phase = 'diverged';
    else if (st.changes.length > 0) phase = 'dirty';

    const now = new Date().toISOString();
    this._set({
      phase,
      ahead: ab.ahead,
      behind: ab.behind,
      changes: st.changes,
      pendingNew: st.pendingNew,
      conflicts,
      inMerge: this.hasMergeInProgress(),
      head: await this.readHead(),
      remoteHead: await this.readHead(`origin/${this.project.branch}`),
      busy: false,
      progress: '',
      lastSyncAt: now,
      lastCheckAt: now,
      lastError: '',
      lastMessage: note || (phase === 'ahead' ? `${ab.ahead} 个本地提交等待推送确认` : ''),
    });
    this._log('info', `同步完成，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    this.emit('synced', this.snapshot());
  }

  // ---------- 用户操作 ----------

  /** 用户确认「这些本地新增文件要上传」→ 显式加入索引 */
  async acceptNew(files) {
    return this._serial(async () => {
      const list = (files || []).filter(Boolean);
      if (!list.length) return this.snapshot();
      await this._must(['add', '--', ...list]);
      this._log('info', `已确认 ${list.length} 个新文件加入同步`);
      return this._inspectInner({ silent: false });
    });
  }

  /** 停止追踪已跟踪文件（git rm --cached，本地文件保留） */
  async untrackFiles(files) {
    return this._serial(async () => {
      const list = (files || []).filter(Boolean);
      if (!list.length) return this.snapshot();
      const r = await this._try(['rm', '--cached', '-f', '--', ...list]);
      if (r.code !== 0) {
        throw new Error(`停止追踪失败：${git.explainGitError(r.stderr)}`);
      }
      this._log('info', `已停止追踪 ${list.length} 个文件（本地文件保留）`);
      return this._inspectInner({ silent: false });
    });
  }

  /** 提交全部本地改动并推送 */
  async commitAndPush(message) {
    return this._serial(async () => {
      this._set({ busy: true, phase: 'syncing', progress: '提交并推送…', lastError: '' });
      try {
        await this.ensureRepo();
        const st = await this.readStatus();
        if (st.changes.length) {
          await this._commitAll(message || this._autoMessage());
        }
        await this._fetchRemote();
        let ab = await this.readAheadBehind();
        if (ab.behind > 0) {
          const m = await this._mergeRemote();
          if (m.conflict) {
            this._set({
              phase: 'conflict',
              conflicts: m.conflicts,
              busy: false,
              progress: '',
              lastMessage: '推送前需要先合并远端，产生了冲突',
            });
            return this.snapshot();
          }
          if (m.blocked) {
            this._set({ phase: 'blocked', lastError: m.blocked, busy: false, progress: '' });
            return this.snapshot();
          }
          ab = await this.readAheadBehind();
        }
        await this.pushNow({ manual: true, insideLock: true });
        await this._finish(Date.now(), false, '已推送');
        return this.snapshot();
      } catch (err) {
        const msg = reasonOf(err);
        this._set({ phase: 'error', lastError: msg, busy: false, progress: '' });
        this._log('error', msg);
        return this.snapshot();
      }
    });
  }

  async pushNow({ manual = false, insideLock = false } = {}) {
    const task = async () => {
      const p = this.project;
      const before = (await this.readAheadBehind()).ahead;
      const r = await this._try(
        ['push', 'origin', `HEAD:refs/heads/${p.branch}`],
        { timeout: git.TIMEOUT_NETWORK }
      );
      if (r.code !== 0) {
        const text = r.stderr || '';
        if (/non-fast-forward|rejected|fetch first/i.test(text)) {
          throw new Error('推送被拒绝：远端已有新提交，请先执行同步');
        }
        throw new Error(`推送失败：${git.explainGitError(text)}`);
      }
      this._log('info', `已推送 ${before} 个提交到 origin/${p.branch}`);
      this._set({ ahead: 0, phase: 'synced', lastSyncAt: new Date().toISOString() });
      return { ok: true };
    };
    return insideLock ? task() : this._serial(task);
  }

  /** 放弃本地未提交改动（只恢复已跟踪文件，不删除未跟踪文件） */
  async discardTracked() {
    return this._serial(async () => {
      await this._must(['restore', '--worktree', '--staged', '.']);
      this._log('warn', '已丢弃本地未提交改动（已跟踪文件）');
      return this._inspectInner({ silent: false });
    });
  }

  /**
   * 解决单个冲突文件
   * strategy: ours（保留本地）/ theirs（采用远端）
   */
  async resolveFile(file, strategy) {
    return this._serial(async () => {
      if (strategy !== 'ours' && strategy !== 'theirs') throw new Error('未知的解决策略');
      const flag = strategy === 'ours' ? '--ours' : '--theirs';
      const r = await this._try(['checkout', flag, '--', file]);
      if (r.code !== 0) {
        throw new Error(`处理文件失败：${git.explainGitError(r.stderr)}`);
      }
      await this._must(['add', '--', file]);
      this._log('info', `${strategy === 'ours' ? '保留本地' : '采用远端'}：${file}`);
      const conflicts = await this.readConflicts();
      const inMerge = this.hasMergeInProgress();
      this._set({ conflicts, inMerge, phase: (conflicts.length || inMerge) ? 'conflict' : this.state.phase });
      return { conflicts, inMerge };
    });
  }

  /** 标记冲突已全部解决并完成合并提交 */
  async finishMerge({ push = null } = {}) {
    return this._serial(async () => {
      this._set({ busy: true, progress: '完成合并…' });
      try {
        const conflicts = await this.readConflicts();
        if (conflicts.length) {
          throw new Error(`还有 ${conflicts.length} 个文件未标记为解决`);
        }
        await this._must(['add', '-A']);
        const inMerge = this.hasMergeInProgress();
        if (inMerge) {
          const ident = await this._identityArgs();
          const r = await this._try([...ident, 'commit', '--no-edit', '--no-verify']);
          if (r.code !== 0 && !/nothing to commit/i.test(r.stdout + r.stderr)) {
            throw new Error(`合并提交失败：${git.explainGitError(r.stderr)}`);
          }
        }
        this._log('info', '合并已完成');
        const shouldPush = push === null ? this.project.sync.pushMode === 'auto' : push;
        if (shouldPush) {
          await this.pushNow({ manual: true, insideLock: true });
        }
        await this._finish(Date.now(), false, shouldPush ? '冲突已解决并推送' : '冲突已解决');
        return this.snapshot();
      } catch (err) {
        const msg = reasonOf(err);
        this._set({ busy: false, progress: '', lastError: msg });
        this._log('error', msg);
        return this.snapshot();
      }
    });
  }

  /** 放弃本次合并，回到合并前状态 */
  async abortMerge() {
    return this._serial(async () => {
      const r = await this._try(['merge', '--abort']);
      if (r.code !== 0) {
        // 没有可 abort 的合并时，退化为清理冲突标记
        await this._try(['reset', '--merge']);
      }
      this._log('warn', '已放弃本次合并');
      await this._inspectInner({ silent: false });
      return this.snapshot();
    });
  }

  /** 打开冲突文件进行编辑（返回绝对路径） */
  absPath(rel) {
    return path.join(this.project.localDir, rel);
  }
}

module.exports = { RepoEngine, parsePorcelainZ, describeChange, reasonOf };
