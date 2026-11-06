'use strict';

const fs = require('fs');
const path = require('path');
const ignore = require('./ignore');

/**
 * 调度器：统一维护所有项目的定时同步 + 文件改动触发。
 * 使用单一 1s tick，避免为每个项目创建大量 timer。
 */
class Scheduler {
  constructor({ getEngines, logger, getGlobals }) {
    this.getEngines = getEngines;
    this.logger = logger;
    this.getGlobals = getGlobals;
    this.timer = null;
    this.watchers = new Map();   // projectId -> FSWatcher
    this.runtime = new Map();    // projectId -> { lastAttempt, watchAt, suppressUntil }
    this.paused = false;
  }

  _rt(id) {
    if (!this.runtime.has(id)) {
      this.runtime.set(id, { lastAttempt: 0, watchAt: 0, suppressUntil: 0, lastWatchKey: '' });
    }
    return this.runtime.get(id);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), 1000);
    this.refreshWatchers();
    this.logger.info('scheduler', '调度器已启动');
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) {
      try { w.close(); } catch (_) { /* ignore */ }
    }
    this.watchers.clear();
  }

  pause() { this.paused = true; }
  resume() {
    this.paused = false;
    // 恢复时把所有项目的计时清零，尽快补一次同步
    for (const [id] of this.runtime) {
      const rt = this._rt(id);
      rt.lastAttempt = 0;
    }
  }

  /** 项目新增/修改/删除后调用，重建文件监控 */
  refreshWatchers() {
    const engines = this.getEngines();
    const alive = new Set(engines.keys());

    for (const [id, w] of this.watchers) {
      if (!alive.has(id)) {
        try { w.close(); } catch (_) { /* ignore */ }
        this.watchers.delete(id);
      }
    }

    for (const [id, engine] of engines) {
      const p = engine.project;
      const want = p.enabled && p.sync.watchFiles && p.localDir && fs.existsSync(p.localDir);
      if (!want) {
        const w = this.watchers.get(id);
        if (w) {
          try { w.close(); } catch (_) { /* ignore */ }
          this.watchers.delete(id);
        }
        continue;
      }
      if (!this.watchers.has(id)) this._watch(id, engine);
    }
  }

  _watch(id, engine) {
    const dir = engine.project.localDir;
    let w;
    try {
      w = fs.watch(dir, { recursive: true, persistent: false }, (_evt, filename) => {
        if (!filename) return;
        const norm = String(filename).replace(/\\/g, '/');
        if (norm === '.git' || norm.startsWith('.git/')) return;
        // Word / WPS 打开文档会生成 ~$xxx.docx 之类锁文件，
        // 直接在监控层丢掉，避免「打开文档 → 触发一次无谓同步」
        if (ignore.builtinEnabled(engine.project) && ignore.isTransientPath(norm)) return;
        const rt = this._rt(id);
        if (Date.now() < rt.suppressUntil) return;
        rt.watchAt = Date.now();
        rt.lastWatchKey = norm;
      });
      this.watchers.set(id, w);
      w.on('error', () => {
        try { w.close(); } catch (_) { /* ignore */ }
        this.watchers.delete(id);
      });
    } catch (err) {
      this.logger.warn('scheduler', `无法监控 ${dir}：${err.message}（降级为定时轮询）`);
    }
  }

  /** 同步完成后压制文件事件，避免自己写盘触发下一轮 */
  suppress(id, ms = 4000) {
    const rt = this._rt(id);
    rt.suppressUntil = Date.now() + ms;
    rt.watchAt = 0;
  }

  _tick() {
    if (this.paused) return;
    const now = Date.now();
    for (const [id, engine] of this.getEngines()) {
      const p = engine.project;
      if (!p.enabled) continue;
      if (engine.state.busy) continue;
      if (!p.localDir || !p.remoteUrl) continue;

      const rt = this._rt(id);
      const interval = Math.max(10, Number(p.sync.intervalSec) || 60) * 1000;

      // 文件改动触发（防抖 2s）
      if (rt.watchAt && now - rt.watchAt >= 2000) {
        rt.watchAt = 0;
        if (now - rt.lastAttempt >= 3000) {
          rt.lastAttempt = now;
          this._run(id, engine, 'file-change');
          continue;
        }
      }

      if (now - rt.lastAttempt >= interval) {
        rt.lastAttempt = now;
        this._run(id, engine, 'interval');
      }
    }
  }

  async _run(id, engine, trigger) {
    try {
      const before = engine.state.phase;
      const snap = await engine.syncNow({ manual: false });
      this.suppress(id, 5000);
      // 有实际变化时打一行日志，避免刷屏
      if (before !== snap.phase && snap.phase !== 'synced') {
        this.logger.info('scheduler', `${engine.project.name}：${before} → ${snap.phase}（${trigger}）`);
      }
    } catch (err) {
      this.logger.error('scheduler', `${engine.project.name} 同步异常：${err.message}`);
    }
  }

  /** 立即对所有项目触发一次同步 */
  async syncAll() {
    const results = [];
    for (const [, engine] of this.getEngines()) {
      if (!engine.project.enabled) continue;
      const rt = this._rt(engine.project.id);
      rt.lastAttempt = Date.now();
      try {
        results.push(await engine.syncNow({ manual: true }));
      } catch (err) {
        this.logger.error('scheduler', err.message);
      }
    }
    return results;
  }
}

module.exports = { Scheduler };
