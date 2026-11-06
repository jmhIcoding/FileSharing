'use strict';
/**
 * Office / WPS / 编辑器临时文件忽略规则（纯函数，不依赖 Electron）。
 *
 * 这些文件在「打开文档」时自动生成、关闭后消失，典型例子：
 *   Word 打开 报价单.docx  ->  ~$报价单.docx（锁文件）、~WRL0001.tmp（自动恢复）
 *   WPS 打开 报表.et      ->  ~$报表.et
 *   LibreOffice / WPS     ->  .~lock.文档.docx#
 *
 * 两层防护：
 *   1. buildExcludeLines() 写进 .git/info/exclude，让 git status 看不到它们（不会被上传）
 *   2. isTransientPath() 在 fs.watch 回调里直接丢弃事件（不会被扫描、不触发无谓同步）
 *
 * 规则只写进 .git/info/exclude，不进仓库、不影响协作者。
 * 注意：gitignore 对「已经被 git 跟踪」的文件无效，这类文件需要另外提示用户。
 */

const BUILTIN_EXCLUDE_RULES = [
  '~$*',          // Office / WPS 打开文档时生成的所有者锁文件
  '~WRL*.tmp',    // Word 自动恢复
  '~WRD*.tmp',    // Word 临时文件
  '.~lock.*#',    // LibreOffice / WPS 锁文件
  '*.tmp',
  '*.temp',
  '*.swp',
  '*.swo',
  '*~',           // Emacs / gedit 备份
  '*.bak',        // WPS / Office 备份
  'Thumbs.db',
  'desktop.ini',
  '.DS_Store',
];

const BUILTIN_HEADER = '# 内置规则：Office / WPS / 编辑器临时文件（关掉上面的开关即可停用）';
const USER_HEADER = '# 自定义规则';

/** 把内置 gitignore 规则编译成针对「文件名」的正则（规则里不含 /，匹配任意层级） */
const MATCHERS = BUILTIN_EXCLUDE_RULES.map((rule) => {
  const escaped = rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
});

/** 这个文件是不是临时文件？供文件监控层过滤，避免打开 Word 就触发一次同步 */
function isTransientPath(relPath) {
  if (!relPath) return false;
  const norm = String(relPath).replace(/\\/g, '/');
  const name = norm.split('/').pop();
  if (!name) return false;
  return MATCHERS.some((re) => re.test(name));
}

/** 生成 .git/info/exclude 的规则行：内置 + 用户自定义，自动去重 */
function buildExcludeLines(userRules, builtinOn = true) {
  const user = (Array.isArray(userRules) ? userRules : [])
    .map((r) => String(r).trim())
    .filter(Boolean)
    .filter((r) => !BUILTIN_EXCLUDE_RULES.includes(r));
  const lines = [];
  if (builtinOn !== false) {
    lines.push(BUILTIN_HEADER, ...BUILTIN_EXCLUDE_RULES);
  }
  if (user.length) {
    lines.push(USER_HEADER, ...user);
  }
  return lines;
}

/** 项目是否启用了内置忽略（老配置缺字段时默认开启） */
function builtinEnabled(project) {
  return !project || !project.sync || project.sync.builtinIgnore !== false;
}

/** 新文件是否需要用户确认（老配置缺字段时默认需要确认） */
function needsConfirm(project) {
  return !project || !project.sync || project.sync.newFilePolicy !== 'auto';
}

/** 正则规则默认大小写不敏感，长度上限防止误输入超长表达式 */
const MAX_REGEX_LEN = 200;
function regexOptions(project) {
  return { caseSensitive: !!(project && project.sync && project.sync.regexCaseSensitive) };
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function compileRegex(rule, opts = {}) {
  const s = typeof rule === 'string' ? rule.trim() : '';
  if (!s) throw new Error('正则表达式不能为空');
  if (s.length > MAX_REGEX_LEN) throw new Error(`正则表达式过长（最多 ${MAX_REGEX_LEN} 字符）`);
  try {
    return new RegExp(s, opts.caseSensitive ? '' : 'i');
  } catch (err) {
    throw new Error(`正则表达式无效：${err.message}`);
  }
}

/** 相对路径与文件名都测一遍，方便写 ^docs/ 或 ^~\$ 两种风格 */
function matchesAnyRegex(relPath, rules, opts = {}) {
  if (!relPath || !Array.isArray(rules) || !rules.length) return false;
  const norm = String(relPath).replace(/\\/g, '/');
  const name = norm.split('/').pop();
  return rules.some((r) => {
    try {
      const re = compileRegex(r, opts);
      return re.test(norm) || re.test(name);
    } catch (_) {
      return false; // 无效规则不生效，不拖垮同步
    }
  });
}

/** 综合判断：这个文件是不是应该被排除在同步之外 */
function isExcluded(project, relPath) {
  if (!relPath) return false;
  if (builtinEnabled(project) && isTransientPath(relPath)) return true;
  if (matchesAnyRegex(relPath, project && project.ignoreRegex, regexOptions(project))) return true;
  return false;
}

module.exports = {
  BUILTIN_EXCLUDE_RULES,
  BUILTIN_HEADER,
  USER_HEADER,
  MAX_REGEX_LEN,
  isTransientPath,
  buildExcludeLines,
  builtinEnabled,
  needsConfirm,
  regexOptions,
  escapeRegex,
  compileRegex,
  matchesAnyRegex,
  isExcluded,
};
