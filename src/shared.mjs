/**
 * 共享浏览器：一个「一直开着」的 Chrome，登录一次，之后所有脚本复用同一份登录态。
 *
 * 为什么不接用户自己那个 Chrome：
 * Chrome 136+ 起禁止对默认配置目录开 --remote-debugging-port（安全策略），
 * 外部进程无法接管一个普通启动的 Chrome。所以这里自己起一个带调试端口的实例，
 * 用独立的配置目录，进程 detach 出去——CLI 跑完它也不关。
 *
 * 与零留痕的关系：
 *   默认（本文件）= 会话保留，登录态在 profileDir 里；
 *   --ephemeral   = 老的零留痕模式（session.mjs 的 openSession）。
 * 两种模式都给，由调用方显式选择，文档里写清楚。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright-core'
import { DEFAULT_VIEWPORT } from './session.mjs'

// 默认端口刻意避开 9222：9222 留给你自己 Chrome 的 chrome://inspect 开关，
// 两边抢同一个端口会让「附着你的浏览器」直接失效。
const DEFAULT_PORT = Number(process.env.BP_CDP_PORT || 9333)

function defaultProfileDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'browser-pilot', 'profile')
  }
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'browser-pilot', 'profile')
}

function chromeCandidates(channel) {
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files'
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const chrome = [
    path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  const edge = [
    path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/microsoft-edge',
  ]
  return channel === 'msedge' ? [...edge, ...chrome] : [...chrome, ...edge]
}

function findBrowserExe(channel) {
  for (const p of chromeCandidates(channel)) {
    try {
      if (p && fs.existsSync(p)) return p
    } catch {}
  }
  throw new Error('找不到 Chrome/Edge，请确认已安装，或用 BP_CHROME 指定可执行文件路径')
}

export async function cdpAlive(port = DEFAULT_PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1200),
    })
    return r.ok
  } catch {
    return false
  }
}

async function waitCdp(port, timeoutMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await cdpAlive(port)) return true
    await new Promise((r) => setTimeout(r, 350))
  }
  return false
}

function launchChrome({ exe, port, profileDir }) {
  fs.mkdirSync(profileDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,ChromeWhatsNewUI',
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    'about:blank',
  ]
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid
}

/** 目标页复用：只复用同主机名的标签页；绝不接管别人的标签 */
function pickPage(context, host) {
  if (!host) return null;
  const pages = context.pages();
  const hit = pages.find((p) => {
    try {
      return new URL(p.url()).host === host;
    } catch {
      return false;
    }
  });
  return hit || null;
}

/**
 * 打开（或复用）共享浏览器会话。
 * @param {object} opts { port, profileDir, channel, targetHost, timeout, ephemeral }
 */
export async function openSharedSession(opts = {}) {
  const {
    port = DEFAULT_PORT,
    profileDir = process.env.BP_PROFILE_DIR || defaultProfileDir(),
    channel = 'chrome',
    targetHost = '',
    timeout = 15000,
  } = opts

  const netErrors = []
  let launchedPid = null

  if (!(await cdpAlive(port))) {
    const exe = process.env.BP_CHROME || findBrowserExe(channel)
    launchedPid = launchChrome({ exe, port, profileDir })
    if (!(await waitCdp(port))) {
      throw new Error(
        `共享浏览器启动失败（端口 ${port}）。可能是端口被占用或浏览器被策略拦截；` +
          `可设 BP_CDP_PORT 换端口重试。`
      )
    }
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (err) {
    throw new Error(
      `连不上共享浏览器（端口 ${port}）。可能是该端口被别的程序占用，` +
        `用 --cdp-port 换一个端口重试。原始错误：${err.message}`
    );
  }
  const context = browser.contexts()[0] || (await browser.newContext({ viewport: DEFAULT_VIEWPORT }))
  context.setDefaultTimeout(timeout)
  context.setDefaultNavigationTimeout(timeout)

  let page = pickPage(context, targetHost)
  if (!page) page = await context.newPage()

  const record = (request) => {
    let host = ''
    try {
      host = new URL(request.url()).host
    } catch {
      host = 'invalid'
    }
    const failure = request.failure()
    netErrors.push({
      host,
      method: request.method(),
      resource: request.resourceType(),
      error: failure ? String(failure.errorText).slice(0, 120) : 'unknown',
    })
  }
  page.on('requestfailed', record)

  async function close() {
    // 刻意不调用 browser.close()：那会把用户正在用的这个窗口关掉。
    // 只摘掉监听，剩下的连接由 CLI 结尾的 process.exit 收掉。
    try {
      page.off('requestfailed', record)
    } catch {}
  }

  return {
    browser,
    context,
    page,
    close,
    netErrors,
    shared: true,
    profileDir,
    cdpPort: port,
    reused: !launchedPid,
  }
}
