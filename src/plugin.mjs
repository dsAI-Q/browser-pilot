/**
 * DSH 插件入口：把 browser-pilot 暴露成两个 agent 工具。
 *
 * 两种执行方式：
 *   1) 常驻执行器（默认）：插件里保留一个长活的 node 进程，由它持有唯一一条
 *      CDP 连接。Chrome 的授权框每个新连接弹一次，所以常驻能把「每跑一次点一次」
 *      降到「开一次点一次」。
 *   2) 一次性 CLI（--ephemeral 或 noDaemon）：直接跑 src/cli.mjs，适合零留痕场景；
 *      这种模式下没有可复用的会话，每次都会是新连接。
 *
 * 凭据走 env（BP_USER / BP_PASS）经 stdin 传给子进程，
 * 从不进入 argv、不进入工具参数、不进入对话。
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { VERSION } from './version.mjs'
import os from 'node:os'
import path from 'node:path'

export const name = 'browser-pilot'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'cli.mjs')
const SERVE = path.join(HERE, 'serve.mjs')

const output = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const MAX_OUT = 6000

function clip(text, max = MAX_OUT) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) + `\n…（已截断，共 ${s.length} 字）` : s
}

function credsFromEnv() {
  const pair = process.env.BP_CREDS || process.env.DSH_SECRET_BP_CREDS
  if (pair) {
    const i = pair.search(/[|｜]/)
    if (i > 0) return { user: pair.slice(0, i).trim(), pass: pair.slice(i + 1) }
  }
  const user = process.env.BP_USER || process.env.DSH_SECRET_BP_USER
  const pass = process.env.BP_PASS || process.env.DSH_SECRET_BP_PASS
  return user || pass ? { user, pass } : null
}

function readScriptFile(p) {
  const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  return JSON.parse(raw)
}

// ---------------------------------------------------------------- 常驻执行器

let serveProc = null
let serveBuf = ''
let serveReady = null
let serveErr = ''
let serveInfo = null
let nextId = 1
const pending = new Map()

function ensureServe() {
  if (serveProc) return serveReady
  const child = spawn(process.execPath, [SERVE], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  serveProc = child
  serveBuf = ''
  serveErr = ''
  serveReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('常驻执行器启动超时（等 Chrome 授权？）')), 90000)
    let settled = false

    const onLine = (line) => {
      if (!line) return
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.type === 'ready') {
        serveInfo = msg
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve(msg)
        }
        return
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        p(msg)
        return
      }
      if (msg.type === 'error' && !msg.id && !settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(msg.error || '常驻执行器启动失败'))
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      serveBuf += chunk
      let i
      while ((i = serveBuf.indexOf('\n')) >= 0) {
        const line = serveBuf.slice(0, i).trim()
        serveBuf = serveBuf.slice(i + 1)
        onLine(line)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      serveErr = (serveErr + String(d)).slice(-2000)
    })
    child.on('exit', (code) => {
      serveProc = null
      serveReady = null
      for (const [, fn] of pending) fn({ type: 'error', error: `常驻执行器已退出（code ${code}）${serveErr.slice(-300)}` })
      pending.clear()
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`常驻执行器启动失败（code ${code}）${serveErr.slice(-300)}`))
      }
    })
  })
  return serveReady
}

async function runViaServe(job, timeoutMs = 900000) {
  await ensureServe()
  // 常驻进程可能是上一个版本的代码（插件热重载后旧子进程还活着），
  // 版本对不上就换掉它，否则新动作会被旧进程当成「未知动作类型」。
  if (serveInfo && serveInfo.version !== VERSION) {
    try {
      serveProc.stdin.write(JSON.stringify({ type: 'quit' }) + '\n')
    } catch {}
    try {
      serveProc.kill()
    } catch {}
    serveProc = null
    serveReady = null
    serveInfo = null
    await ensureServe()
  }
  const id = nextId++
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('常驻执行器执行超时'))
    }, timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    try {
      serveProc.stdin.write(JSON.stringify({ type: 'job', ...job, id }) + '\n')
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err)
    }
  })
}

function formatServeResult(msg) {
  if (msg.type === 'error') return `常驻执行器报错：${msg.error}`
  const lines = [];
  if (msg.transcript?.length) lines.push(...msg.transcript)
  for (const r of msg.results || []) {
    if (r.snapshot) {
      lines.push(`\n--- snapshot #${r.index}（${r.count} 个可交互元素）---`, r.snapshot)
    }
  }
  lines.push(`输出目录：${msg.outDir}`)
  lines.push(`留痕自检：${msg.audit}`)
  lines.push(`执行方式：常驻连接（${msg.manifest?.sessionMode}${msg.manifest?.attachVia ? '·' + msg.manifest.attachVia : ''}）`)
  return `exit ${msg.code}\n` + lines.join('\n')
}

// ---------------------------------------------------------------- 一次性 CLI

function runCli(args, { timeoutMs = 900000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      }
    )
    const creds = credsFromEnv()
    if (creds) {
      child.stdin.write(JSON.stringify(creds))
      child.stdin.end()
    } else if (child.stdin) {
      child.stdin.end()
    }
  })
}

/**
 * 跑一份脚本：优先常驻连接，失败则退回一次性 CLI（并把原因写在输出里）。
 */
async function executeScript({ script, outDir, ephemeral, noDaemon, useGui }) {
  const creds = credsFromEnv()

  if (!ephemeral && !noDaemon) {
    try {
      const msg = await runViaServe({ script, outDir, creds })
      if (msg.type !== 'error') return formatServeResult(msg)
      // 常驻报错：清掉，退回一次性执行
      try {
        serveProc?.kill()
      } catch {}
      serveProc = null
      serveReady = null
      const fallback = await executeOnce({ script, outDir, ephemeral, useGui })
      return `（常驻连接不可用：${msg.error}；已改用一次性执行）\n${fallback}`
    } catch (err) {
      try {
        serveProc?.kill()
      } catch {}
      serveProc = null
      serveReady = null
      const fallback = await executeOnce({ script, outDir, ephemeral, useGui })
      return `（常驻连接不可用：${err.message}；已改用一次性执行）\n${fallback}`
    }
  }
  return await executeOnce({ script, outDir, ephemeral, useGui })
}

async function executeOnce({ script, outDir, ephemeral, useGui }) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bp-job-'))
  const tmp = path.join(tmpDir, 'script.json')
  await fs.promises.writeFile(tmp, JSON.stringify(script), 'utf8')
  const args = ['run', tmp]
  if (outDir) args.push('--out', outDir)
  if (ephemeral) args.push('--ephemeral')
  if (!useGui) args.push('--no-gui')
  if (!credsFromEnv()) args.push('--no-prompt')
  const r = await runCli(args)
  await fs.promises.rm(tmpDir, { recursive: true, force: true })
  const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n')
  return clip(`exit ${r.code}\n${body}`)
}

export function apply(ctx, config = {}) {
  const workDir = config.workDir || process.cwd()
  const channel = config.channel || 'chrome'
  const timeout = Number(config.timeout || 15000)

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'browser_run',
        description:
          'Run a JSON action script in a real Chrome browser and return a per-step transcript plus screenshots. ' +
          'Reuses an existing sign-in: if Chrome has the chrome://inspect remote-debugging switch on it attaches to that browser and its open tabs, otherwise it uses its own persistent window. ' +
          'Runs go through a resident connection, so Chrome asks for permission once rather than on every call. ' +
          'Supports snapshot (produces ref:eN handles), assertions, retries, and cross-origin iframe switching. ' +
          'Output files are redacted; a post-run leak audit fails the run if a URL or credential reached disk. ' +
          'Credentials are never passed as parameters: they come from the BP_USER / BP_PASS environment variables (or the saved DSH secrets of the same names) and reach the browser through stdin only.',
        parameters: {
          scriptPath: {
            type: 'string',
            required: true,
            description: 'Absolute path of the JSON action script to run.',
          },
          outDir: {
            type: 'string',
            description: 'Directory for screenshots and the run report. Defaults to a timestamped folder under the working folder.',
          },
          headed: {
            type: 'boolean',
            description: 'Show the browser window. Omit to run headless.',
          },
          profile: {
            type: 'string',
            description:
              'Persistent Chrome profile directory. Defaults to %LOCALAPPDATA%\\browser-pilot\\profile. Sign in once in the shared window and later runs reuse it without asking for credentials.',
          },
          ephemeral: {
            type: 'boolean',
            description:
              'Zero-retention mode: a fresh throwaway context with no cookies or history on disk, and no resident connection. Off by default, because it cannot reuse an existing sign-in.',
          },
          noDaemon: {
            type: 'boolean',
            description:
              'Bypass the resident connection and run the one-shot CLI. Each such run is a new CDP client, so Chrome may ask for permission again.',
          },
          noGui: {
            type: 'boolean',
            description:
              'Never open the credential dialog. Use in unattended runs: a script that needs credentials then fails fast instead of waiting for a human.',
          },
          attach: {
            type: 'boolean',
            description:
              'Require attaching to the Chrome you are already using (needs the chrome://inspect/#remote-debugging switch on). Fails with instructions instead of opening a separate browser.',
          },
          noAttach: {
            type: 'boolean',
            description: 'Never attach to your own Chrome; always use the separately managed window.',
          },
          auth: {
            type: 'string',
            description:
              'Name of a saved cookie snapshot (see `browser-pilot auth save <name> --for <host>`) to load before the steps run.',
          },
        },
        output,
        async execute({ scriptPath, outDir, headed, profile, ephemeral, noDaemon, noGui, attach, noAttach, auth }) {
          if (!scriptPath) return 'Missing scriptPath.'
          const abs = path.resolve(workDir, scriptPath)

          // 那些只能由一次性 CLI 表达的选项（profile/attach/auth/headed）走 CLI 路径
          const needsCli = !!(headed || profile || attach || noAttach || auth)

          let script
          try {
            script = readScriptFile(abs)
          } catch (err) {
            return `读脚本失败：${err.message}`
          }
          const resolvedOut = path.resolve(workDir, outDir || `.bp-out/run-${Date.now()}`)

          if (needsCli) {
            const args = ['run', abs, '--out', resolvedOut]
            if (headed) args.push('--headed')
            if (profile) args.push('--profile', path.resolve(workDir, profile))
            if (ephemeral) args.push('--ephemeral')
            if (attach) args.push('--attach')
            if (noAttach) args.push('--no-attach')
            if (auth) args.push('--auth', String(auth))
            args.push('--channel', channel, '--timeout', String(timeout))
            if (!noGui) args.push('--no-gui', '--no-prompt')
            const r = await runCli(args)
            const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n')
            return clip(`exit ${r.code}\n${body}`)
          }

          const text = await executeScript({
            script,
            outDir: resolvedOut,
            ephemeral,
            noDaemon,
            useGui: !noGui,
          })
          return clip(text)
        },
      }),
    'browser-pilot browser_run'
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'browser_shot',
        description:
          'Open one URL in a real Chrome browser and save a full screenshot, returning the file path and the page title. ' +
          'Uses the resident connection when available, so it does not trigger a new Chrome permission prompt each time.',
        parameters: {
          url: { type: 'string', required: true, description: 'The address to open.' },
          outDir: { type: 'string', description: 'Directory for the screenshot. Defaults to a timestamped folder.' },
          fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the viewport.' },
        },
        output,
        async execute({ url, outDir, fullPage }) {
          if (!url) return 'Missing url.'
          const dir = path.resolve(workDir, outDir || '.bp-out/shot-' + Date.now())
          const script = {
            url,
            steps: [
              { type: 'goto', url },
              { type: 'title' },
              { type: 'shot', name: 'page', fullPage: !!fullPage },
            ],
          }
          const text = await executeScript({ script, outDir: dir, ephemeral: false, noDaemon: false, useGui: false })
          return clip(text)
        },
      }),
    'browser-pilot browser_shot'
  )
}
