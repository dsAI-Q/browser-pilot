# browser-pilot

**Agent-friendly controlled browser automation — zero retention by default.**
让 AI agent 能真正操作浏览器，但不在你的磁盘上留下任何浏览痕迹。

---

## 为什么做这个

现在几乎所有 agent 都能「读网页」，但**能真正操作网页**的很少。原因是同一个：一旦 agent 能点、能输入，就要处理登录态；而处理登录态的标准做法是持久化浏览器 profile——**这会把浏览历史、Cookie、账号全部写到磁盘上**。

多数工具默认这么做，而且不告诉你。

这个工具反过来：**它不接管你已经登录的浏览器，而是每次用干净的内存上下文，凭据由你临时提供，用完即焚。** 代价是每次要登录一次；换来的是磁盘上什么都没有。

## 零留痕的三道防线

| 防线 | 做法 |
|---|---|
| **启动时拒绝** | 上下文里一旦出现 `recordHar` / `recordVideo` / `storageState`，直接抛错，浏览器根本不启动 |
| **写盘前脱敏** | 所有离开内存的内容（stdout、JSON、报错）先过脱敏器：账号密码 → `<cred>`，网址 → `<url>`，邮箱 → `<email>`，IP → `<ip>` |
| **跑完自检** | 扫描输出目录的所有文本文件，确认没有本次用到的网址或凭据原文。**发现即报错，退出码 3** |

第三道是关键：不是「我说我没记录」，而是**每次跑完都给你看扫描结果**。

## 安装

```bash
npm install browser-pilot
# 或从源码
git clone https://github.com/dsAI-Q/browser-pilot.git
cd browser-pilot && npm install
```

需要 Node ≥ 18，以及本机已安装 Chrome 或 Edge。
**不会下载 Chromium**——`playwright-core` 复用系统浏览器（`channel: 'chrome'`）。

## 30 秒跑通

```bash
# 1. 写一个脚本（里面没有任何密码）
cat > my.json <<'JSON'
{
  "steps": [
    { "type": "goto", "url": "https://example.com/login" },
    { "type": "login", "userSelector": "#user", "passSelector": "#pass", "submitSelector": "button[type=submit]" },
    { "type": "wait", "ms": 2500 },
    { "type": "shot", "name": "after-login" },
    { "type": "text", "selector": "body" }
  ]
}
JSON

# 2. 账号密码走环境变量，不进脚本
set BP_USER=your-account      # Windows
set BP_PASS=your-password
browser-pilot run my.json
```

输出：

```
[OK ] #0 goto  http 200 (812ms)
[OK ] #1 login (1204ms)
[OK ] #2 wait (2503ms)
[OK ] #3 shot  after-login.png (298ms)
[OK ] #4 text  Welcome back (12ms)
输出目录：./.bp-out/20261125-181530
⚠ 留痕自检：通过（输出目录内无网址与凭据原文）
```

或者走自检：

```bash
npm run smoke
# 9 项检查，含「整个输出目录无网址原文」
```

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
| `wait` | 等待 | `ms` 或 `selector` / `text` + `state` |
| `shot` | 截图 | `name`、`fullPage` |
| `click` | 点击 | `selector` / `text` / `role`+`name` / `placeholder` / `label` |
| `fill` | 填空 | 同上定位 + `value` 或 `valueFrom` |
| `press` | 按键 | `key`（默认 Enter） |
| `login` | 登录组合动作 | `userSelector`、`passSelector`、`submitSelector` |
| `text` | 取文字 | 定位（不给则取 body）、`max` |
| `title` | 取标题 | — |
| `count` | 元素计数 | `selector` |
| `scroll` | 滚动 | `y` |

### 凭据的两种写法

```json
// ❌ 不要这样：密码进了文件，会被提交进 Git
{ "type": "fill", "selector": "#pass", "value": "mypassword" }

// ✅ 这样：文件里只有「从运行时凭据取」的声明
{ "type": "fill", "selector": "#pass", "valueFrom": "pass" }
```

凭据来源优先级：`--creds-stdin` > `--creds-file` > 环境变量 `BP_USER` / `BP_PASS`。

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
  "targetFingerprint": "h_3f9a1c2e",
  "steps": 5,
  "failed": 0,
  "screenshots": 2,
  "zeroRetention": true
}
```

`targetFingerprint` 是站点主机的 SHA-256 前 8 位——**能区分「跑了哪个站」，但无法反推出网址**。

## 它不做什么（重要）

- ❌ **不接管你已经登录的浏览器**。那需要持久化 profile，与零留痕冲突。想复用登录态请退出本工具的使用场景。
- ❌ 不后台常驻、不注册开机启动、不监听端口
- ❌ 不上传任何数据，不收集遥测
- ❌ 不读你系统里其他浏览器的数据

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
不需要任何账号，可在 CI 直接跑。

## License

MIT © 2026 大圣AI ([@dsAI-Q](https://github.com/dsAI-Q))
