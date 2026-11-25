/**
 * DSH 插件入口：把 browser-pilot 的 CLI 暴露成两个 agent 工具。
 *
 * 刻意不在 DSH 进程里直接 require('playwright-core')：
 * 宿主进程解析不到本包的依赖。这里改成子进程调用自带的 CLI，
 * Playwright 在子进程里跑，宿主保持干净。
 *
 * 凭据走 env（BP_USER / BP_PASS）经 stdin 传给子进程，
 * 从不进入 argv、不进入工具参数、不进入对话。
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'browser-pilot'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'cli.mjs')

const output = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const MAX_OUT = 6000

function clip(text, max = MAX_OUT) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) + `\n…（已截断，共 ${s.length} 字）` : s
}

/**
 * 跑一次 CLI。凭据从环境变量取，经 stdin 传入，绝不写进命令行参数。
 */
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

    // 凭据来源（按优先级）：BP_CREDS（一行「账号|密码」）→ BP_USER/BP_PASS → DSH 安全卡片同名密钥
    const pair = process.env.BP_CREDS || process.env.DSH_SECRET_BP_CREDS
    const user = process.env.BP_USER || process.env.DSH_SECRET_BP_USER
    const pass = process.env.BP_PASS || process.env.DSH_SECRET_BP_PASS
    if (pair) {
      // 原样交给 CLI，由它按「账号|密码」拆开；凭据只出现在子进程的标准输入里
      child.stdin.write(pair)
      child.stdin.end()
    } else if (user || pass) {
      // 走 --creds-stdin：凭据只存在于子进程的标准输入里
      child.stdin.write(JSON.stringify({ user, pass }))
      child.stdin.end()
    } else if (child.stdin) {
      child.stdin.end()
    }
  })
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
              'Zero-retention mode: a fresh throwaway context with no cookies or history on disk. Off by default, because it cannot reuse an existing sign-in.',
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
              'Name of a saved cookie snapshot (see `browser-pilot auth save <name>`) to load before the steps run.',
          },
        },
        output,
        async execute({ scriptPath, outDir, headed, profile, ephemeral, noGui, attach, noAttach, auth }) {
          if (!scriptPath) return 'Missing scriptPath.'
          const args = ['run', path.resolve(workDir, scriptPath)]
          if (outDir) args.push('--out', path.resolve(workDir, outDir))
          if (headed) args.push('--headed')
          if (profile) args.push('--profile', path.resolve(workDir, profile))
          if (ephemeral) args.push('--ephemeral')
          if (attach) args.push('--attach')
          if (noAttach) args.push('--no-attach')
          if (auth) args.push('--auth', String(auth))
          args.push('--channel', channel, '--timeout', String(timeout))
          if (process.env.BP_CREDS || process.env.DSH_SECRET_BP_CREDS || process.env.BP_USER || process.env.BP_PASS || process.env.DSH_SECRET_BP_USER || process.env.DSH_SECRET_BP_PASS) args.push('--creds-stdin')
          else if (noGui) args.push('--no-gui', '--no-prompt')
          // 否则不传任何提示相关开关：让它弹图形弹窗问用户（这是 agent 场景下的正确做法）

          const r = await runCli(args)
          const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n')
          return clip(`exit ${r.code}\n${body}`)
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
          'Needs no credentials and never writes browsing history to disk.',
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
          // 脚本放在系统临时目录：输出目录必须由 CLI 自己创建（它只写空目录）
          const os = await import('node:os')
          const fs = await import('node:fs/promises')
          const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-shot-'))
          const tmp = path.join(tmpDir, 'script.json')
          await fs.writeFile(tmp, JSON.stringify(script), 'utf8')

          const r = await runCli(['run', tmp, '--out', dir, '--no-prompt', '--channel', channel])
          await fs.rm(tmpDir, { recursive: true, force: true })
          const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n')
          return clip(`exit ${r.code}\n${body}`)
        },
      }),
    'browser-pilot browser_shot'
  )
}
