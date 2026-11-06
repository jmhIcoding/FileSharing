'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RING_SIZE = 600;

/**
 * 应用日志：内存环形缓冲 + 按大小滚动的文件日志。
 */
class Logger {
  constructor(logDir, { level = 'info' } = {}) {
    this.dir = logDir;
    this.level = level;
    this.buffer = [];
    this.listeners = new Set();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (_) { /* ignore */ }
  }

  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(entry) {
    this.buffer.push(entry);
    if (this.buffer.length > RING_SIZE) this.buffer.shift();
    for (const fn of this.listeners) {
      try { fn(entry); } catch (_) { /* ignore */ }
    }
    const line = `${entry.ts} [${entry.level.toUpperCase()}]${entry.scope ? ` (${entry.scope})` : ''} ${entry.msg}\n`;
    this._write(line);
  }

  _write(line) {
    const file = path.join(this.dir, `app-${new Date().toISOString().slice(0, 10)}.log`);
    try {
      const st = fs.existsSync(file) ? fs.statSync(file) : null;
      if (st && st.size > MAX_FILE_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch (_) { /* ignore */ }
    fs.appendFile(file, line, () => {});
  }

  _log(level, scope, msg) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope: scope || '',
      msg: typeof msg === 'string' ? msg : String(msg),
    };
    this._emit(entry);
    return entry;
  }

  debug(scope, msg) { return this._log('debug', scope, msg); }
  info(scope, msg) { return this._log('info', scope, msg); }
  warn(scope, msg) { return this._log('warn', scope, msg); }
  error(scope, msg) { return this._log('error', scope, msg); }

  recent(limit = 300) {
    return this.buffer.slice(-limit);
  }
}

module.exports = { Logger };
