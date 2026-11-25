/**
 * 登录态快照（cookie auth）。
 *
 * 场景：某个站点你手动登录过一次，但不想为此保留一整个浏览器 profile；
 * 或者要在 CI 里复用登录态。做法是把该会话的 Cookie 存成一个文件，
 * 下次运行前灌回去，就不用再登录。
 *
 * 安全：Cookie 等价于登录凭据，所以落盘前用与凭据相同的 Windows DPAPI 加密
 * （只有本机当前用户能解开）。文件在 %LOCALAPPDATA%\browser-pilot\auth\。
 */
import fs from 'node:fs'
import path from 'node:path'
import { protect, unprotect, authDir } from './creds.mjs'

function dir() {
  return authDir()
}

/** 名字只允许字母数字短横下划线，避免路径穿越 */
export function safeAuthName(name) {
  const s = String(name || '').trim()
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(s)) {
    throw new Error(`名字只能用字母、数字、短横线、下划线（1–40 字符）：${s || '(空)'}`)
  }
  return s
}

function fileOf(name) {
  return path.join(dir(), `${safeAuthName(name)}.dat`)
}

export function existsAuth(name) {
  try {
    return fs.existsSync(fileOf(name))
  } catch {
    return false
  }
}

/**
 * 保存 cookie 快照。
 * @param {string} name 快照名
 * @param {Array<object>} cookies Playwright context.cookies() 的结果
 */
export function saveAuth(name, cookies) {
  const safe = safeAuthName(name)
  const payload = {
    savedAt: new Date().toISOString(),
    version: 1,
    cookies,
  }
  const encrypted = protect(JSON.stringify(payload))
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(fileOf(safe), encrypted, 'utf8')
  return { file: fileOf(safe), count: cookies.length }
}

/** 读取快照，返回 { savedAt, cookies } */
export function loadAuth(name) {
  const file = fileOf(name)
  if (!fs.existsSync(file)) {
    throw new Error(`没有名为 ${safeAuthName(name)} 的登录快照。先手动登录一次，再运行 auth save ${safeAuthName(
      name
    )}`)
  }
  const plain = unprotect(fs.readFileSync(file, 'utf8').trim())
  const data = JSON.parse(plain)
  if (!Array.isArray(data.cookies)) throw new Error('登录快照格式不对，重新 auth save 一次')
  return data
}

/**
 * 列出快照。只解密后统计数量与域名个数，**不输出域名明文**，
 * 避免「为了列表把网址写到别处」。
 */
export function listAuth() {
  const d = dir()
  let names = []
  try {
    names = fs.readdirSync(d).filter((f) => f.endsWith('.dat')).map((f) => f.replace(/\.dat$/, ''))
  } catch {
    return []
  }
  return names.map((name) => {
    try {
      const data = loadAuth(name)
      const domains = new Set(data.cookies.map((c) => c.domain))
      return { name, savedAt: data.savedAt, cookies: data.cookies.length, domains: domains.size }
    } catch {
      return { name, error: '无法解密（可能是别的 Windows 用户保存的）' }
    }
  })
}

export function forgetAuth(name) {
  const file = fileOf(name)
  if (!fs.existsSync(file)) return false
  fs.unlinkSync(file)
  return true
}
