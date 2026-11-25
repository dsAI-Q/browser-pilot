/**
 * 凭据：记住（DPAPI 用户级加密）+ 图形弹框。
 *
 * 为什么不是明文文件：
 *   「长期保留」要能落到磁盘，就必须加密。这里用 Windows DPAPI
 *   （ConvertFrom-SecureString），密文只能被当前 Windows 用户解开，
 *   拷到别的机器或别的账户都无效。
 *
 * 为什么要图形弹框：
 *   agent 调脚本时没有终端，终端提示会直接挂死或报错；
 *   弹一个小窗口，用户点两下就完事，这才是「小白能用」。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUI_PS1 = path.join(HERE, 'gui-prompt.ps1')

function storeDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'browser-pilot')
  }
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'browser-pilot')
}

function storeFile() {
  return path.join(storeDir(), 'creds.json')
}

/** 登录态快照目录（auth.mjs 用） */
export function authDir() {
  return path.join(storeDir(), 'auth')
}

function key(site) {
  return String(site || 'unknown').toLowerCase()
}

function ps(command, input) {
  if (process.platform !== 'win32') {
    throw new Error(`DPAPI 加密只在 Windows 上可用（当前系统：${process.platform}）`)
  }
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { input, encoding: 'utf8', timeout: 20000, windowsHide: true }
    )
  } catch (err) {
    const code = err && err.code
    if (code === 'EPERM' || code === 'ENOENT') {
      throw new Error(
        '调不起 powershell.exe，DPAPI 加密不可用（所在环境禁止启动子进程，或 PowerShell 被移除）。' +
          '这种情况请改用 --creds-stdin / --ephemeral，别依赖「长期保留」。'
      )
    }
    throw err
  }
}

export function protect(plain) {
  const hex = ps(
    '$i=[Console]::In.ReadToEnd().TrimEnd([char]13,[char]10);' +
      '$s=ConvertTo-SecureString $i -AsPlainText -Force;' +
      '[Console]::Out.Write((ConvertFrom-SecureString $s))',
    plain
  ).trim()
  if (!hex) throw new Error('DPAPI 加密失败')
  return hex
}

export function unprotect(hex) {
  const plain = ps(
    '$t=[Console]::In.ReadToEnd().Trim();' +
      '$s=ConvertTo-SecureString $t;' +
      '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);' +
      '[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))',
    hex
  )
  return plain
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 取该站点记住的凭据；没有或解不开就返回 null（不抛错，避免坏文件挡住流程）。
 */
export function loadRemembered(site) {
  const rec = readStore()[key(site)]
  if (!rec || !rec.u || !rec.p) return null
  try {
    return { user: unprotect(rec.u), pass: unprotect(rec.p) }
  } catch {
    return null
  }
}

export function saveRemembered(site, { user, pass }) {
  const store = readStore()
  store[key(site)] = {
    u: protect(String(user)),
    p: protect(String(pass)),
    at: new Date().toISOString(),
  }
  fs.mkdirSync(storeDir(), { recursive: true })
  fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2), 'utf8')
  return storeFile()
}

export function forgetRemembered(site) {
  const store = readStore()
  const k = key(site)
  if (!(k in store)) return false
  delete store[k]
  fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2), 'utf8')
  return true
}

/**
 * 图形弹框问账号密码，带「长期保留」勾选。
 * @returns {{user:string, pass:string, remember:boolean}
 *          | {cancelled:true}
 *          | null}  null = 弹不出来（非 Windows / 无桌面），cancelled = 用户点了取消
 */
export function askViaGui(site) {
  if (process.platform !== 'win32') return null
  let out = ''
  let code = 0
  try {
    out = execFileSync(
      'powershell.exe',
      [
        '-STA',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        GUI_PS1,
        '-Site',
        String(site || 'this site'),
      ],
      { encoding: 'utf8', timeout: 180000, windowsHide: true }
    )
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1
    out = String(err.stdout || '')
    // 退出码 3 = 用户取消；其他（powershell 起不来、无桌面）= 弹不出来
    if (code === 3) return { cancelled: true }
    if (!out) return null
  }
  if (code !== 0 && !out) return null
  try {
    const obj = JSON.parse(out.trim() || '{}')
    if (obj.cancelled) return { cancelled: true }
    if (!obj.user || !obj.pass) return { cancelled: true }
    return { user: obj.user, pass: obj.pass, remember: !!obj.remember }
  } catch {
    return null
  }
}
