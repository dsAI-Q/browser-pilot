# browser-pilot

**Agent-friendly browser control.** 附着你正在用的 Chrome、把页面扫成 `ref:e3` 这种可点引用、每个动作都能断言结果；只有站点真的需要账号时才打扰你。

> 包名：`@dsai-q/browser-pilot`
> ⚠️ npm 上的裸名 `browser-pilot` 是**另一个项目**（svilupp/browser-pilot），别装错。

---

## 它解决的具体问题

三个，按重要性：

**一、agent 拿不到你已登录的浏览器。** 以前的做法只有「每次干净开局」或者「复制你的 profile」，两者都不好用。现在两条路：Chrome 144+ 打开 `chrome://inspect/#remote-debugging`，工具就**直接附着到你正在用的那个 Chrome**，沿用你的登录态和你已经打开的标签；不想开开关，就用它自己维护的窗口，登录一次后一直复用。

**二、agent 不会写选择器。** 类名是构建产物、结构一改就废。`snapshot` 把页面上可交互的元素扫成 `ref:e3` 这种短引用，之后所有动作都写 `{"type":"click","ref":"ref:e3"}`。

**三、动作发出去只知道「超时」。** 现在每步都能带断言（网址/文字/数量/可见性）、重试次数和失败提示，失败时能说出是哪个条件没满足。

这个工具把登录做成了四档，你按需要选：

| 档 | 行为 | 适合 |
|---|---|---|
| **附着你的 Chrome（首选）** | 你在 Chrome 里打开一次 `chrome://inspect/#remote-debugging` 的开关，之后工具直接接管**你正在用的那个浏览器**：已登录、已打开的标签都能用 | 你平时就在浏览器里登录着 |
| **共享窗口（默认）** | 插件自己起一个 Chrome 窗口，**登录一次就一直复用**；窗口关了再打开，登录态还在 | 不想开调试开关 |
| **弹框 + 长期保留** | 需要账号密码时弹一个小窗口，带「长期保留」勾选；勾了就用 **Windows DPAPI 加密**存盘 | 没有扫码登录的站点 |
| **`--ephemeral` 零留痕** | 每次全新内存上下文，不落 Cookie、不落历史 | 临时查资料、不想留任何痕迹 |

选择是**自动**的：开着调试开关就用你的浏览器，没开就自己开一个窗口。想强制用某一种，加 `--attach` 或 `--no-attach`。

## 附着到你现有的 Chrome

```bash
# 1) Chrome ≥ 144，地址栏打开：
#    chrome://inspect/#remote-debugging
#    把远程调试开关打开（一次性，重启 Chrome 仍然有效）

# 2) 直接跑脚本，第一次连接 Chrome 会弹授权框，点「允许」
node src/cli.mjs run examples/open-and-shot.json
# 已附着到你正在用的 Chrome（沿用其登录态）
```

它不碰你的命令行、不复制 profile：只读 Chrome 自己写的 `DevToolsActivePort`（端口 + 浏览器 WebSocket 路径）然后连上去。想强制验证：

```bash
node src/cli.mjs run my.json --attach     # 没开开关就报错，并打印开启步骤
node src/cli.mjs run my.json --no-attach  # 永不着附
```

## 抓到能点的引用：snapshot

手写 CSS 选择器是 agent 最容易翻车的地方。让工具先扫一遍：

```json
{ "type": "snapshot" }
```

它会输出（同时写进 `refs.json`）：

```
ref:e1	link	"More information..."
ref:e2	button	"登录"
ref:e3	textbox	"手机号/邮箱"
```

之后直接用引用操作，页面结构改了也不用改脚本：

```json
[
  { "type": "fill",  "ref": "ref:e3", "value": "me@example.com" },
  { "type": "click", "ref": "ref:e2", "retries": 2 },
  { "type": "asserturl", "contains": "/dashboard" }
]
```

ref 只在本次运行内有效；`switchframe` 之后会失效，需要重新 `snapshot`。

## 断言、重试与失败提示

```json
[
  { "type": "asserturl",      "contains": "/dashboard" },
  { "type": "asserttext",     "text": "欢迎回来", "contains": "欢迎" },
  { "type": "assertcount",    "selector": ".result-item", "min": 3 },
  { "type": "assertvisible",  "selector": "#toast", "visible": false },
  { "type": "click", "ref": "ref:e5", "retries": 3, "retryDelay": 800, "hint": "按钮可能被弹窗挡住" }
]
```

失败时输出会写清「哪个条件没满足、实际是什么」，并附上你给的 `hint`。

## 跨域 iframe

Playwright 原生支持跨进程 iframe，这里直接暴露出来：

```json
[
  { "type": "switchframe",   "selector": "iframe#payment" },
  { "type": "fill",          "selector": "#card-number", "value": "4242..." },
  { "type": "switchtomain" }
]
```

`switchframe` 支持 `ref` / `selector` / `url`（包含匹配）/ `name` / `index`。切进去之后所有定位都相对那个框架。

## 复用登录：cookie 快照

不想为了一个站点保留整份浏览器 profile，或者要在 CI 里复用登录态：

```bash
node src/cli.mjs auth save app        # 把当前浏览器的 Cookie 存成快照
node src/cli.mjs auth list            # 只显示数量与域名个数，不打印域名
node src/cli.mjs run my.json --auth app
node src/cli.mjs auth forget app
```

快照用与凭据相同的 **DPAPI** 加密，只有本机当前用户能解开。
**Cookie 等价于登录凭据**，别把文件拷给别人。

## 零留痕的三道防线

输出侧永远是零留痕的（无论用哪种浏览器模式）：

| 防线 | 做法 |
|---|---|
| **启动时拒绝** | 上下文里一旦出现 `recordHar` / `recordVideo` / `storageState`，直接抛错，浏览器根本不启动 |
| **写盘前脱敏** | 所有离开内存的内容（stdout、JSON、报错）先过脱敏器：账号密码 → `<cred>`，网址 → `<url>`，邮箱 → `<email>`，IP → `<ip>` |
| **跑完自检** | 扫描输出目录的所有文本文件，确认没有本次用到的网址或凭据原文。**发现即报错，退出码 3** |

第三道是关键：不是「我说我没记录」，而是**每次跑完都给你看扫描结果**。

## 安装

> ⚠️ **别用 `npm install browser-pilot`。** npm 上那个名字属于**另一个项目**（`svilupp/browser-pilot`，一个 CDP 自动化库）。本项目的包名是 `@dsai-q/browser-pilot`，仓库名是 browser-pilot。

```bash
# 发布到 npm 之后：
npm install @dsai-q/browser-pilot

# 现在（源码安装，推荐）
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

第一次运行会自己开一个 Chrome 窗口并截图（你要是开了 `chrome://inspect` 的开关，它就改用你现有的浏览器，连窗口都不新开）。想登录某个站点，就在那个浏览器里登录一次，之后所有脚本都复用这个登录态。

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
    { "type": "snapshot" },
    { "type": "fill",  "ref": "ref:e1", "value": "me@example.com" },
    { "type": "fill",  "ref": "ref:e2", "valueFrom": "pass" },
    { "type": "click", "ref": "ref:e3", "retries": 2 },
    { "type": "asserturl", "contains": "/dashboard" },
    { "type": "shot",  "name": "02-result", "fullPage": true }
  ]
}
```

### 动作类型

| type | 作用 | 关键参数 |
|---|---|---|
| `goto` | 打开网址 | `url`、`waitUntil` |
| `wait` | 等待 | `ms` 或 `ref`/`selector`/`text` + `state` + `timeout` |
| `shot` | 截图 | `name`、`fullPage` |
| `snapshot` | 扫页面产出 `ref:eN` | `max`、`save` |
| `click` | 点击 | `ref` / `selector` / `text` / `role`+`name` / `placeholder` / `label`，`force` |
| `dblclick` | 双击 | 同上定位，`force` |
| `fill` | 填空（也支持 contenteditable） | 同上定位 + `value` 或 `valueFrom`，`force` |
| `type` | 键盘逐字输入（编辑器类页面用） | `value`、`delay` |
| `selectall` | 选中当前焦点内全部文本 | — |
| `press` | 按键 | `key`（默认 Enter） |
| `login` | 登录组合动作 | `userSelector`、`passSelector`、`submitSelector` |
| `text` | 取文字 | 定位（不给则取 body）、`max` |
| `dom` | 取元素 HTML（摸结构用） | 定位 + `max` |
| `probe` | 列元素信息（tag/id/class/placeholder/是否可见） | `ref`/`selector`、`max` |
| `bbox` | 取元素坐标尺寸 | 定位 |
| `count` | 元素计数 | `ref`/`selector` |
| `title` | 取标题 | — |
| `url` / `urlhost` | 当前网址 / 只取主机名 | — |
| `frames` | 列所有框架主机名 | — |
| `switchframe` | 切进 iframe（含跨域） | `ref`/`selector`/`url`/`name`/`index` |
| `switchtomain` | 切回主框架 | — |
| `neterrors` | 列失败请求 | `max` |
| `asserturl` | 断言网址 | `contains` / `exact` / `regex` |
| `asserttext` | 断言文字 | 定位 + `contains` / `equals` / `regex` |
| `assertcount` | 断言元素数量 | `ref`/`selector` + `equals` / `min` / `max` |
| `assertvisible` | 断言可见性 | 定位 + `visible:false` |
| `scroll` | 滚动 | `y` |
| `clickxy` | 按坐标点击（没有选择器的图标按钮） | `x`、`y` |

每步通用：`retries`、`retryDelay`、`timeout`、`hint`、`continueOnError`。

定位优先级 **ref > selector > text > role+name > placeholder > label**。坐标类动作（`clickxy`）在窗口尺寸或缩放变化后会失准，能用 `ref` / 选择器就别用坐标。

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
--attach           # 必须附着你现有的 Chrome（失败就报错给指引）
--no-attach        # 永不着附
--user-data-dir <p># 多 profile 时指定 Chrome 配置目录
--auth <名字>      # 运行前灌入登录快照
--ephemeral        # 零留痕模式（每次干净开局）
--headed           # 显示浏览器窗口（共享窗口模式下本来就可见）
--cdp-port 9222    # 共享浏览器的调试端口，冲突时换一个
--profile <dir>    # 指定共享浏览器的配置目录
--channel msedge   # 用 Edge 而不是 Chrome
```

脚本文件本身永远只写声明，不写密码：

```json
// ❌ 不要这样：密码进了文件，会被提交进 Git
{ "type": "fill", "selector": "#pass", "value": "mypassword" }

// ✅ 这样：文件里只有「从运行时凭据取」的声明
{ "type": "fill", "ref": "ref:e2", "valueFrom": "pass" }
```

## 输出

```
.bp-out/20261125-181530/
├── 00-01-login.png       截图
├── 03-after-login.png
├── refs.json             snapshot 产出的 ref → 选择器映射
├── manifest.json         只含元信息与站点主机的不可逆哈希
└── steps.json            每步的结果，网址已替换为 <url>
```

`manifest.json` 长这样：

```json
{
  "tool": "browser-pilot-dsai",
  "version": "0.5.0",
  "targetFingerprint": "h_3f9a1c2e",
  "steps": 5,
  "failed": 0,
  "screenshots": 2,
  "zeroRetention": false,
  "sessionMode": "attached",
  "authSnapshot": null
}
```

`targetFingerprint` 是站点主机的 SHA-256 前 8 位——**能区分「跑了哪个站」，但无法反推出网址**。

`sessionMode` 是 `attached`（接管你的 Chrome）/ `shared`（自己的窗口）/ `ephemeral` 三者之一；`zeroRetention` 只在 `ephemeral` 下为 true。

## 它不做什么（重要）

- ❌ **不偷偷接管你的浏览器**：`--attach` 只在你自己打开了 `chrome://inspect/#remote-debugging` 开关时才生效，且 Chrome 首次连接会弹授权框
- ❌ 不复制你的 Chrome 配置目录、不读 `Cookies` 数据库文件
- ❌ 不在后台常驻、不注册开机启动（窗口关了，下次运行自动重开）
- ❌ 不上传任何数据，不收集遥测

**它会留下什么（说清楚）：**

| 位置 | 内容 | 什么时候有 |
|---|---|---|
| `<Chrome 配置目录>\DevToolsActivePort` | Chrome 自己写的调试端口，**不是你写的内容** | 你打开那个开关后由 Chrome 维护 |
| `%LOCALAPPDATA%\browser-pilot\profile` | 共享窗口的登录态（Cookie 等） | 用共享窗口模式跑过之后 |
| `%LOCALAPPDATA%\browser-pilot\creds.json` | 你勾了「长期保留」的账号密码，**DPAPI 密文** | 只有你勾选过 |
| `%LOCALAPPDATA%\browser-pilot\auth\<名字>.dat` | `auth save` 存的 Cookie 快照，**DPAPI 密文** | 只有你主动 save 过 |
| `./.bp-out/<时间戳>/` | 截图、refs.json、steps.json、manifest.json（网址已脱敏） | 每次运行 |

后三个目录随时可以整个删掉；`--ephemeral` 模式一个都不写。

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

**验证记录**：0.5.0 在干净目录（重新 `pnpm install` 后）整包跑过，40 项通过；
2 项浏览器断言在禁止创建子进程的沙箱里标记为 `SKIP`。
浏览器路径另行用真实页面验证过：`snapshot` → `ref:e2` 点击 → 断言结果、跨框架 `switchframe` 进 iframe 操作再切回，
以及在一个真实网站的编辑器里定位图层、改文字、重载核对，全部退出码 0。

`assertvisible` 的语义是 **CSS 可见**（有尺寸、不是 hidden/display:none），
不是「在视口里」——元素滚出屏幕仍然算可见。

## License

MIT © 2026 大圣AI ([@dsAI-Q](https://github.com/dsAI-Q))
