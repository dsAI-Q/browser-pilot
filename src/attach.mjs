/**
 * 附着到你「正在用的那个 Chrome」。
 *
 * 背景：Chrome 136 起禁止对默认配置目录开 --remote-debugging-port（安全策略），
 * 所以外部程序无法用命令行方式接管一个普通启动的 Chrome。
 * 但 Chrome 144+ 提供界面开关：chrome://inspect/#remote-debugging 打开远程调试，
 * 它会在 user-data-dir 根目录写出 DevToolsActivePort（第一行端口、第二行浏览器 ws 路径），
 * 默认配置也就被允许了。首次连接 Chrome 会弹一次授权框，用户点允许即可。
 *
 * 我们只做「读文件 + 连 ws」，不去碰 Chrome 的命令行，也不复制 profile。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

export class AttachUnavailable extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'AttachUnavailable'
    this.detail = detail || {}
  }
}

/** 各平台 Chrome 默认配置目录 */
export function defaultChromeUserDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'Google', 'Chrome', 'User Data')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'google-chrome')
}

/**
 * 读 DevToolsActivePort。存在且格式正确才返回，否则 null。
 * 文件格式：
 *   9222
 *   /devtools/browser/<uuid>
 */
export function readActivePort(userDataDir = defaultChromeUserDataDir()) {
  const file = path.join(userDataDir, 'DevToolsActivePort')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (lines.length < 2) return null
  const port = Number(lines[0])
  const wsPath = lines[1]
  if (!Number.isInteger(port) || port <= 0 || !wsPath.startsWith('/devtools/browser/')) return null
  return { port, wsPath, wsUrl: `ws://127.0.0.1:${port}${wsPath}`, file }
}

/** 给人看的开启指引 */
export function attachHelp(userDataDir = defaultChromeUserDataDir()) {
  return [
    '没有检测到 Chrome 的远程调试开关。要接管你正在用的 Chrome（保留登录态），需要：',
    '',
    '  1) Chrome 版本 ≥ 144（chrome://version 可看）',
    '  2) 地址栏打开 chrome://inspect/#remote-debugging ，把远程调试开关打开',
    '  3) 首次连接时 Chrome 会弹一个授权框，点「允许」',
    '',
    `检查的文件：${path.join(userDataDir, 'DevToolsActivePort')}`,
    '',
    '不想开这个开关也可以：不加 --attach，工具会用自己维护的独立浏览器窗口（登录一次后复用）。',
  ].join('\n')
}

function pickPage(context, host) {
  if (!host) return context.pages()[0] || null
  return (
    context.pages().find((p) => {
      try {
        return new URL(p.url()).host === host
      } catch {
        return false
      }
    }) || null
  )
}

/**
 * 连上用户正在用的 Chrome。
 * @param {object} opts { userDataDir, targetHost, timeout }
 */
export async function openAttachedSession(opts = {}) {
  const { userDataDir = defaultChromeUserDataDir(), targetHost = '', timeout = 15000 } = opts
  const ap = readActivePort(userDataDir)
  if (!ap) {
    throw new AttachUnavailable('Chrome 远程调试未开启，无法附着。', { userDataDir })
  }

  let browser
  try {
    browser = await chromium.connectOverCDP(ap.wsUrl, { timeout })
  } catch (err) {
    throw new AttachUnavailable(
      `连接 Chrome 失败（${ap.wsUrl}）。如果 Chrome 刚刚重启过，` +
        `DevToolsActivePort 可能已过期，重新打开一次开关即可。原始错误：${err.message}`,
      { userDataDir, wsUrl: ap.wsUrl }
    )
  }

  const context = browser.contexts()[0]
  if (!context) {
    throw new AttachUnavailable('连上了 Chrome，但拿不到浏览器上下文。', { userDataDir })
  }
  context.setDefaultTimeout(timeout)
  context.setDefaultNavigationTimeout(timeout)

  const netErrors = []
  const record = () => {}
  const page = pickPage(context, targetHost) || (await context.newPage())
  const onFail = (request) => {
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
  page.on('requestfailed', onFail)

  async function close() {
    // 绝不关闭用户的浏览器，只断连
    try {
      page.off('requestfailed', onFail)
    } catch {}
  }

  return {
    browser,
    context,
    page,
    close,
    netErrors,
    shared: true,
    attached: true,
    userDataDir,
    cdpPort: ap.port,
    reused: true,
  }
}
