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
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'browser-pilot')
}

function storeFile() {
  return path.join(storeDir(), 'creds.json')
}

function key(site) {
  return String(site || 'unknown').toLowerCase()
}

function ps(command, input) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { input, encoding: 'utf8', timeout: 20000, windowsHide: true }
  )
}

function protect(plain) {
  const hex = ps(
    '$i=[Console]::In.ReadToEnd().TrimEnd([char]13,[char]10);' +
      '$s=ConvertTo-SecureString $i -AsPlainText -Force;' +
      '[Console]::Out.Write((ConvertFrom-SecureString $s))',
    plain
  ).trim()
  if (!hex) throw new Error('DPAPI 加密失败')
  return hex
}

function unprotect(hex) {
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
 * @returns {{user:string, pass:string, remember:boolean}|null} 用户取消时返回 null
 */
export function askViaGui(site) {
  if (process.platform !== 'win32') return null
  let out = ''
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
      { encoding: 'utf8', timeout: 300000, windowsHide: true }
    )
  } catch (err) {
    // 退出码 3 = 用户取消
    out = String(err.stdout || '')
    if (out && /cancelled/.test(out)) return null
    return null
  }
  try {
    const obj = JSON.parse(out.trim() || '{}')
    if (obj.cancelled || !obj.user || !obj.pass) return null
    return { user: obj.user, pass: obj.pass, remember: !!obj.remember }
  } catch {
    return null
  }
}
