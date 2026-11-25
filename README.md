# browser-pilot

**Agent-friendly controlled browser automation.**
让 AI agent 能真正操作浏览器；登录一次就不再烦你，需要凭据时弹个小窗问，勾了「长期保留」就加密存好。

---

## 为什么做这个

现在几乎所有 agent 都能「读网页」，但**能真正操作网页**的很少。原因是同一个：一旦 agent 能点、能输入，就要处理登录态；而处理登录态的标准做法是持久化浏览器 profile——**这会把浏览历史、Cookie、账号全部写到磁盘上**。

多数工具默认这么做，而且不告诉你。

这个工具把登录做成了三档，你按需要选：

| 档 | 行为 | 适合 |
|---|---|---|
| **共享浏览器（默认）** | 插件自己起一个 Chrome 窗口，**登录一次就一直复用**；窗口关了再打开，登录态还在 | 日常使用：只登录一次，之后 agent 全程自己干 |
| **弹框 + 长期保留** | 需要账号密码时弹一个小窗口，带「长期保留」勾选；勾了就用 **Windows DPAPI 加密**存盘（只有本机当前用户能解） | 没有扫码登录的站点 |
| **`--ephemeral` 零留痕** | 每次全新内存上下文，不落 Cookie、不落历史 | 临时查资料、不想留任何登录痕迹 |

为什么会话要复用：**每跑一次都让你重新登录，等于这个工具没法用**。但默认那档也不是「偷偷记账号」——它记的是浏览器自己的登录态，位置在 `%LOCALAPPDATA%\browser-pilot\profile`，你随时可以整个删掉。

## 零留痕的三道防线

即使开了共享浏览器，输出侧仍然是零留痕的：

| 防线 | 做法 |
|---|---|
| **启动时拒绝** | 上下文里一旦出现 `recordHar` / `recordVideo` / `storageState`，直接抛错，浏览器根本不启动 |
| **写盘前脱敏** | 所有离开内存的内容（stdout、JSON、报错）先过脱敏器：账号密码 → `<cred>`，网址 → `<url>`，邮箱 → `<email>`，IP → `<ip>` |
| **跑完自检** | 扫描输出目录的所有文本文件，确认没有本次用到的网址或凭据原文。**发现即报错，退出码 3** |

第三道是关键：不是「我说我没记录」，而是**每次跑完都给你看扫描结果**。

## 安装

> ⚠️ **别用 `npm install browser-pilot`。** npm 上这个包名属于**另一个项目**（`svilupp/browser-pilot`，一个 CDP 自动化库），装到的不是这个工具。本项目目前只从源码安装。

```bash
git clone https://github.com/dsAI-Q/browser-pilot.git
cd browser-pilot
npm install
node src/cli.mjs --help
```

需要 Node ≥ 18，以及本机已安装 Chrome 或 Edge。
**不会下载 Chromium**——`playwright-core` 复用系统浏览器（默认 `channel: 'chrome'`，可用 `--channel msedge`）。

## 30 秒跑通

先跑一个不需要任何账号的例子：

```bash
node src/cli.mjs run examples/open-and-shot.json
```

第一次运行会自己开一个 Chrome 窗口并截图。想登录某个站点，就在**那个窗口**里登录一次（扫码、账号密码都行），之后所有脚本都复用这个登录态——窗口关了再开也还在。

脚本需要账号密码、而该站点又没登录过时，会**弹一个小窗口**：

```
┌─ browser-pilot 需要登录 ──────────────┐
│ 登录 www.example.com                  │
│ 密码只在内存中使用；勾选「长期保留」后  │
│ 用 Windows 用户级加密保存。            │
│                                       │
│   账号  [ me@example.com          ]   │
│   密码  [ ••••••••                ]   │
│   [x] 长期保留账号和密码（下次不再询问）│
│                    [ 登录 ]  [ 取消 ] │
└───────────────────────────────────────┘
```

勾了「长期保留」就写进 `%LOCALAPPDATA%\browser-pilot\creds.json`，内容是 **DPAPI 密文**：只有本机当前 Windows 用户能解开，拷到别的机器或别的账户都无效。想清掉直接删这个文件。

**脚本不需要登录时，它一个字都不会问**——打开网页、截图、取文字、点击、滚动，全都不需要凭据，不会打断你。

一个最小脚本长这样（里面没有任何密码）：

```json
{
  "steps": [
    { "type": "goto", "url": "https://example.com/login" },
    { "type": "login", "userSelector": "#user", "passSelector": "#pass", "submitSelector": "button[type=submit]" },
    { "type": "wait", "ms": 2500 },
    { "type": "shot", "name": "after-login" },
    { "type": "text", "selector": "body" }
  ]
}
```

运行后的输出：

```
[OK ] #0 goto  http 200 (812ms)
[OK ] #1 login (1204ms)
[OK ] #2 wait (2503ms)
[OK ] #3 shot  after-login.png (298ms)
[OK ] #4 text  Welcome back (12ms)
输出目录：./.bp-out/20261125-181530
留痕自检：通过（输出目录内无网址与凭据原文）
```

### 什么时候会问你要账号

| 脚本里有 | 会问吗 |
|---|---|
| 站点**已在共享窗口登录** | ❌ 直接用已登录的会话 |
| `{ "type": "login", ... }`，且该站点**记住过** | ❌ 自动取 DPAPI 里那组 |
| `{ "type": "login", ... }`，没记住过 | ✅ 弹窗问账号 + 密码（可勾选长期保留） |
| `{ "valueFrom": "user" }` / `{ "valueFrom": "pass" }` | ✅ 只问缺的那个 |
| 只有 `goto` / `shot` / `text` / `click` / `fill`(字面值) / `scroll` | ❌ 一个字都不问 |

想彻底不问、也不存登录态，加 `--ephemeral`；那种模式下就是每次干净开局。

### 跑测试

```bash
npm run smoke
# A 组：凭据门控、一行式凭据解析、脱敏器、站点指纹、策略拒绝
# B 组：--help 可用、互斥选项被拒
# C 组：--ephemeral 跑一遍只读脚本，输出里找不到那个 URL
# D 组：需要登录但没凭据时不挂死（退出码 2）
```

沙箱或受限 CI 里禁止创建浏览器进程时，C 组会打印 `SKIP` 而不是 `FAIL`；
想让它必须跑起来（真机 CI），加 `BP_SMOKE_REQUIRE_BROWSER=1`。

## 脚本格式

```json
{
  "url": "https://example.com",
  "steps": [
    { "type": "goto",  "url": "https://example.com/login" },
    { "type": "wait",  "selector": "input", "state": "visible" },
    { "type": "shot",  "name": "01-login" },
    { "type": "login", "userSelector": "#user", "passSelector": "#pass", "submitSelector": "button[type=submit]" },
    { "type": "click", "text": "下一步" },
    { "type": "fill",  "selector": "input[name=q]", "value": "关键词" },
    { "type": "press", "key": "Enter" },
    { "type": "count", "selector": ".result-item" },
    { "type": "shot",  "name": "02-result", "fullPage": true }
  ]
}
```

### 动作类型

| type | 作用 | 关键参数 |
|---|---|---|
| `goto` | 打开网址 | `url`、`waitUntil` |
| `wait` | 等待 | `ms` 或 `selector` / `text` + `state` + `timeout` |
| `shot` | 截图 | `name`、`fullPage` |
| `click` | 点击 | `selector` / `text` / `role`+`name` / `placeholder` / `label`，`force` |
| `dblclick` | 双击 | 同上定位，`force` |
| `fill` | 填空（也支持 contenteditable） | 同上定位 + `value` 或 `valueFrom`，`force` |
| `type` | 键盘逐字输入（编辑器类页面用） | `value`、`delay` |
| `selectall` | 选中当前焦点内全部文本 | — |
| `press` | 按键 | `key`（默认 Enter） |
| `login` | 登录组合动作 | `userSelector`、`passSelector`、`submitSelector` |
| `text` | 取文字 | 定位（不给则取 body）、`max` |
| `dom` | 取元素 HTML（摸结构用） | 定位 + `max` |
| `probe` | 列元素信息（tag/id/class/placeholder/是否可见） | `selector`、`max` |
| `bbox` | 取元素坐标尺寸 | 定位 |
| `count` | 元素计数 | `selector` |
| `title` | 取标题 | — |
| `url` / `urlhost` | 当前网址 / 只取主机名 | — |
| `frames` | 列所有框架主机名 | — |
| `neterrors` | 列失败请求 | `max` |
| `scroll` | 滚动 | `y` |
| `clickxy` | 按坐标点击（图标按钮没有选择器时） | `x`、`y` |

坐标类动作（`clickxy`）在窗口尺寸或缩放变化后会失准，**能用选择器就别用坐标**；先 `probe` 找稳定的 `id` / `aria-label` / `data-*`。

### 凭据怎么给

**默认什么都不用准备**——先在那个共享窗口里登录一次，之后它一直用；需要账号密码时会弹窗问，勾了「长期保留」就加密记住。

不想让任何东西落盘，就用 `--ephemeral`，凭据只在内存里活一次。其余几种方式（优先级从高到低）适合脚本化、CI：

```bash
# 1) 管道传入（agent / 脚本调用推荐）
echo '{"user":"me@example.com","pass":"..."}' | browser-pilot run my.json --creds-stdin

# 2) 环境变量
set BP_USER=me@example.com
set BP_PASS=...
browser-pilot run my.json

# 3) 一行式：账号|密码
set BP_CREDS=me@example.com|我的密码

# 4) 本地文件（自己控制，别提交进 Git）
browser-pilot run my.json --creds-file C:\path\to\creds.json
```

连弹窗都不许出现时（CI、无桌面环境）加 `--no-gui --no-prompt`：缺凭据会直接报错并列出上面这些传法，退出码 2，绝不挂死。

其他常用选项：

```bash
--ephemeral        # 零留痕模式（每次干净开局）
--headed           # 显示浏览器窗口（共享模式下本来就是可见的）
--cdp-port 9222    # 共享浏览器的调试端口，冲突时换一个
--profile <dir>    # 指定共享浏览器的配置目录
--channel msedge   # 用 Edge 而不是 Chrome
```

脚本文件本身永远只写声明，不写密码：

```json
// ❌ 不要这样：密码进了文件，会被提交进 Git
{ "type": "fill", "selector": "#pass", "value": "mypassword" }

// ✅ 这样：文件里只有「从运行时凭据取」的声明
{ "type": "fill", "selector": "#pass", "valueFrom": "pass" }
```

## 输出

```
.bp-out/20261125-181530/
├── 00-01-login.png       截图
├── 03-after-login.png
├── manifest.json         只含元信息与站点主机的不可逆哈希
└── steps.json            每步的结果，网址已替换为 <url>
```

`manifest.json` 长这样：

```json
{
  "tool": "browser-pilot",
  "version": "0.4.1",
  "targetFingerprint": "h_3f9a1c2e",
  "steps": 5,
  "failed": 0,
  "screenshots": 2,
  "zeroRetention": false,
  "sessionMode": "shared"
}
```

`targetFingerprint` 是站点主机的 SHA-256 前 8 位——**能区分「跑了哪个站」，但无法反推出网址**。

`zeroRetention` 反映本次是不是 `--ephemeral`；`sessionMode` 是 `shared` 或 `ephemeral`。

## 它不做什么（重要）

- ❌ **不接管你日常那个 Chrome**。Chrome 136+ 禁止对默认配置目录开调试端口，所以它用自己维护的窗口；登录一次之后复用，你不用重复登录
- ❌ 不在后台常驻、不注册开机启动（窗口关了，下次运行自动重开）
- ❌ 不上传任何数据，不收集遥测
- ❌ 不读你系统里其他浏览器的数据

**它会留下什么（说清楚）：**

| 位置 | 内容 | 什么时候有 |
|---|---|---|
| `%LOCALAPPDATA%\browser-pilot\profile` | 浏览器登录态（Cookie 等） | 默认模式下第一次运行后 |
| `%LOCALAPPDATA%\browser-pilot\creds.json` | 你勾了「长期保留」的账号密码，**DPAPI 密文** | 只有你勾选过 |
| `./.bp-out/<时间戳>/` | 截图、steps.json、manifest.json（网址已脱敏） | 每次运行 |

两个 `%LOCALAPPDATA%` 目录随时可以整个删掉；`--ephemeral` 模式两者都不用。

## 使用者的责任

- 你只能操作你有权操作的网站与账号
- 遵守目标网站的服务条款与 robots 策略
- **截图是像素数据，可能含个人信息**。输出目录已在 `.gitignore` 里；分享前请自行检查
- 开源自己的脚本时，只提交脚本 JSON，不要提交 `.bp-out/`

详见 [docs/SECURITY.md](docs/SECURITY.md)。

## 测试

```bash
npm run smoke
```

测试用一个 `data:` URL 跑完整流程，然后断言：**输出目录里找不到那个 URL**。
不需要任何账号，可在 CI 直接跑。自动化路径一律带 `--no-gui --no-prompt`，不会弹窗、不会等人。

**验证记录**：0.4.1 在干净目录（重新 `pnpm install` 后）整包跑过，27 项通过；
2 项浏览器断言在禁止创建子进程的沙箱里标记为 `SKIP`。
浏览器路径另行通过真实任务验证——在一个真实网站的编辑器里定位图层、改文字、重载核对，全程退出码 0。

## License

MIT © 2026 大圣AI ([@dsAI-Q](https://github.com/dsAI-Q))
