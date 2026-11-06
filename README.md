# FileSharing

本地目录 ↔ Git 仓库的自动同步监控工具。盯着你的文件夹，远端有更新就自动合并下来，本地有改动就提交推送；两边改到同一个文件时**停下来交给你处理**，不会替你瞎猜。

Windows 桌面应用（Electron），多台电脑可以同时监控同一个仓库。

> 版本记录：[RELEASE-NOTES.md](./RELEASE-NOTES.md)（当前 1.0.0）

> **不需要装 Node.js，也不需要装 Git。**
> Electron 运行时和完整 Git 运行时都随程序一起分发，双击安装包即可使用。

---

## 它能做什么

| 场景 | 行为 |
|---|---|
| 本地文件被修改 | 默认自动提交并推送；也可设为「每次等我点『提交并推送』」 |
| 远端有新提交 | 定时拉取并自动 merge 到本地（能快进就快进，历史保持线性） |
| 两边改了同一个文件 | 暂停同步，列出冲突文件，逐个选择「保留本地 / 采用远端」，或直接打开文件手改 |
| 本地目录是空的 | 自动 `git clone` |
| 本地目录已有文件、没有 `.git` | 自动 `git init` + 关联远端 + 对齐历史，**不覆盖已有文件** |
| 多台设备 | 各自配置同一个仓库，靠 commit + merge 保持一致 |
| 用 Word / WPS 打开文档 | `~$xxx.docx` 之类锁文件默认被监控层和 Git 一起忽略，不扫描、不上传 |
| 本地新增任意文件 | 默认挂起等你确认要不要上传；可用正则批量忽略，已上传的也能「不再追踪」 |

---

## 快速开始

### 1. 前提

- Windows 10/11
- 一个 Git 仓库的 **HTTPS** 地址 + **Personal Access Token**

就这样。**Node.js、Git、Git for Windows 都不用装**——程序自带：

| 组件 | 来源 |
|---|---|
| Node.js 运行时 | 内嵌在 Electron 里，仅程序内部使用 |
| Chromium | 内嵌在 Electron 里，用来显示界面 |
| Git 2.55 运行时 | 随包附带的 `vendor/git`，调用时自动选中 |

装好后在「设置 → Git 可执行文件」能看到「来源：内置 Git」。
如果你的机器上本来就有 Git、想改用它，在那一栏填 `git.exe` 的完整路径即可。

### 2. 启动

- **装好的用户**：双击桌面上的 `FileSharing` 快捷方式
- **绿色版**：双击 `FileSharing.exe`
- **开发者**：`npm install && npm start`

### 3. 拿到 Token（可能有好几个）

**GitHub**
1. Settings → Developer settings → Personal access tokens
2. Classic token：勾选 `repo` 整个范围
3. 或 Fine-grained token：Repository access 选中目标仓库，Permissions → Contents 设为 **Read and write**
4. 复制生成的 `ghp_xxx`（只显示一次）

**GitLab**：Preferences → Access Tokens，勾 `read_repository` + `write_repository`，得到 `glpat-xxx`

**Gitee**：设置 → 私人令牌，勾 `projects`

不同平台、不同账号（个人 GitHub / 公司 GitLab / 客户仓库）通常各有各的 Token，
FileSharing 可以**同时保存任意多条**，不用每次换仓库就重填。

### 4. 设置界面里一键配置凭据库

打开主界面右上角的 **设置**（或详情页的「凭据设置」按钮）→ **「Git 凭据库」** 区块：

1. 点 **「+ 添加凭据」** → 填 **名称**、**适用域名**（如 `github.com` / `git.corp.com`）、
   **Token**、可选的用户名 → 点 **「保存凭据」**。**填完立即加密落盘生效**，不用再点设置页底部的保存。
2. 想要几条就加几条。每条都能「设为默认 / 应用到全部 / 编辑 / 删除」。
   编辑时 Token 框留空 = 保持原值，填新的 = 替换。
3. **「自动按仓库域名匹配」** 默认开启：新增目录时按 Git 地址的域名自动挑对应 Token，
   匹配不到就用标了「默认」的那条。
4. **「⚡ 一键应用到全部目录」**：一次点击把默认凭据应用到所有监控目录；
   也可以点某条凭据上的「应用到全部」指定用哪一条。

列表里只显示 `••••••••1234` 这样的脱敏预览，**明文 Token 不回传界面、不写进 `.git/config`**，
而是用 Windows DPAPI 加密成 `tokenEnc` 存在 `%APPDATA%\FileSharing\config.json`。

> 旧版本只有一个全局 Token，升级后会自动变成凭据库里的第一条「默认凭据」，不用重填。

**单个目录要特殊处理时**：在「编辑配置 → 认证方式」里四选一

| 认证方式 | 行为 |
|---|---|
| 自动匹配 / 使用默认 Token（推荐） | 按仓库域名自动挑凭据库里的 Token |
| 指定某条凭据 | 从下拉里选一条固定使用，不受自动匹配影响 |
| 为此目录单独设置 | 填本目录专属 Token，不进凭据库、覆盖所有其他设置 |
| 公开仓库，无需认证 | 不带任何凭据 |

> 明确指定的凭据如果被删掉，程序**不会**偷偷改用别的账号，会停下来提示你重选。

### 5. 添加监控目录

点左上角 `+`，填四样东西：

1. **本地目录** — 想同步的文件夹。空目录会 clone，非空目录会接管。
2. **仓库地址** — 必须是 HTTPS：`https://github.com/用户名/仓库.git`（SSH 地址不支持 Token）。
3. **分支** — 通常是 `main`。
4. **认证方式** — 默认「自动匹配」，一般不用动。

点「测试连接」会**按你当前选的认证方式**去连，能读出分支列表就说明地址和凭据都通了。

> **空仓库建议先建好 `main` 分支**（放个 README 即可）。空仓库推上第一个分支时，
> GitHub 会把它设为默认分支；如果首推的不是 `main`，之后按默认配置填 `main` 会找不到分支。
> 程序支持任意分支名，但默认配置是 `main`。
>
> **本地目录不需要预先是 Git 仓库**，也不需要先手动 `git init`。
> 添加后程序会自动处理：空目录 → `git clone`；已有文件的普通目录 →
> `git init` + 关联远端 + 对齐历史（`reset --mixed` + `checkout-index`，**不覆盖已有文件**）；
> 已有 `.git` → 直接接管并校正 remote。状态检查只在初始化完成后才运行，
> 所以普通目录不会出现 `fatal: not a git repository`。
> 如果之前中过旧版本的「`.git` 空壳」问题，程序会在下一次同步时自动清理并重新初始化。

---

## Office / WPS 临时文件（打开文档时产生）

Word 打开 `报价单.docx` 会生成 `~$报价单.docx` 锁文件和 `~WRL0001.tmp` 自动恢复文件；
WPS 会生成 `~$报表.et`、`~$文稿.wps`；LibreOffice 会生成 `.~lock.xxx#`；
此外还有 `*.bak`、`*.swp`、`Thumbs.db`、`.DS_Store` 等。这些文件打开就有、关掉就删，
FileSharing **默认挡在两层之外**：

| 层 | 做法 | 效果 |
|---|---|---|
| 文件监控 | `fs.watch` 回调里按文件名直接丢弃 | 打开文档**不会触发一次无谓同步** |
| Git 状态 | 规则写入 `.git/info/exclude` | `git status` 看不到，**不会被提交、不会被推送** |

内置 13 条规则：`~$*`、`~WRL*.tmp`、`~WRD*.tmp`、`.~lock.*#`、`*.tmp`、`*.temp`、
`*.swp`、`*.swo`、`*~`、`*.bak`、`Thumbs.db`、`desktop.ini`、`.DS_Store`。

在「编辑配置 → 忽略规则」里能看到完整清单和开关：
- **「自动忽略 Office / WPS 临时文件」** 默认开启；如果你确实要同步某些 `.tmp` 文件，可以关掉。
- 下面的文本框可加自己的规则（每行一条），例如 `*.log`、`node_modules/`、`build/`。
- 内置和自定义规则都只写进 `.git/info/exclude`，**不提交到仓库、不影响协作者**，也不影响你的全局 Git 配置。

> **已跟踪的历史遗留**：gitignore 只对未跟踪文件生效。如果之前已经把 `~$报价单.docx`
> 提交进过仓库，详情页会出现黄色提示列出它们。在目录下执行（本地文件保留），
> 然后在 FileSharing 里点「提交并推送」即可：
> ```bash
> git rm --cached '~$报价单.docx'
> ```
> 想一次清掉多个，用 `git ls-files | grep '^~\$' | xargs -d '\n' git rm --cached --`。

---

## 两类文件，两套策略

**已跟踪的文件改了就自动上传，不需要反复确认；只有本地新冒出来的文件才需要先确认。**
这两件事互不影响，在「编辑配置 → 同步行为」里并排设置：

| 对象 | 默认 | 另一个选项 |
|---|---|---|
| **已跟踪文件的改动** | 改了就自动提交并推送 | 每次等我点「提交并推送」 |
| **本地新增文件** | 需要我确认才上传 | 全部自动纳入同步 |

所以日常编辑文档、改代码时不用管程序，它会自己同步；只有往目录里放进**新文件**时
才会拦一下，免得误把临时文件、大文件或敏感材料推上去。

### 本地新增文件怎么确认

详情页会出现 **「待确认的新文件」** 面板（注意：**已经同步过的文件修改不会出现在这里**）：

- **上传** —— 确认这一个文件加入同步（立即 `git add`）
- **全部上传** —— 一次确认当前所有待确认文件
- **忽略…** —— 打开正则工具，自动带上这个文件名和一个建议规则
- **正则批量忽略** —— 把所有待确认文件名一起灌进正则工具

确认之后点「提交并推送」才会真正同步。实现上，`ask` 策略下提交**不再使用 `git add -A`**，
只显式纳入已确认 / 已跟踪且未被规则排除的文件，所以挂起的文件不会被任何自动同步夹带上去。

> 想回到「所有改动都要我点一下」的旧行为，把「已跟踪文件的改动」改成
> 「每次等我点『提交并推送』」即可。

### 正则快速匹配小工具

详情页工具栏「正则工具」或「编辑配置 → 正则快速匹配工具」打开：

1. 左边填文件名（每行一条），右边填正则表达式。
2. 下面**实时**逐行显示「匹配 / 不匹配」，命中的片段高亮，并给出 `匹配 N / M`。
3. 只有**至少一条匹配**时，「确认加入忽略规则」才可点 —— 匹配上才让你确认加入。

规则同时匹配**完整相对路径**和**文件名**（例如 `^docs/` 匹配路径、`^~\$` 匹配文件名），
默认不区分大小写，可在「编辑配置 → 正则匹配」切换。非法正则、超长正则（>200 字符）会直接提示，
不会让同步崩掉。加入的规则对未跟踪文件立即生效，也能让已跟踪但命中的文件不再同步改动。

### 后悔机制：不再追踪已上传的文件

改动列表里每个文件都有 **「不再追踪」** 按钮（带二次确认）：

- 执行 `git rm --cached`（**本地文件保留**），并自动加一条精确的正则规则，防止它又变回待确认文件。
- 下次提交后，远端也会删除这个文件；之后它再也不会被扫描或同步。

> 和之前的临时文件不同，这一步是真正的「从仓库移除」，会同步给其他设备，所以有确认框。
> 只想本地不再改动、不想删远端文件的话，用正则规则把它排除即可，不必点「不再追踪」。

---

## 代理（访问 GitHub 必备）

设置 → 网络代理 → 自定义代理，填本地代理地址：

```
http://127.0.0.1:7890      # Clash / V2Ray 常见 HTTP 端口
socks5://127.0.0.1:7891    # SOCKS5
```

也可以给单个项目单独设置代理（项目编辑 → 网络），互不影响。

代理只作用于 FileSharing 调用的 git 命令，不会改你的全局 git 配置。

---

## 冲突处理

两边同时改同一个文件的同一区域时，Git 无法自动合并。FileSharing 会：

1. 停止该项目的一切自动同步
2. 侧栏出现红色数字角标，系统弹出通知
3. 主界面出现冲突面板

每个冲突文件有两个按钮：

- **保留本地** — 用你这台电脑上的版本（`git checkout --ours`）
- **采用远端** — 用仓库里的版本（`git checkout --theirs`）
- **打开** — 用默认编辑器打开，手动删掉 `<<<<<<<` / `=======` / `>>>>>>>` 标记

全部处理完后点 **完成合并**，生成合并提交。如果推送方式是「自动推送」会顺带推上去，否则进入待推送状态等你确认。

点 **放弃本次合并** 可以整体回滚到合并前。

> 小提示：「保留本地」在合并场景下指的是你当前分支（这台电脑）的版本，「采用远端」指的是 `origin/分支` 的版本。

---

## 同步是怎么跑的

每一轮同步做这些事：

```
1. 读状态        git status --porcelain
2. 处理本地改动   按配置自动提交（默认不提交，等你确认）
3. fetch         git fetch origin
4. 合并远端      git merge origin/分支
                   └─ 有冲突 → 停在这里，等你处理
5. 推送          git push origin HEAD:分支
                   └─ 推送方式是"需确认"时，只标记待推送
```

- **定时**：按项目配置的间隔（最小 10 秒）
- **实时**：监听目录变化，文件改动后 2 秒触发一次
- 同一项目的 git 操作严格串行，不会因为并发写坏索引

---

## 多台设备怎么用

每台电脑上各装一份，各自配一个本地目录，指向**同一个仓库、同一个分支**。

```
电脑 A: D:\work\docs      ─┐
                           ├─→  origin/main
电脑 B: E:\project\docs   ─┘
```

- A 改了文件 → 提交推送 → B 下一轮自动拉下来
- 两台同时改了不同文件 → 各自提交，自动合并
- 两台同时改了同一行 → 冲突，谁先发现谁处理

建议把同步间隔设成 30 秒～2 分钟，太频繁会制造大量琐碎提交。

---

## 配置与数据

| 内容 | 位置 |
|---|---|
| 配置 | `%APPDATA%\FileSharing\config.json` |
| 日志 | `%APPDATA%\FileSharing\logs\app-YYYY-MM-DD.log` |

想把配置和程序放在一起（真正便携），启动前设置环境变量 `FILESHARING_USER_DATA`
指向自定义目录即可，例如：

```bat
set FILESHARING_USER_DATA=%~dp0data
FileSharing.exe
```

- 凭据库里每条 Token、项目专属 Token、代理密码分别以 `tokenEnc` / `tokenEnc` / `proxyPassEnc` 形式存储（DPAPI 加密）。
- 换机器或换 Windows 用户后密文解不开，需要到「设置 → Git 凭据库」重新填。
- 配置可以直接复制到另一台机器；项目级专属 Token 同样需要到「编辑配置 → 认证方式」重填。

---

## 打包分发

### 一键安装包（推荐给最终用户）

```bash
npm install
node build/vendor-git.js          # 提取内置 Git（本机需有 Git 一次）
npm run build:installer            # 产物 dist/FileSharing-1.0.0-x64.exe
```

双击 `FileSharing-1.0.0-x64.exe` 就会自动安装到
`%LOCALAPPDATA%\Programs\filesharing`，创建桌面与开始菜单快捷方式，
装完直接启动，**不需要管理员权限、不需要点下一步**。
卸载从「设置 → 应用」或安装目录里的 `Uninstall FileSharing.exe` 走。

安装包约 118MB（内含约 386MB 程序文件，压缩后分发）。

> 内置 Git for Windows 遵循 GPLv2，安装包里附带了 `LICENSE.txt` 与
> `THIRD-PARTY.txt`（来源、版本、源码获取方式）。FileSharing 只以独立子进程调用 git.exe。

### 绿色免安装版

```bash
npm install
npm run build:portable            # 自动提取 Git 并打包
# 产物：dist/FileSharing/FileSharing.exe
```

`dist/FileSharing` 约 386MB，压缩后拷到另一台 Windows 机器解压，
双击 `FileSharing.exe` 就能用，**目标机器同样零依赖**。

> 绿色版的可执行文件沿用 Electron 默认图标；安装包会用 `assets/icon.ico`。

**安装包**（NSIS + 便携 exe，需要 electron-builder 正常安装）：

```bash
npm run build
```

---

## 自测

```bash
npm test                          # 凭据 + 忽略/新文件确认 + 目录初始化 + 核心同步（183 项）
npm run test:credentials         # 只跑凭据（67 项）
npm run test:ignore              # 只跑忽略与新文件确认（49 项）
npm run test:init                # 只跑普通目录初始化（24 项）
npm run test:sync                # 只跑同步（43 项）
```

- `build/test-credentials.js`（67 项）：不联网，覆盖多 Token 凭据库的加密往返、增删改、
  Git 错误的中文提示（含错误 Token、401/403、网络、非快进）、
  按域名自动匹配、四态认证、指定凭据、一键应用到全部目录、旧配置迁移、
  git 命令行 `Authorization` 注入。
- `build/test-ignore.js`（49 项）：真实 Git 仓库，覆盖 20 种 Office/WPS 临时文件名识别、
  内置 + 自定义规则合并与去重、正则编译与大小写、开关关闭、`git status` 确实看不到锁文件、
  旧规则块替换、已跟踪遗留检出、`fs.watch` 不再因打开 Word 触发同步，
  以及新文件确认 / 正则排除 / 只提交已确认文件 / 停止追踪后本地文件保留。
- `build/test-init.js`（24 项）：回归「普通目录不是 Git 仓库」场景，覆盖仓库判定、
  `refreshRules()` 不制造 `.git` 空壳、完整保存流程能成功接管、空目录克隆、
  旧版空壳自愈、真实仓库不受影响。
- `build/selftest.js`（43 项）：用真实 Git 裸仓库模拟多设备，覆盖首次克隆、改动检测、推送、
  远端自动合并、冲突检测、冲突解决、放弃合并、非空目录接管、忽略规则与临时文件，
  以及「新文件默认不上传、确认后才推到远端」的端到端流程；
  场景 11 专门验证「已跟踪改动自动上传 + 新增文件仍需确认」两种策略互不干扰，
  以及 `confirm` 策略下不会自动上传。
- `build/smoke.js` / `build/smoke-conflict.js`：真实启动 Electron 界面并截图，验证凭据库 UI、
  一键添加两条凭据、一键应用到全部目录、项目四态认证选择器、冲突面板与完成合并流程。

### 连真实 GitHub 跑一遍（可选）

上面 5 套都不联网。要验证真实 HTTPS + Token + 代理 + 推送链路，用环境变量传入凭据
（**脚本里不含 Token，也不会写进任何文件**）：

```bash
FILESHARING_LIVE_TOKEN=ghp_xxx \
FILESHARING_LIVE_REMOTE=https://github.com/user/repo.git \
npm run test:live
```

`build/test-live-github.js` 会在一个独立的 `filesharing-e2e-*` 分支上跑：
内置 Git 与认证注入、直连/代理连通、普通目录接管真实仓库、确认上传后真实推送、
第二台设备克隆与自动合并、双方改同一行产生冲突并解决、Word 锁文件与正则规则不上传、
停止追踪、`.git/config` 无明文 Token，**最后自动删除测试分支并校验 `main` 未被改动**。
配套的 `build/smoke-live.js` 用临时 `FILESHARING_USER_DATA` 启动真实界面，
验证凭据脱敏、`project:test` 真实连通、`project:save` 真实克隆，且不污染用户真实配置。

> 注意：空仓库的第一个分支会成为默认分支，GitHub 不允许删除默认分支。
> 因此建议仓库先有 `main`；测试脚本会检查这一点。

---

## 目录结构

```
main.js              Electron 主进程：窗口、托盘、IPC
preload.js           安全桥接，暴露受限 API
core/
  engine.js          同步引擎（状态机 + 冲突处理），核心
  git.js             git 命令封装，注入代理与 Token
  credentials.js     凭据库解析：多 Token、域名自动匹配、四态认证（纯函数，主进程与引擎共用）
  ignore.js          Office/WPS 临时文件规则与文件名匹配（引擎与调度器共用）
  scheduler.js       定时调度 + 文件监控
  store.js           配置持久化 + Token / 代理密码加密
  logger.js          日志
renderer/            界面（原生 HTML/CSS/JS）
build/
  test-credentials.js 凭据自测（62 项）
  test-ignore.js     忽略与新文件确认自测（49 项）
  test-init.js       普通目录初始化回归测试（24 项）
  test-live-github.js 真实 GitHub 端到端测试（Token 从环境变量读，不落盘）
  smoke-live.js      真实 GitHub 的 Electron 界面冒烟
  selftest.js        同步端到端自测（43 项）
  smoke.js           界面冒烟 + 截图
  smoke-conflict.js  冲突流程冒烟 + 截图
  make-icon.js       生成图标
  package-portable.js 绿色版打包
  vendor-git.js      提取内置 Git 运行时
```
