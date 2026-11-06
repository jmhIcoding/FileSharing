'use strict';

/* global window, document */

const rpc = window.api;

// ---------- 状态 ----------
const state = {
  config: null,
  snapshots: new Map(),
  activeId: null,
  logs: [],
  git: null,
  pending: new Set(),
  version: '',
  secureStorage: false,
  hostname: '',
  modal: null,
};

const PHASE = {
  idle: { text: '未检查', cls: 'idle', color: '' },
  uninitialized: { text: '未初始化', cls: 'idle', color: '' },
  checking: { text: '检查中', cls: 'run', color: 'checking' },
  syncing: { text: '同步中', cls: 'run', color: 'syncing' },
  synced: { text: '已同步', cls: 'ok', color: 'synced' },
  dirty: { text: '有本地改动', cls: 'warn', color: 'dirty' },
  ahead: { text: '待推送', cls: 'run', color: 'ahead' },
  behind: { text: '待拉取', cls: 'run', color: 'behind' },
  diverged: { text: '已分叉', cls: 'warn', color: 'diverged' },
  conflict: { text: '合并冲突', cls: 'bad', color: 'conflict' },
  blocked: { text: '同步被阻塞', cls: 'warn', color: 'blocked' },
  error: { text: '同步失败', cls: 'bad', color: 'error' },
};

// ---------- 工具 ----------
const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function icon(name, size = 15) {
  const paths = {
    sync: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
    merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    undo: '<path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.1-9.4L3 7"/>',
    terminal: '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
    refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10"/><path d="M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1 21 2M17 6l3 3M14 9l3 3"/>',
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const s = Math.floor(diff / 1000);
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch (_) {
    return '';
  }
}

function freqText(sec) {
  const n = Number(sec) || 0;
  if (n < 60) return `${n} 秒`;
  if (n < 3600) return `${Math.round(n / 60)} 分钟`;
  const h = n / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
}

function toast(msg, type = '') {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, type === 'err' ? 4600 : 2600);
}

async function withPending(key, fn) {
  if (state.pending.has(key)) return;
  state.pending.add(key);
  render();
  try {
    await fn();
  } catch (err) {
    toast(err.message || String(err), 'err');
  } finally {
    state.pending.delete(key);
    render();
  }
}

// ---------- 数据访问 ----------
function projects() { return state.config ? state.config.projects : []; }

function getProject(id) { return projects().find((p) => p.id === id) || null; }

function getSnap(id) {
  return state.snapshots.get(id) || {
    projectId: id,
    phase: 'idle',
    ahead: 0,
    behind: 0,
    changes: [],
    conflicts: [],
    busy: false,
    lastSyncAt: null,
    lastError: '',
    lastMessage: '',
  };
}

function activeProject() { return getProject(state.activeId); }

// ---------- 渲染：侧栏 ----------
function renderSidebar() {
  const list = $('#projectList');
  const ps = projects();

  if (!ps.length) {
    list.innerHTML = `
      <div style="padding:26px 16px;text-align:center;color:var(--muted);font-size:12.5px;line-height:1.8">
        还没有监控目录<br>
        <span style="font-size:11.5px">点击右上角 + 添加</span>
      </div>`;
  } else {
    list.innerHTML = ps.map((p) => {
      const snap = getSnap(p.id);
      const ph = PHASE[snap.phase] || PHASE.idle;
      const conflictCount = snap.conflicts ? snap.conflicts.length : 0;
      const changeCount = snap.changes ? snap.changes.length : 0;

      let sub = '';
      if (!p.enabled) sub = '已暂停';
      else if (snap.phase === 'conflict') sub = conflictCount ? `${conflictCount} 个冲突待处理` : '待完成合并';
      else if (snap.phase === 'error') sub = '同步出错';
      else if (snap.phase === 'blocked') sub = '本地改动阻塞合并';
      else if (snap.phase === 'ahead') sub = `${snap.ahead} 个提交待推送`;
      else if (snap.phase === 'behind') sub = `远端有 ${snap.behind} 个新提交`;
      else if (snap.phase === 'diverged') sub = `本地 ${snap.ahead} · 远端 ${snap.behind}`;
      else if (snap.phase === 'syncing' || snap.phase === 'checking') sub = snap.progress || '同步中…';
      else if (snap.phase === 'dirty') sub = `${changeCount} 个文件有改动`;
      else if (snap.phase === 'synced') sub = `已同步 · ${fmtRelative(snap.lastSyncAt)}`;
      else sub = p.branch || '';

      const isActive = p.id === state.activeId;
      return `
        <div class="proj ${isActive ? 'active' : ''} ${p.enabled ? '' : 'off'}" data-action="select" data-id="${esc(p.id)}">
          <span class="proj-dot ${p.enabled ? ph.color : ''}"></span>
          <div class="proj-body">
            <div class="proj-name">${esc(p.name || p.localDir || '未命名')}</div>
            <div class="proj-sub">${esc(sub)}</div>
          </div>
          ${conflictCount ? `<span class="proj-badge">${conflictCount}</span>` : ''}
        </div>`;
    }).join('');
  }

  const enabled = ps.filter((p) => p.enabled);
  const conflicts = ps.reduce((n, p) => n + (getSnap(p.id).conflicts || []).length, 0);
  const gitOk = state.git && state.git.ok;
  $('#sidebarFoot').innerHTML = `
    <div class="foot-row"><span class="dot-mini ${gitOk ? '' : 'bad'}"></span>Git ${gitOk ? esc((state.git.version || '').replace('git version ', '')) : '未找到'}</div>
    <div class="foot-row"><span class="dot-mini ${enabled.length ? '' : 'off'}"></span>监控 ${enabled.length} / ${ps.length} 个目录${conflicts ? ` · <b style="color:var(--red)">${conflicts} 冲突</b>` : ''}</div>
    <div class="foot-row" style="color:#a8b0bc;font-size:11px">${esc(state.hostname || '')}</div>`;
}

// ---------- 渲染：详情 ----------
function renderDetail() {
  const host = $('#content');
  const scrollTop = host.scrollTop;
  const p = activeProject();

  if (!p) {
    host.innerHTML = emptyState();
    host.scrollTop = 0;
    return;
  }

  const snap = getSnap(p.id);
  const ph = PHASE[snap.phase] || PHASE.idle;
  const dirty = snap.changes && snap.changes.length > 0;
  const ahead = snap.ahead || 0;
  const behind = snap.behind || 0;
  const conflicts = snap.conflicts || [];
  const busy = snap.busy || snap.phase === 'syncing';

  const banners = [];
  if (snap.phase === 'error' && snap.lastError) {
    banners.push(banner('err', '同步失败', snap.lastError));
  } else if (snap.phase === 'blocked' && snap.lastMessage) {
    banners.push(banner('warn', '合并被本地改动阻塞', snap.lastMessage));
  } else if (!p.enabled) {
    banners.push(banner('info', '该项目已暂停', '暂停期间不会自动同步，仍可手动触发。'));
  }
  const trackedTmp = snap.trackedTransient || [];
  if (trackedTmp.length) {
    banners.push(banner('warn', `${trackedTmp.length} 个临时文件已被 Git 跟踪`,
      `忽略规则只对未跟踪文件生效，这几个历史遗留仍会被同步：${trackedTmp.slice(0, 5).join('、')}${trackedTmp.length > 5 ? ' …' : ''}。在该目录执行 git rm --cached <文件名> 可从仓库移除（本地文件保留），再提交一次即可。`));
  }

  const conflictPanel = (conflicts.length || snap.inMerge || snap.phase === 'conflict') ? renderConflictPanel(p, snap) : '';
  const changePanel = dirty ? renderChanges(p, snap) : '';
  const logPanel = renderLogs(p);

  host.innerHTML = `<div class="frame">
    <div class="detail-head">
      <div style="min-width:0">
        <h1 class="detail-title">${esc(p.name || '未命名项目')}</h1>
        <div class="detail-meta">
          <span class="mono path-label" title="${esc(p.localDir)}">${esc(p.localDir)}</span>
          <span class="sep">·</span>
          <span>分支 <b>${esc(p.branch)}</b></span>
          <span class="sep">·</span>
          <span>每 ${esc(freqText(p.sync.intervalSec))}自动同步</span>
          <span class="sep">·</span>
          <span>凭据 <b>${esc((p.auth && p.auth.credentialName) || '未配置')}</b></span>
          ${snap.head ? `<span class="sep">·</span><span class="mono">HEAD ${esc(snap.head)}</span>` : ''}
        </div>
      </div>
      <span class="status-pill ${ph.cls}"><span class="pd"></span>${busy && snap.progress ? esc(snap.progress) : (snap.phase === 'conflict' && !conflicts.length ? '待完成合并' : ph.text)}</span>
    </div>

    ${banners.join('')}

    <div class="toolbar">
      <button class="btn btn-primary" data-action="sync" data-id="${esc(p.id)}" ${busy || !p.enabled ? 'disabled' : ''}>
        ${icon('refresh', 14)} ${state.pending.has('sync:' + p.id) ? '同步中…' : '立即同步'}
      </button>
      ${dirty ? `
        <button class="btn btn-ok" data-action="commit-push" data-id="${esc(p.id)}" ${busy ? 'disabled' : ''}>
          ${icon('up', 14)} ${ahead > 0 ? `提交并推送 ${ahead + 1} 个提交` : '提交并推送'}
        </button>` : ''}
      ${ahead > 0 && !dirty ? `
        <button class="btn btn-ok" data-action="push" data-id="${esc(p.id)}" ${busy ? 'disabled' : ''}>
          ${icon('up', 14)} 推送 ${ahead} 个提交
        </button>` : ''}
      <button class="btn" data-action="open-folder" data-id="${esc(p.id)}">${icon('folder', 14)} 打开目录</button>
      <div class="spacer"></div>
      <button class="btn btn-ghost btn-sm" data-action="regex-tool" data-id="${esc(p.id)}" title="测试正则并加入忽略规则">${icon('terminal', 13)} 正则工具</button>
      <button class="btn btn-ghost btn-sm" data-action="credentials" title="打开设置 → Git 凭据库">${icon('key', 13)} 凭据设置</button>
      <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${esc(p.id)}">${icon('edit', 13)} 编辑配置</button>
      <button class="btn btn-ghost btn-sm" data-action="toggle" data-id="${esc(p.id)}">${p.enabled ? '暂停监控' : '恢复监控'}</button>
    </div>

    <div class="metrics">
      <div class="metric">
        <div class="metric-label">待推送</div>
        <div class="metric-value">${ahead}<span class="unit">个提交</span></div>
        <div class="metric-sub">${p.sync.trackedChangePolicy !== 'confirm' ? '改动自动上传' : '推送需确认'}</div>
      </div>
      <div class="metric">
        <div class="metric-label">待拉取</div>
        <div class="metric-value">${behind}<span class="unit">个提交</span></div>
        <div class="metric-sub">${behind > 0 ? '下次同步将自动合并' : '与远端一致'}</div>
      </div>
      <div class="metric">
        <div class="metric-label">本地改动</div>
        <div class="metric-value">${snap.changes ? snap.changes.length : 0}<span class="unit">个文件</span></div>
        <div class="metric-sub">${p.sync.autoCommit ? '自动提交已开启' : '需手动提交'}</div>
      </div>
      <div class="metric">
        <div class="metric-label">上次同步</div>
        <div class="metric-value" style="font-size:13.5px">${esc(fmtRelative(snap.lastSyncAt))}</div>
        <div class="metric-sub">${snap.lastSyncAt ? new Date(snap.lastSyncAt).toLocaleString('zh-CN', { hour12: false }) : '尚未同步'}</div>
      </div>
    </div>

    ${conflictPanel}
    ${renderPendingNew(p, snap)}
    ${changePanel}
    ${logPanel}
  </div>`;

  host.scrollTop = scrollTop;
}

function shortenPath(p, max) {
  if (!p) return '';
  if (p.length <= max) return p;
  const parts = p.split(/[\\/]/).filter(Boolean);
  let out = parts[parts.length - 1] || '';
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const next = out ? `${parts[i]}\\${out}` : parts[i];
    if (next.length > max - 2) return `…\\${out}`;
    out = next;
  }
  return out;
}

function banner(type, title, detail) {
  const ic = type === 'err' ? 'alert' : type === 'warn' ? 'alert' : 'info';
  return `
    <div class="banner ${type}">
      ${icon(ic, 16)}
      <div class="grow">
        <div class="b-title">${esc(title)}</div>
        <div class="b-detail">${esc(detail)}</div>
      </div>
    </div>`;
}

function renderConflictPanel(p, snap) {
  const files = snap.conflicts || [];
  return `
    <div class="panel conflict">
      <div class="panel-head">
        <div class="panel-title">${icon('merge', 14)} 合并冲突 <span class="count">${files.length}</span></div>
        <div class="hint-inline">需要你决定每个文件保留哪个版本</div>
      </div>
      <div class="conflict-note">
        远端与本地修改了相同的文件，Git 已暂停合并。请逐个选择保留版本，或直接打开文件手动编辑并删除
        <b>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</b> / <b>=======</b> / <b>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</b> 标记。
      </div>
      ${files.length ? files.map((f) => `
        <div class="cfile">
          <span class="cfile-path" title="${esc(f)}">${esc(f)}</span>
          <div class="cfile-actions">
            <button class="btn btn-sm" data-action="open-conflict" data-id="${esc(p.id)}" data-file="${esc(f)}">${icon('edit', 12)} 打开</button>
            <button class="btn btn-sm" data-action="resolve-ours" data-id="${esc(p.id)}" data-file="${esc(f)}" title="保留本地这一版，丢弃远端改动">保留本地</button>
            <button class="btn btn-sm" data-action="resolve-theirs" data-id="${esc(p.id)}" data-file="${esc(f)}" title="采用远端这一版，丢弃本地改动">采用远端</button>
          </div>
        </div>`).join('') : `
        <div class="cfile"><span class="cfile-path" style="color:var(--muted)">冲突标记已全部清除，可以完成合并</span></div>`}
      <div class="modal-foot" style="border-top:1px solid var(--border);background:var(--surface-2)">
        <div class="left hint-inline">解决后点击右侧按钮生成合并提交</div>
        <button class="btn btn-danger btn-sm" data-action="abort-merge" data-id="${esc(p.id)}">放弃本次合并</button>
        <button class="btn btn-primary btn-sm" data-action="finish-merge" data-id="${esc(p.id)}" ${files.length ? 'disabled' : ''}>
          ${icon('check', 13)} 完成合并
        </button>
      </div>
    </div>`;
}

/** 本地新增但还没确认要不要上传的文件 */
function renderPendingNew(p, snap) {
  const items = snap.pendingNew || [];
  if (!items.length) return '';
  return `
    <div class="panel" id="pendingNewPanel">
      <div class="panel-head">
        <div class="panel-title">${icon('plus', 14)} 待确认的新文件 <span class="count">${items.length}</span></div>
        <div class="input-row">
          <button class="btn btn-ghost btn-sm" data-action="accept-all-new" data-id="${esc(p.id)}">全部上传</button>
          <button class="btn btn-ghost btn-sm" data-action="regex-tool" data-id="${esc(p.id)}">正则批量忽略</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="desc" style="padding:8px 12px 10px"><b>只有本地新增的文件</b>需要在这里确认。已经同步过的文件改了会自动上传，不用管这里；也可以用正则一次性忽略同类文件。</div>
        ${items.slice(0, 200).map((c) => `
          <div class="file-row">
            <span class="file-tag u">待确认</span>
            <span class="file-path" title="${esc(c.path)}">${esc(c.path)}</span>
            <button class="btn btn-xs" data-action="accept-new" data-id="${esc(p.id)}" data-file="${esc(c.path)}">上传</button>
            <button class="btn btn-xs" data-action="ignore-new" data-id="${esc(p.id)}" data-file="${esc(c.path)}">忽略…</button>
          </div>`).join('')}
        ${items.length > 200 ? `<div class="file-row hint-inline">还有 ${items.length - 200} 个文件未显示…</div>` : ''}
      </div>
    </div>`;
}

function renderChanges(p, snap) {
  const items = snap.changes || [];
  return `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">${icon('file', 14)} 本地改动 <span class="count">${items.length}</span></div>
        <button class="btn btn-ghost btn-sm" data-action="discard" data-id="${esc(p.id)}">${icon('undo', 12)} 丢弃已跟踪改动</button>
      </div>
      <div class="panel-body">
        ${items.slice(0, 200).map((c) => `
          <div class="file-row">
            <span class="file-tag ${tagClass(c)}">${esc(c.label)}</span>
            <span class="file-path" title="${esc(c.path)}">${esc(c.path)}</span>
            <button class="btn btn-xs" data-action="untrack" data-id="${esc(p.id)}" data-file="${esc(c.path)}" title="从 Git 移除追踪，本地文件保留">不再追踪</button>
            <button class="icon-btn sm" data-action="show-file" data-id="${esc(p.id)}" data-file="${esc(c.path)}" title="在资源管理器中显示">${icon('external', 12)}</button>
          </div>`).join('')}
        ${items.length > 200 ? `<div class="file-row hint-inline">还有 ${items.length - 200} 个文件未显示…</div>` : ''}
      </div>
    </div>`;
}

function tagClass(c) {
  if (c.unmerged) return 'd';
  if (c.label === '新增') return 'a';
  if (c.label === '删除') return 'd';
  if (c.label === '修改' || c.label === '重命名') return 'm';
  return 'u';
}

function renderLogs(p) {
  const scope = p.name || p.id;
  const lines = state.logs.filter((l) => !l.scope || l.scope === scope || l.scope === 'scheduler').slice(-80);
  return `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">${icon('terminal', 14)} 活动日志</div>
        <button class="btn btn-ghost btn-sm" data-action="open-logs">打开日志目录</button>
      </div>
      <div class="log-list" id="logList">
        ${lines.length ? lines.map((l) => `
          <div class="log-line">
            <span class="log-time">${esc(fmtTime(l.ts))}</span>
            <span class="log-level ${esc(l.level)}">${esc(l.level.toUpperCase())}</span>
            <span class="log-msg">${esc(l.msg)}</span>
          </div>`).join('') : '<div class="log-line"><span class="log-msg" style="color:var(--muted)">暂无记录</span></div>'}
      </div>
    </div>`;
}

function emptyState() {
  return `
    <div class="empty">
      <div class="empty-art">
        <svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>
          <path d="M3 12a9 9 0 0 0 2.6 6.4"/><path d="M3 21v-6h6"/>
        </svg>
      </div>
      <h2>添加一个要监控的目录</h2>
      <p>FileSharing 会持续盯住你的本地文件夹，和 Git 仓库里的版本做比对：远端有更新就自动合并下来，本地有改动就提交上去。遇到两边改同一个文件，会停下来交给你决定。</p>
      <button class="btn btn-primary" data-action="add">
        ${icon('plus', 15)} 添加监控目录
      </button>
      <div class="hint">
        支持已有 Git 仓库 / 普通文件夹（自动建仓）<br>
        多台电脑可同时监控同一个仓库
      </div>
    </div>`;
}

function render() {
  renderSidebar();
  renderDetail();
}

// ---------- 弹窗基础 ----------
function openModal(html, opts = {}) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop" data-modal-backdrop><div class="modal ${opts.wide ? 'wide' : ''}">${html}</div></div>`;
  const close = () => { root.innerHTML = ''; state.modal = null; };
  root.querySelector('[data-modal-backdrop]').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget && opts.dismissible !== false) close();
  });
  state.modal = { close };
  return { root, close };
}

// ---------- 正则快速匹配小工具 ----------
function regexTesterFragment(preset) {
  return `
    <div class="regex-tool">
      <div class="desc">左边填文件名（每行一条），右边填正则表达式，下面实时看能不能匹配上。有匹配结果才能确认加入忽略规则。</div>
      <div class="grid2">
        <div class="field">
          <label>文件名（每行一条）</label>
          <textarea class="textarea" id="rx-names" rows="6" placeholder="~$报价单.docx&#10;debug.log&#10;node_modules/a.js">${esc((preset || []).join('\n'))}</textarea>
        </div>
        <div class="field">
          <label>正则表达式</label>
          <input class="input" id="rx-pattern" placeholder="例如 ^~\$|\.tmp$ 或 ^docs/" autocomplete="off" />
          <label class="cred-check"><input type="checkbox" id="rx-case" /> 区分大小写（默认不区分）</label>
          <div class="desc">规则会同时匹配完整相对路径和文件名。加入后对该目录立即生效。</div>
        </div>
      </div>
      <div class="rx-result" id="rx-result"></div>
      <div class="input-row rx-foot">
        <button class="btn btn-primary btn-sm" id="rx-add" disabled>确认加入忽略规则</button>
        <span class="hint-inline" id="rx-hint"></span>
      </div>
    </div>`;
}

function bindRegexTester(root, projectId, { onAdded, presetCase } = {}) {
  const q = (s) => root.querySelector(s);
  const namesEl = q('#rx-names');
  const patEl = q('#rx-pattern');
  const caseEl = q('#rx-case');
  const resEl = q('#rx-result');
  const addBtn = q('#rx-add');
  const hint = q('#rx-hint');
  if (presetCase) caseEl.checked = true;
  let matched = 0;

  function refresh() {
    const names = namesEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const pat = patEl.value.trim();
    resEl.innerHTML = '';
    matched = 0;
    addBtn.disabled = true;
    if (!pat) { hint.textContent = '先填一个正则表达式'; return; }
    if (pat.length > 200) { hint.textContent = '正则过长（最多 200 字符）'; return; }
    let re;
    try { re = new RegExp(pat, caseEl.checked ? '' : 'i'); }
    catch (err) { hint.textContent = `正则无效：${err.message}`; return; }
    if (!names.length) { hint.textContent = '至少填一个文件名'; return; }
    for (const n of names) {
      const m = re.exec(n);
      let shown = esc(n);
      if (m) {
        matched += 1;
        const i = m.index;
        const len = Math.max(1, m[0].length);
        shown = esc(n.slice(0, i)) + '<mark>' + esc(n.slice(i, i + len)) + '</mark>' + esc(n.slice(i + len));
      }
      const row = document.createElement('div');
      row.className = `rx-row ${m ? 'hit' : 'miss'}`;
      row.innerHTML = `<span class="rx-mark">${m ? '匹配' : '不匹配'}</span><span class="rx-name">${shown}</span>`;
      resEl.appendChild(row);
    }
    hint.textContent = `匹配 ${matched} / ${names.length}`;
    addBtn.disabled = matched === 0;
  }

  [namesEl, patEl].forEach((el) => el.addEventListener('input', refresh));
  caseEl.addEventListener('change', refresh);
  addBtn.addEventListener('click', async () => {
    if (addBtn.disabled) return;
    const rule = patEl.value.trim();
    addBtn.disabled = true;
    try {
      const res = await rpc.project.fileDecision({
        id: projectId, action: 'add-rule', files: [], rule,
        caseSensitive: caseEl.checked,
      });
      state.config = res.config;
      state.snapshots.set(projectId, res.snapshot);
      toast(`已加入忽略规则：${rule}`, 'ok');
      if (onAdded) onAdded();
      else render();
    } catch (err) {
      toast(err.message || '加入失败', 'err');
    } finally {
      refresh();
    }
  });
  refresh();
  return { refresh };
}

function openRegexTesterModal(projectId, preset = []) {
  const p = getProject(projectId);
  const html = `
    <div class="modal-head">
      <div>
        <div class="modal-title">正则快速匹配</div>
        <div class="modal-sub">输入文件名与正则表达式，匹配上再确认加入忽略规则</div>
      </div>
      <button class="icon-btn" data-close>${icon('x', 16)}</button>
    </div>
    <div class="modal-body">${regexTesterFragment(preset)}</div>`;
  const { root, close } = openModal(html, { wide: true });
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  bindRegexTester(root, projectId, { presetCase: !!(p && p.sync && p.sync.regexCaseSensitive) });
  setTimeout(() => root.querySelector('#rx-pattern').focus(), 60);
}

function escapeRegexText(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 根据文件名给正则工具生成一个可直接用的建议规则 */
function suggestRegex(file) {
  const dot = file.lastIndexOf('.');
  if (dot > 0 && dot < file.length - 1) return `\\.${escapeRegexText(file.slice(dot + 1))}$`;
  return `^${escapeRegexText(file)}$`;
}

/** 统一的文件决策入口：确认上传 / 加规则 / 停止追踪 */
async function fileDecision(id, action, files = [], rule = '', extra = {}) {
  await withPending('decide:' + id, async () => {
    const res = await rpc.project.fileDecision({ id, action, files, rule, ...extra });
    state.config = res.config;
    state.snapshots.set(id, res.snapshot);
    render();
  });
}

// ---------- 项目编辑 ----------
function openProjectModal(projectId) {
  const p = projectId ? getProject(projectId) : null;
  const isNew = !p;
  const g = state.config.globals;
  const creds = g.credentials || [];
  // 四态认证：global 自动匹配 / credential 指定凭据 / custom 本目录专属 / none 公开仓库
  const authMode = p ? (p.auth.mode || 'global') : 'global';
  const credentialId = p ? (p.auth.credentialId || '') : (g.defaultCredentialId || '');
  const hasProjectToken = !!(p && p.auth.hasToken);
  const builtinOn = !p || p.sync.builtinIgnore !== false;
  const trackedAuto = !p || p.sync.trackedChangePolicy !== 'confirm';

  function ruleChipsHtml(rules) {
    const list = Array.isArray(rules) ? rules : [];
    if (!list.length) return '<span class="hint-inline">还没有正则规则</span>';
    return list.map((r) => `<span class="rule-chip">${esc(r)}${p ? `<button class="chip-x" data-rule="${esc(r)}" title="删除规则">×</button>` : ''}</span>`).join('');
  }

  function credOptionsHtml(selected) {
    if (!creds.length) return '<option value="">（凭据库还是空的，请先到设置里添加）</option>';
    return creds.map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.name)}${c.host ? `（${esc(c.host)}）` : ''}</option>`).join('');
  }

  function authHintHtml(mode, id) {
    const banner = (kind, title, detail) => `<div class="banner ${kind}" style="margin-bottom:14px">${icon('info', 16)}
        <div class="grow"><div class="b-title">${title}</div><div class="b-detail">${detail}</div></div></div>`;
    if (mode === 'none') {
      return banner('info', '公开仓库 · 不带任何凭据', '只适用于可匿名读取的仓库；推送或私有仓库会被远端拒绝。');
    }
    if (mode === 'custom') {
      return banner('info', '本目录专用 Token', '只对这个目录生效，会覆盖凭据库里的所有 Token。');
    }
    if (mode === 'credential') {
      const c = creds.find((x) => x.id === id);
      return c
        ? banner('info', `指定凭据：${esc(c.name)}`, `这个目录固定使用这条凭据（${esc(c.tokenPreview || '')}），不受自动匹配影响。`)
        : banner('warn', '请选择一条凭据', '到「设置 → Git 凭据库」添加，或改用「自动匹配」。');
    }
    if (!creds.length) {
      return banner('warn', '凭据库还是空的', '到「设置 → Git 凭据库」点「添加凭据」一键配置；也可以选「为此目录单独设置」。');
    }
    const def = creds.find((x) => x.id === g.defaultCredentialId);
    return banner('info', '自动按仓库域名匹配', `凭据库里有 ${creds.length} 条 Token。会先按 Git 地址域名挑${def ? `；匹配不到就用默认凭据「${esc(def.name)}」` : '；匹配不到建议设一条默认凭据'}。`);
  }

  const interval = p ? p.sync.intervalSec : 60;
  let unit = 'min';
  let amount = interval / 60;
  if (interval < 60) { unit = 'sec'; amount = interval; }
  else if (interval % 3600 === 0) { unit = 'hour'; amount = interval / 3600; }

  const html = `
    <div class="modal-head">
      <div>
        <div class="modal-title">${isNew ? '添加监控目录' : '编辑监控目录'}</div>
        <div class="modal-sub">${isNew ? '把本地文件夹和 Git 仓库关联起来' : esc(p.localDir)}</div>
      </div>
      <button class="icon-btn" data-close>${icon('x', 16)}</button>
    </div>
    <div class="modal-body">
      <div class="form-section">基本信息</div>
      <div class="field">
        <label>显示名称<span class="req">*</span></label>
        <input class="input" id="f-name" placeholder="例如：项目文档" value="${esc(p ? p.name : '')}" />
      </div>
      <div class="field">
        <label>本地目录<span class="req">*</span></label>
        <div class="input-row">
          <input class="input" id="f-localDir" placeholder="D:\\work\\myproject" value="${esc(p ? p.localDir : '')}" style="font-family:var(--mono);font-size:12px" />
          <button class="btn" id="btnPick">浏览…</button>
        </div>
        <div class="desc">目录本身就是 Git 仓库根目录。空目录会自动 clone；有文件的普通目录会初始化仓库并对齐远端历史。</div>
      </div>

      <div class="form-section">Git 仓库与凭据</div>
      <div class="field">
        <label>仓库地址<span class="req">*</span></label>
        <input class="input" id="f-remoteUrl" placeholder="https://github.com/user/repo.git" value="${esc(p ? p.remoteUrl : '')}" style="font-family:var(--mono);font-size:12px" />
        <div class="desc">必须是 HTTPS 地址。SSH 形式（git@…）无法使用 Token 认证。</div>
      </div>
      <div class="grid2">
        <div class="field">
          <label>分支<span class="req">*</span></label>
          <input class="input" id="f-branch" placeholder="main" value="${esc(p ? p.branch : 'main')}" />
        </div>
        <div class="field">
          <label>认证方式</label>
          <select class="select" id="f-authMode">
            <option value="global" ${authMode === 'global' ? 'selected' : ''}>自动匹配 / 使用默认 Token（推荐）</option>
            <option value="credential" ${authMode === 'credential' ? 'selected' : ''}>指定某条凭据</option>
            <option value="custom" ${authMode === 'custom' ? 'selected' : ''}>为此目录单独设置</option>
            <option value="none" ${authMode === 'none' ? 'selected' : ''}>公开仓库，无需认证</option>
          </select>
        </div>
      </div>
      <div id="authHint">${authHintHtml(authMode, credentialId)}</div>
      <div id="credentialPick" class="field" style="display:${authMode === 'credential' ? 'block' : 'none'}">
        <label>选择凭据（${esc(String(creds.length))} 条已保存）</label>
        <select class="select" id="f-credentialId">${credOptionsHtml(credentialId)}</select>
      </div>
      <div id="customAuthFields" style="display:${authMode === 'custom' ? 'block' : 'none'}">
        <div class="grid2">
          <div class="field">
            <label>本目录访问令牌 Token</label>
            <div class="input-row">
              <input class="input" id="f-token" type="password" placeholder="${hasProjectToken ? '已保存，留空则不修改' : 'ghp_xxx 或 glpat-xxx'}" autocomplete="off" />
              ${hasProjectToken ? '<button class="btn" id="btnClearProjectToken">清除</button>' : ''}
            </div>
          </div>
          <div class="field">
            <label>Token 用户名（可选）</label>
            <input class="input" id="f-username" placeholder="留空自动推断" value="${esc(p ? p.auth.username : '')}" />
          </div>
        </div>
        <div class="desc">
          GitHub 建议用 Personal Access Token（classic 勾选 repo，或 fine-grained 勾选 Contents 读写）。
          Token 会用 Windows DPAPI 加密后保存在本机，不会写进 .git/config。
        </div>
      </div>
      <div class="field">
        <button class="btn" id="btnTest" style="height:34px">测试连接（按上面的认证方式）</button>
      </div>
      <div class="test-result" id="testResult"></div>

      <div class="form-section">同步行为</div>
      <div class="field">
        <label>自动同步频率</label>
        <div class="input-row">
          <input class="input" id="f-interval" type="number" min="10" step="1" value="${amount}" style="max-width:110px" />
          <select class="select" id="f-unit" style="max-width:120px">
            <option value="sec" ${unit === 'sec' ? 'selected' : ''}>秒</option>
            <option value="min" ${unit === 'min' ? 'selected' : ''}>分钟</option>
            <option value="hour" ${unit === 'hour' ? 'selected' : ''}>小时</option>
          </select>
        </div>
        <div class="desc">最小 10 秒。文件变动时还会额外触发一次即时同步。</div>
      </div>
      <div class="grid2">
        <div class="field">
          <label>已跟踪文件的改动</label>
          <select class="select" id="f-trackedChangePolicy">
            <option value="auto" ${trackedAuto ? 'selected' : ''}>改了就自动上传（推荐）</option>
            <option value="confirm" ${!trackedAuto ? 'selected' : ''}>每次等我点「提交并推送」</option>
          </select>
          <div class="desc">已经同步过的文件，改了就自动提交并推送，不用反复确认。</div>
        </div>
        <div class="field">
          <label>本地新增文件</label>
          <select class="select" id="f-newFilePolicy">
            <option value="ask" ${((!p || p.sync.newFilePolicy !== 'auto') ? 'selected' : '')}>需要我确认才上传（推荐）</option>
            <option value="auto" ${p && p.sync.newFilePolicy === 'auto' ? 'selected' : ''}>全部自动纳入同步</option>
          </select>
          <div class="desc">只有新冒出来的文件才需确认，和上面的改动互不影响。</div>
        </div>
      </div>
      <div class="switch-row">
        <div class="switch-text">
          <div class="st">实时文件监控</div>
          <div class="sd">监听目录变化，改动后几秒内触发同步</div>
        </div>
        <button type="button" class="switch ${(!p || p.sync.watchFiles) ? 'on' : ''}" id="f-watchFiles"></button>
      </div>
      <div class="switch-row">
        <div class="switch-text">
          <div class="st">启用此项目</div>
          <div class="sd">关闭后停止自动同步</div>
        </div>
        <button type="button" class="switch ${(!p || p.enabled) ? 'on' : ''}" id="f-enabled"></button>
      </div>

      <div class="form-section">网络</div>
      <div class="field">
        <label>代理</label>
        <select class="select" id="f-proxyMode">
          <option value="inherit" ${(!p || p.proxy.mode === 'inherit') ? 'selected' : ''}>跟随全局设置（${esc(proxyLabel(g))}）</option>
          <option value="none" ${p && p.proxy.mode === 'none' ? 'selected' : ''}>直连，不使用代理</option>
          <option value="custom" ${p && p.proxy.mode === 'custom' ? 'selected' : ''}>为此项目单独设置</option>
        </select>
      </div>
      <div id="proxyFields" style="display:${p && p.proxy.mode === 'custom' ? 'block' : 'none'}">
        <div class="field">
          <input class="input" id="f-proxyUrl" placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7891" value="${esc(p ? p.proxy.url : '')}" style="font-family:var(--mono);font-size:12px" />
        </div>
      </div>

      <div class="form-section">忽略规则</div>
      <div class="switch-row compact">
        <div class="switch-text">
          <div class="st">自动忽略 Office / WPS 临时文件</div>
          <div class="sd">打开 Word、Excel、WPS 时生成的锁文件与备份不会被扫描，也不会被上传</div>
        </div>
        <button type="button" class="switch ${builtinOn ? 'on' : ''}" id="f-builtinIgnore"></button>
      </div>
      <div class="field">
        <label>内置规则（跟随上面的开关，自动生效）</label>
        <div class="rule-chips">${(state.builtinIgnoreRules || []).map((r) => `<span class="rule-chip">${esc(r)}</span>`).join('')}</div>
        <div class="desc">覆盖 <span class="mono-sm">~$xxx.docx</span>、<span class="mono-sm">~WRL*.tmp</span>、<span class="mono-sm">.~lock.*#</span>、<span class="mono-sm">*.tmp</span>、<span class="mono-sm">*.bak</span>、<span class="mono-sm">Thumbs.db</span> 等常见临时文件。</div>
      </div>
      <div class="field">
        <label>额外不参与同步的文件（每行一条）</label>
        <textarea class="textarea" id="f-exclude" placeholder="*.log&#10;node_modules/&#10;build/">${esc(p ? (p.exclude || []).join('\n') : '')}</textarea>
        <div class="desc">和内置规则一起写入 .git/info/exclude，不会提交到仓库、不影响其他人。已跟踪的文件不受忽略规则影响。</div>
      </div>

      <div class="field">
        <label>正则匹配</label>
        <select class="select" id="f-regexCase">
          <option value="i" ${(!p || !p.sync.regexCaseSensitive) ? 'selected' : ''}>不区分大小写</option>
          <option value="c" ${p && p.sync.regexCaseSensitive ? 'selected' : ''}>区分大小写</option>
        </select>
        <div class="desc">正则规则会同时匹配完整相对路径和文件名。</div>
      </div>
      <div class="field">
        <label>正则忽略规则（${esc(String((p && p.ignoreRegex || []).length))} 条）</label>
        <div class="rule-chips" id="f-ruleList">${ruleChipsHtml(p ? p.ignoreRegex : [])}</div>
        <div class="input-row" style="margin-top:8px">
          <button class="btn btn-sm" id="btnRegexTool">${icon('terminal', 13)} 正则快速匹配工具</button>
        </div>
        <div class="desc">输入文件名与正则，实时看匹配结果；匹配上才允许确认加入。</div>
      </div>
      <div id="regexTesterInline" style="display:none"></div>
    </div>
    <div class="modal-foot">
      ${!isNew ? `<button class="btn btn-danger btn-sm" id="btnDelete">${icon('trash', 13)} 删除</button>` : ''}
      <div class="left"></div>
      <button class="btn" data-close>取消</button>
      <button class="btn btn-primary" id="btnSave">${isNew ? '添加并开始监控' : '保存'}</button>
    </div>`;

  const { root, close } = openModal(html, { wide: true });

  const q = (sel) => root.querySelector(sel);
  const val = (sel) => q(sel).value.trim();

  const toggle = (sel) => q(sel).classList.toggle('on');

  q('#f-watchFiles').addEventListener('click', () => toggle('#f-watchFiles'));
  q('#f-enabled').addEventListener('click', () => toggle('#f-enabled'));
  q('#f-builtinIgnore').addEventListener('click', () => toggle('#f-builtinIgnore'));

  q('#f-ruleList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-rule]');
    if (!b || !p) return;
    await fileDecision(p.id, 'remove-rule', [], b.dataset.rule);
    const cur = getProject(p.id);
    q('#f-ruleList').innerHTML = ruleChipsHtml(cur ? cur.ignoreRegex : []);
  });

  q('#btnRegexTool').addEventListener('click', () => {
    if (!p) return toast('请先保存这个目录，再用正则工具', 'err');
    const box = q('#regexTesterInline');
    if (box.style.display === 'block') { box.style.display = 'none'; return; }
    box.style.display = 'block';
    if (!box.innerHTML) {
      const snap = getSnap(p.id);
      const preset = (snap.pendingNew || []).map((c) => c.path).slice(0, 8);
      box.innerHTML = `<div class="cred-editor">${regexTesterFragment(preset)}</div>`;
      bindRegexTester(box, p.id, {
        presetCase: !!p.sync.regexCaseSensitive,
        onAdded: () => {
          const cur = getProject(p.id);
          q('#f-ruleList').innerHTML = ruleChipsHtml(cur ? cur.ignoreRegex : []);
        },
      });
    }
  });

  q('#f-proxyMode').addEventListener('change', (e) => {
    q('#proxyFields').style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  let clearProjectToken = false;
  q('#f-authMode').addEventListener('change', (e) => {
    const mode = e.target.value;
    q('#customAuthFields').style.display = mode === 'custom' ? 'block' : 'none';
    q('#credentialPick').style.display = mode === 'credential' ? 'block' : 'none';
    q('#authHint').innerHTML = authHintHtml(mode, q('#f-credentialId').value);
    const box = q('#testResult');
    box.className = 'test-result';
    box.textContent = '';
  });
  q('#f-credentialId').addEventListener('change', (e) => {
    q('#authHint').innerHTML = authHintHtml(q('#f-authMode').value, e.target.value);
  });
  const clearProjectBtn = q('#btnClearProjectToken');
  if (clearProjectBtn) {
    clearProjectBtn.addEventListener('click', () => {
      clearProjectToken = true;
      q('#f-token').value = '';
      q('#f-token').placeholder = '已标记清除，点保存后生效';
      toast('已标记清除本目录 Token，点保存生效');
    });
  }

  q('#btnPick').addEventListener('click', async () => {
    const dir = await rpc.pickFolder(val('#f-localDir') || undefined);
    if (dir) {
      q('#f-localDir').value = dir;
      if (!val('#f-name')) {
        q('#f-name').value = dir.split(/[\\/]/).filter(Boolean).pop() || '未命名';
      }
    }
  });

  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));

  q('#btnTest').addEventListener('click', async () => {
    const box = q('#testResult');
    box.className = 'test-result';
    box.textContent = '正在连接…';
    const mode = q('#f-authMode').value;
    try {
      const res = await rpc.project.test({
        id: p ? p.id : undefined,
        remoteUrl: val('#f-remoteUrl'),
        auth: {
          mode,
          credentialId: mode === 'credential' ? q('#f-credentialId').value : '',
          username: mode === 'custom' ? val('#f-username') : '',
          token: mode === 'custom' ? val('#f-token') : '',
        },
        proxy: {
          mode: q('#f-proxyMode').value,
          url: val('#f-proxyUrl'),
        },
      });
      box.className = 'test-result ok';
      const branches = res.branches || [];
      if (branches.length) {
        box.innerHTML = `连接成功，远端有 ${branches.length} 个分支：${branches.slice(0, 10).map((b) => `<b>${esc(b)}</b>`).join('、')}${branches.length > 10 ? ' …' : ''}`;
        if (branches.length === 1 && !branches.includes(val('#f-branch'))) {
          q('#f-branch').value = branches[0];
        }
      } else {
        box.textContent = '连接成功（仓库为空，还没有分支）';
      }
    } catch (err) {
      box.className = 'test-result bad';
      box.textContent = err.message || '连接失败';
    }
  });

  q('#btnSave').addEventListener('click', () => {
    const unitSel = val('#f-unit');
    const mult = unitSel === 'sec' ? 1 : unitSel === 'min' ? 60 : 3600;
    const intervalSec = Math.max(10, Math.round((Number(val('#f-interval')) || 1) * mult));
    const mode = q('#f-authMode').value;

    const payload = {
      id: p ? p.id : undefined,
      name: val('#f-name'),
      localDir: val('#f-localDir'),
      remoteUrl: val('#f-remoteUrl'),
      branch: val('#f-branch') || 'main',
      enabled: q('#f-enabled').classList.contains('on'),
      auth: {
        mode,
        credentialId: mode === 'credential' ? q('#f-credentialId').value : '',
        username: mode === 'custom' ? val('#f-username') : '',
      },
      proxy: { mode: q('#f-proxyMode').value, url: val('#f-proxyUrl') },
      sync: {
        intervalSec,
        trackedChangePolicy: q('#f-trackedChangePolicy').value,
        // 底层字段同步到一致状态，兼容旧版读取
        pushMode: q('#f-trackedChangePolicy').value === 'auto' ? 'auto' : 'confirm',
        autoCommit: q('#f-trackedChangePolicy').value === 'auto',
        watchFiles: q('#f-watchFiles').classList.contains('on'),
        builtinIgnore: q('#f-builtinIgnore').classList.contains('on'),
        newFilePolicy: q('#f-newFilePolicy').value,
        regexCaseSensitive: q('#f-regexCase').value === 'c',
      },
      exclude: val('#f-exclude').split('\n').map((s) => s.trim()).filter(Boolean),
    };

    // 只有「为此目录单独设置」才提交项目自己的 token；其余模式不带明文凭据
    if (mode === 'custom' && val('#f-token')) payload.auth.token = val('#f-token');
    if (clearProjectToken) payload.auth.clearToken = true;

    if (!payload.name) payload.name = (payload.localDir || '').split(/[\\/]/).filter(Boolean).pop() || '未命名';

    withPending('save', async () => {
      state.config = await rpc.project.save(payload);
      const saved = state.config.projects.find((x) => x.localDir === payload.localDir) || state.config.projects.slice(-1)[0];
      if (saved) state.activeId = saved.id;
      close();
      render();
      toast('已保存，开始监控', 'ok');
      if (saved) {
        rpc.project.inspect(saved.id).catch(() => {});
      }
    }).catch(() => {});
  });

  const del = q('#btnDelete');
  if (del) {
    del.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '删除这个监控项目？',
        message: `将停止监控「${p.name}」。本地目录和 Git 仓库都不会被删除。`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      await withPending('delete', async () => {
        state.config = await rpc.project.remove(p.id);
        if (state.activeId === p.id) state.activeId = projects()[0] ? projects()[0].id : null;
        close();
        render();
        toast('已删除', 'ok');
      });
    });
  }

  setTimeout(() => q('#f-remoteUrl').focus(), 60);
}

function proxyLabel(g) {
  if (g.proxyMode === 'custom' && g.proxyUrl) return g.proxyUrl;
  return '不使用代理';
}

// ---------- 设置 ----------
function openSettingsModal() {
  const g = state.config.globals;
  const ga = g.auth || {};
  const gitOk = state.git && state.git.ok;

  const html = `
    <div class="modal-head">
      <div>
        <div class="modal-title">设置</div>
        <div class="modal-sub">FileSharing ${esc(state.version)} · ${esc(state.hostname)}</div>
      </div>
      <button class="icon-btn" data-close>${icon('x', 16)}</button>
    </div>
    <div class="modal-body">
      <div class="form-section">Git 环境</div>
      <div class="field">
        <label>Git 可执行文件</label>
        <div class="input-row">
          <input class="input" id="g-gitPath" placeholder="留空 = 使用随程序内置的 Git" value="${esc(g.gitPath || '')}" style="font-family:var(--mono);font-size:12px" />
          <button class="btn" id="btnCheckGit">检测</button>
        </div>
        <div class="desc ${gitOk ? '' : 'test-result bad'}">
          ${gitOk
            ? `已检测到：${esc(state.git.version)}　·　来源：${state.git.bundled ? '<b>内置 Git（无需另装任何东西）</b>' : '外部 Git'}`
            : '无法运行，请填写本机 git.exe 的完整路径'}
        </div>
        <div class="desc">程序已自带完整 Git 运行时，目标机器<b>不需要安装 Git 或 Node.js</b>。只有你想改用系统 Git 时，才在这里填完整路径。</div>
      </div>

      <div class="form-section">Git 凭据库（可保存多个 Token）</div>
      <div class="cred-intro">
        不同平台 / 不同账号可以各存一条。新增监控目录时按仓库域名自动挑一条；
        也可以给某个目录指定固定凭据。Token 用 Windows DPAPI 加密后保存在本机，
        不会写进 <span class="mono-sm">.git/config</span>。
      </div>
      <div class="switch-row compact">
        <div class="switch-text">
          <div class="st">自动按仓库域名匹配</div>
          <div class="sd">例如 github.com 用 GitHub 的 Token，git.corp.com 用公司 GitLab 的 Token；匹配不到就用默认凭据</div>
        </div>
        <button type="button" class="switch ${g.autoMatchCredential !== false ? 'on' : ''}" id="g-autoMatch"></button>
      </div>
      <div class="cred-list" id="credList"></div>
      <div class="input-row cred-toolbar">
        <button class="btn" id="btnAddCred">${icon('plus', 13)} 添加凭据</button>
        <button class="btn btn-primary" id="btnApplyAll">${icon('check', 13)} 一键应用到全部目录</button>
      </div>
      <div id="credEditor" style="display:none"></div>
      <div class="banner ${(g.credentials || []).length ? 'info' : 'warn'}" id="credBanner" style="margin-bottom:14px">
        ${icon('info', 16)}
        <div class="grow">
          <div class="b-title" id="credBannerTitle"></div>
          <div class="b-detail">GitHub：Settings → Developer settings → Personal access tokens，
            classic 勾选 repo，或 fine-grained 勾选 Contents 读写；GitLab 勾 read_repository + write_repository。</div>
        </div>
      </div>

      <div class="form-section">网络代理</div>
      <div class="field">
        <label>默认代理</label>
        <select class="select" id="g-proxyMode">
          <option value="none" ${g.proxyMode === 'none' ? 'selected' : ''}>不使用代理（直连）</option>
          <option value="custom" ${g.proxyMode === 'custom' ? 'selected' : ''}>自定义代理</option>
        </select>
        <div class="desc">访问 GitHub 时通常需要设置。支持 http:// 与 socks5:// 协议。</div>
      </div>
      <div id="gProxyFields" style="display:${g.proxyMode === 'custom' ? 'block' : 'none'}">
        <div class="field">
          <input class="input" id="g-proxyUrl" placeholder="http://127.0.0.1:7890" value="${esc(g.proxyUrl || '')}" style="font-family:var(--mono);font-size:12px" />
        </div>
        <div class="grid2">
          <div class="field"><input class="input" id="g-proxyUser" placeholder="代理用户名（可选）" value="${esc(g.proxyUser || '')}" /></div>
          <div class="field"><input class="input" id="g-proxyPass" type="password" placeholder="${g.hasProxyPass ? '已保存，留空不修改' : '代理密码（可选）'}" /></div>
        </div>
      </div>

      <div class="form-section">运行方式</div>
      <div class="switch-row">
        <div class="switch-text">
          <div class="st">开机自动启动</div>
          <div class="sd">登录 Windows 后在后台启动并开始监控</div>
        </div>
        <button type="button" class="switch ${g.startAtLogin ? 'on' : ''}" id="g-startAtLogin"></button>
      </div>
      <div class="switch-row">
        <div class="switch-text">
          <div class="st">关闭窗口时最小化到托盘</div>
          <div class="sd">关闭后继续在后台同步，可从托盘图标重新打开</div>
        </div>
        <button type="button" class="switch ${g.closeToTray ? 'on' : ''}" id="g-closeToTray"></button>
      </div>
      <div class="switch-row">
        <div class="switch-text">
          <div class="st">启动时隐藏窗口</div>
          <div class="sd">开机启动时不弹出界面</div>
        </div>
        <button type="button" class="switch ${g.startMinimized ? 'on' : ''}" id="g-startMinimized"></button>
      </div>

      <div class="form-section">安全</div>
      <div class="banner ${state.secureStorage ? 'info' : 'warn'}" style="margin-top:0">
        ${icon('info', 16)}
        <div class="grow">
          <div class="b-title">${state.secureStorage ? 'Token 已使用系统加密存储' : '当前环境不支持系统加密'}</div>
          <div class="b-detail">${state.secureStorage
            ? 'Token 通过 Windows DPAPI 加密后保存在本机配置中，仅当前 Windows 用户可解密。'
            : 'Token 以编码形式保存。请勿把配置目录分享给他人。'}</div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost btn-sm" id="btnOpenLogs">${icon('folder', 13)} 日志目录</button>
      <div class="left"></div>
      <button class="btn" data-close>取消</button>
      <button class="btn btn-primary" id="btnSaveSettings">保存</button>
    </div>`;

  const { root, close } = openModal(html, { wide: true });
  const q = (s) => root.querySelector(s);
  const val = (s) => q(s).value.trim();

  // 渲染层只持有脱敏信息；token 字段仅表示「本次输入的新值」，空 = 沿用已保存的
  let credDraft = (g.credentials || []).map((c) => ({
    id: c.id, name: c.name, host: c.host, username: c.username,
    hasToken: c.hasToken, tokenPreview: c.tokenPreview, token: '',
  }));
  let defaultId = g.defaultCredentialId || '';

  const newId = () => `cred-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  function renderCreds() {
    const list = q('#credList');
    if (!credDraft.length) {
      list.innerHTML = '<div class="cred-empty">还没有保存任何 Token。点「添加凭据」，或先到 GitHub / GitLab 生成一个。</div>';
    } else {
      list.innerHTML = credDraft.map((c) => `
        <div class="cred-row ${c.id === defaultId ? 'is-default' : ''}" data-id="${esc(c.id)}">
          <div class="cred-main">
            <div class="cred-name">${esc(c.name || '未命名凭据')}
              ${c.id === defaultId ? '<span class="cred-badge">默认</span>' : ''}</div>
            <div class="cred-sub">
              ${c.host ? `<span>适用 <b>${esc(c.host)}</b></span>` : '<span>通用</span>'}
              <span>·</span><span>${c.username ? `用户 ${esc(c.username)}` : '用户名自动推断'}</span>
              <span>·</span><span class="mono">${esc(c.tokenPreview || '未保存')}</span>
            </div>
          </div>
          <div class="cred-actions">
            ${c.id === defaultId ? '' : '<button class="btn btn-xs" data-act="default">设为默认</button>'}
            <button class="btn btn-xs" data-act="apply">应用到全部</button>
            <button class="btn btn-xs" data-act="edit">编辑</button>
            <button class="btn btn-xs btn-danger" data-act="del">删除</button>
          </div>
        </div>`).join('');
    }
    const banner = q('#credBanner');
    banner.className = `banner ${credDraft.length ? 'info' : 'warn'}`;
    q('#credBannerTitle').textContent = credDraft.length
      ? `已保存 ${credDraft.length} 条凭据${defaultId ? ' · 默认凭据已设置' : ' · 建议把常用的一条设为默认'}`
      : '还没有配置任何 Token';
  }

  /** 凭据库的增删改都是「点一下立即生效」，不需要再等设置页底部的保存 */
  async function persistCreds() {
    const patch = {
      credentials: credDraft.map((c) => ({
        id: c.id, name: c.name, host: c.host, username: c.username, token: c.token || '',
      })),
      defaultCredentialId: defaultId,
      autoMatchCredential: q('#g-autoMatch').classList.contains('on'),
    };
    try {
      state.config = await rpc.saveGlobals(patch);
      credDraft = (state.config.globals.credentials || []).map((c) => ({
        id: c.id, name: c.name, host: c.host, username: c.username,
        hasToken: c.hasToken, tokenPreview: c.tokenPreview, token: '',
      }));
      defaultId = state.config.globals.defaultCredentialId || '';
      renderCreds();
      return true;
    } catch (err) {
      toast(err.message || '凭据保存失败', 'err');
      return false;
    }
  }

  function openCredEditor(id) {
    const c = id ? credDraft.find((x) => x.id === id) : null;
    const box = q('#credEditor');
    box.style.display = 'block';
    box.innerHTML = `
      <div class="cred-editor">
        <div class="ce-title">${c ? '编辑凭据' : '添加凭据'}</div>
        <div class="grid2">
          <div class="field">
            <label>名称<span class="req">*</span></label>
            <input class="input" id="c-name" placeholder="例如：GitHub 个人 / 公司 GitLab" value="${esc(c ? c.name : '')}" />
          </div>
          <div class="field">
            <label>适用域名（可选）</label>
            <input class="input" id="c-host" placeholder="github.com / git.corp.com" value="${esc(c ? c.host : '')}" />
          </div>
        </div>
        <div class="grid2">
          <div class="field">
            <label>访问令牌 Token<span class="req">*</span></label>
            <input class="input" id="c-token" type="password" autocomplete="off"
                   placeholder="${c && c.hasToken ? `已保存 ${esc(c.tokenPreview)}，留空则不修改` : 'ghp_xxx 或 glpat-xxx'}" />
          </div>
          <div class="field">
            <label>Token 用户名（可选）</label>
            <input class="input" id="c-username" placeholder="留空自动推断" value="${esc(c ? c.username : '')}" />
          </div>
        </div>
        <label class="cred-check"><input type="checkbox" id="c-default" ${(!c || c.id === defaultId) ? 'checked' : ''} /> 设为默认凭据（域名匹配不到时用它）</label>
        <div class="input-row">
          <button class="btn btn-primary btn-sm" id="c-save">保存凭据</button>
          <button class="btn btn-sm" id="c-cancel">取消</button>
        </div>
      </div>`;

    q('#c-save').addEventListener('click', async () => {
      const name = q('#c-name').value.trim();
      const token = q('#c-token').value.trim();
      const host = q('#c-host').value.trim();
      const username = q('#c-username').value.trim();
      if (!name) return toast('请给这条凭据起个名字', 'err');
      if (!c && !token) return toast('请填写 Token', 'err');
      const item = {
        id: c ? c.id : newId(),
        name, host, username, token,
        hasToken: c ? c.hasToken : false,
        tokenPreview: c ? c.tokenPreview : '',
      };
      credDraft = c
        ? credDraft.map((x) => (x.id === c.id ? item : x))
        : [...credDraft, item];
      if (q('#c-default').checked) defaultId = item.id;
      else if (defaultId === item.id) defaultId = '';
      const ok = await persistCreds();
      if (!ok) return;
      box.style.display = 'none';
      box.innerHTML = '';
      toast(c ? '凭据已更新' : '凭据已添加并加密保存', 'ok');
      render();
    });
    q('#c-cancel').addEventListener('click', () => { box.style.display = 'none'; box.innerHTML = ''; });
    setTimeout(() => q('#c-name').focus(), 40);
  }

  async function applyAll(id) {
    const targetId = id || defaultId || (credDraft[0] && credDraft[0].id);
    if (!targetId) return toast('请先添加一条凭据', 'err');
    if (credDraft.some((c) => c.token)) {
      const ok = await persistCreds();
      if (!ok) return;
    }
    const c = (state.config.globals.credentials || []).find((x) => x.id === targetId);
    if (!c) return toast('这条凭据还没有保存，请先点「保存凭据」', 'err');
    try {
      state.config = await rpc.applyCredential(targetId);
      render();
      toast(`已把「${c.name}」一键应用到全部 ${state.config.projects.length} 个目录`, 'ok');
    } catch (err) {
      toast(err.message || '应用失败', 'err');
    }
  }

  q('#credList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.cred-row');
    const id = row && row.dataset.id;
    const c = credDraft.find((x) => x.id === id);
    if (!c) return;
    const act = btn.dataset.act;
    if (act === 'edit') { openCredEditor(id); return; }
    if (act === 'default') {
      defaultId = id;
      await persistCreds();
      toast(`已把「${c.name}」设为默认`, 'ok');
      return;
    }
    if (act === 'del') {
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.textContent = '确认删除？';
        setTimeout(() => {
          if (btn.isConnected && btn.dataset.confirm === '1') {
            btn.dataset.confirm = '';
            btn.textContent = '删除';
          }
        }, 4000);
        return;
      }
      credDraft = credDraft.filter((x) => x.id !== id);
      if (defaultId === id) defaultId = credDraft[0] ? credDraft[0].id : '';
      await persistCreds();
      toast('凭据已删除', 'ok');
      render();
      return;
    }
    if (act === 'apply') await applyAll(id);
  });

  q('#btnAddCred').addEventListener('click', () => openCredEditor(null));
  q('#btnApplyAll').addEventListener('click', () => applyAll());
  q('#g-autoMatch').addEventListener('click', (e) => {
    e.currentTarget.classList.toggle('on');
    persistCreds();
  });

  q('#g-proxyMode').addEventListener('change', (e) => {
    q('#gProxyFields').style.display = e.target.value === 'custom' ? 'block' : 'none';
  });

  q('#g-startAtLogin').addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));
  q('#g-closeToTray').addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));
  q('#g-startMinimized').addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));

  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));

  q('#btnCheckGit').addEventListener('click', async () => {
    const desc = q('#btnCheckGit').parentElement.parentElement.querySelector('.desc');
    desc.textContent = '检测中…';
    desc.className = 'desc';
    try {
      state.config = await rpc.saveGlobals({ gitPath: val('#g-gitPath') });
      const info = await rpc.checkGit();
      state.git = info;
      desc.innerHTML = info.ok
        ? `已检测到：${esc(info.version)}　·　来源：${info.bundled ? '<b>内置 Git</b>' : '外部 Git'}`
        : esc(info.message);
      desc.className = info.ok ? 'desc' : 'test-result bad';
      renderSidebar();
    } catch (err) {
      desc.textContent = err.message;
      desc.className = 'test-result bad';
    }
  });

  q('#btnOpenLogs').addEventListener('click', () => rpc.openLogs());

  q('#btnSaveSettings').addEventListener('click', async () => {
    const patch = {
      gitPath: val('#g-gitPath'),
      proxyMode: q('#g-proxyMode').value,
      proxyUrl: val('#g-proxyUrl'),
      proxyUser: val('#g-proxyUser'),
      autoMatchCredential: q('#g-autoMatch').classList.contains('on'),
      startAtLogin: q('#g-startAtLogin').classList.contains('on'),
      closeToTray: q('#g-closeToTray').classList.contains('on'),
      startMinimized: q('#g-startMinimized').classList.contains('on'),
    };
    const pass = val('#g-proxyPass');
    if (pass) patch.proxyPass = pass;

    await withPending('settings', async () => {
      state.config = await rpc.saveGlobals(patch);
      close();
      render();
      toast('设置已保存', 'ok');
    });
  });

  renderCreds();
}

// ---------- 确认框 ----------
function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const html = `
      <div class="modal-head">
        <div>
          <div class="modal-title">${esc(title)}</div>
          <div class="modal-sub">${esc(message)}</div>
        </div>
      </div>
      <div class="modal-foot">
        <div class="left"></div>
        <button class="btn" data-no>取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(confirmText)}</button>
      </div>`;
    const { root, close } = openModal(html, { dismissible: false });
    root.querySelector('[data-yes]').addEventListener('click', () => { close(); resolve(true); });
    root.querySelector('[data-no]').addEventListener('click', () => { close(); resolve(false); });
  });
}

// ---------- 事件 ----------
const contentEl = $('#content');

contentEl.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;
  const file = el.dataset.file;

  switch (action) {
    case 'add':
      openProjectModal(null);
      break;
    case 'edit':
      openProjectModal(id);
      break;
    case 'credentials':
      openSettingsModal();
      break;
    case 'accept-new':
      await fileDecision(id, 'accept', [file]);
      toast('已确认上传，点「提交并推送」即可同步', 'ok');
      break;
    case 'accept-all-new': {
      const snap = getSnap(id);
      const all = (snap.pendingNew || []).map((c) => c.path);
      if (!all.length) break;
      await fileDecision(id, 'accept', all);
      toast(`已确认 ${all.length} 个新文件`, 'ok');
      break;
    }
    case 'ignore-new': {
      openRegexTesterModal(id, [file]);
      const box = document.querySelector('#rx-pattern');
      if (box) { box.value = suggestRegex(file); box.dispatchEvent(new Event('input', { bubbles: true })); }
      break;
    }
    case 'regex-tool': {
      const snap = getSnap(id);
      const preset = (snap.pendingNew || []).map((c) => c.path).slice(0, 8);
      openRegexTesterModal(id, preset.length ? preset : ['example.tmp', 'docs/example.docx']);
      break;
    }
    case 'untrack': {
      const ok = await confirmDialog({
        title: '停止追踪这个文件？',
        message: `「${file}」会从 Git 索引移除（本地文件保留），下次提交后远端也会删除它。之后不再同步这个文件。`,
        confirmText: '停止追踪',
        danger: true,
      });
      if (!ok) break;
      await fileDecision(id, 'untrack', [file]);
      toast('已停止追踪，本地文件保留', 'ok');
      break;
    }
    case 'sync':
      await withPending('sync:' + id, async () => {
        const snap = await rpc.project.sync(id);
        state.snapshots.set(id, snap);
        if (snap.phase === 'conflict') toast(`检测到 ${snap.conflicts.length} 个冲突，请处理`, 'err');
        else if (snap.phase === 'error') toast(snap.lastError, 'err');
        else toast('同步完成', 'ok');
      });
      break;
    case 'push':
      await withPending('push:' + id, async () => {
        await rpc.project.push(id);
        toast('已推送', 'ok');
        const snap = await rpc.project.inspect(id);
        state.snapshots.set(id, snap);
      });
      break;
    case 'commit-push': {
      const p = getProject(id);
      const snap = getSnap(id);
      const ok = await confirmDialog({
        title: '提交并推送到远端？',
        message: `将提交 ${snap.changes ? snap.changes.length : 0} 个本地改动，并推送到 origin/${p.branch}。若远端在此期间有新提交，会自动先合并。`,
        confirmText: '提交并推送',
      });
      if (!ok) break;
      await withPending('commit:' + id, async () => {
        const result = await rpc.project.commitPush(id, null);
        state.snapshots.set(id, result);
        if (result.phase === 'conflict') toast('合并时产生冲突，请处理', 'err');
        else if (result.phase === 'error') toast(result.lastError, 'err');
        else toast('已推送', 'ok');
      });
      break;
    }
    case 'discard': {
      const ok = await confirmDialog({
        title: '丢弃本地改动？',
        message: '已跟踪文件的所有未提交修改都会被还原到上次提交的状态，无法撤销。未跟踪的新文件不受影响。',
        confirmText: '丢弃改动',
        danger: true,
      });
      if (!ok) break;
      await withPending('discard:' + id, async () => {
        const snap = await rpc.project.discard(id);
        state.snapshots.set(id, snap);
        toast('已还原', 'ok');
      });
      break;
    }
    case 'toggle': {
      const p = getProject(id);
      await withPending('toggle:' + id, async () => {
        state.config = await rpc.project.save({ ...p, enabled: !p.enabled });
        render();
        toast(!p.enabled ? '已恢复监控' : '已暂停监控', 'ok');
      });
      break;
    }
    case 'open-folder':
      await rpc.openPath(getProject(id).localDir);
      break;
    case 'open-file':
    case 'open-conflict':
      await rpc.project.openFile(id, file);
      break;
    case 'show-file':
      await rpc.project.showFile(id, file);
      break;
    case 'resolve-ours':
    case 'resolve-theirs': {
      const strategy = action === 'resolve-ours' ? 'ours' : 'theirs';
      await withPending('resolve:' + id + file, async () => {
        const res = await rpc.project.resolve(id, file, strategy);
        const snap = await rpc.project.inspect(id);
        state.snapshots.set(id, snap);
        if (!res.conflicts.length) toast('全部冲突已处理，可以完成合并', 'ok');
      });
      break;
    }
    case 'finish-merge':
      await withPending('finish:' + id, async () => {
        const snap = await rpc.project.finishMerge(id, null);
        state.snapshots.set(id, snap);
        if (snap.phase === 'conflict') toast('仍有冲突未解决', 'err');
        else if (snap.phase === 'ahead') toast('合并完成，提交待推送', 'ok');
        else toast('合并完成', 'ok');
      });
      break;
    case 'abort-merge': {
      const ok = await confirmDialog({
        title: '放弃本次合并？',
        message: '本次合并的所有改动都会被撤销，回到合并前状态。',
        confirmText: '放弃合并',
        danger: true,
      });
      if (!ok) break;
      await withPending('abort:' + id, async () => {
        const snap = await rpc.project.abortMerge(id);
        state.snapshots.set(id, snap);
        toast('已放弃合并', 'ok');
      });
      break;
    }
    case 'open-logs':
      await rpc.openLogs();
      break;
    default:
      break;
  }
});

contentEl.addEventListener('error', () => {}, true);

$('#projectList').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action="select"]');
  if (!el) return;
  state.activeId = el.dataset.id;
  render();
  rpc.project.inspect(el.dataset.id).catch(() => {});
});

$('#btnAdd').addEventListener('click', () => openProjectModal(null));
$('#btnSettings').addEventListener('click', () => openSettingsModal());
$('#btnSyncAll').addEventListener('click', async () => {
  await withPending('syncAll', async () => {
    await rpc.syncAll();
    const ps = projects();
    for (const p of ps) {
      try {
        const snap = await rpc.project.inspect(p.id);
        state.snapshots.set(p.id, snap);
      } catch (_) { /* ignore */ }
    }
    render();
    const conflicts = ps.reduce((n, p) => n + (getSnap(p.id).conflicts || []).length, 0);
    toast(conflicts ? `同步完成，${conflicts} 个冲突待处理` : '全部同步完成', conflicts ? 'err' : 'ok');
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.modal) state.modal.close();
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault();
    openProjectModal(null);
  }
});

// ---------- 事件订阅 ----------
rpc.onEngineUpdate((payload) => {
  state.snapshots.set(payload.projectId, payload);
  if (payload.phase === 'error' && payload.lastError) {
    // 只在项目处于焦点时提示，避免多项目刷屏
    if (payload.projectId === state.activeId) toast(payload.lastError, 'err');
  }
  render();
});

rpc.onLog((entry) => {
  state.logs.push(entry);
  if (state.logs.length > 500) state.logs.shift();
  // 仅在看到日志面板时增量追加，避免整页重绘
  const list = document.getElementById('logList');
  if (list && !state.modal) {
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const row = document.createElement('div');
    row.className = 'log-line';
    row.innerHTML = `<span class="log-time">${esc(fmtTime(entry.ts))}</span>
      <span class="log-level ${esc(entry.level)}">${esc(entry.level.toUpperCase())}</span>
      <span class="log-msg">${esc(entry.msg)}</span>`;
    list.appendChild(row);
    while (list.children.length > 120) list.removeChild(list.firstChild);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
});

rpc.onFocusProject((id) => {
  state.activeId = id;
  render();
});

// ---------- 启动 ----------
async function boot() {
  try {
    const data = await rpc.init();
    state.config = data.config;
    state.git = data.git;
    state.logs = data.logs || [];
    state.version = data.version;
    state.secureStorage = data.secureStorage;
    state.hostname = data.hostname;
    state.builtinIgnoreRules = data.builtinIgnoreRules || [];

    for (const s of data.snapshots || []) state.snapshots.set(s.projectId, s);
    if (state.config.projects.length) {
      state.activeId = state.snapshots.size
        ? [...state.snapshots.keys()][0]
        : state.config.projects[0].id;
    }

    $('#deviceLabel').textContent = `${state.hostname} · ${state.config.projects.length} 个目录`;
    render();

    if (!state.git.ok) {
      toast('未检测到 Git，请到设置里指定 git 路径', 'err');
    }
  } catch (err) {
    $('#content').innerHTML = `<div class="empty"><h2>启动失败</h2><p>${esc(err.message)}</p></div>`;
  }
}

boot();
