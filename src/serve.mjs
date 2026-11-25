/**
 * 常驻执行器（daemon）。
 *
 * 为什么需要它：Chrome 的 chrome://inspect 开关**按每个新连接**弹一次授权框。
 * CLI 每次运行都是一个新连接，所以每跑一次就要点一次「允许」——没法用。
 * 这里起一个长活进程，由它持有唯一那条 CDP 连接，之后每次运行把「作业」发进来执行，
 * Chrome 那边只见一个客户端，授权一次就够。
 *
 * 协议：stdin/stdout 上的 NDJSON（一行一个 JSON），私有管道，不监听端口。
 *   入：{type:'job', script:{...}, outDir:'...', creds?:{user,pass}}
 *       {type:'ping'} / {type:'quit'}
 *   出：{type:'ready', sessionMode, attachVia}
 *       {type:'result', id, ok, transcript, results, manifest, outDir, error}
 *       {type:'pong'}
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAttachedSession, AttachUnavailable } from './attach.mjs';
import { openSharedSession } from './shared.mjs';
import { runSteps } from './actions.mjs';
import { makeRedactor, hostFingerprint } from './redact.mjs';
import { prepareOutputDir, auditNoLeak } from './policy.mjs';
import { VERSION } from './version.mjs';

function parseArgs(argv) {
  const out = { mode: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--attach') out.mode = 'attach';
    else if (a === '--shared') out.mode = 'shared';
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--channel') out.channel = argv[++i];
    else if (a === '--idle-minutes') out.idleMinutes = Number(argv[++i]);
  }
  return out;
}

/** 常驻进程的 pid 文件：插件重载时靠它接管/清理上一个实例 */
const STATE_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'browser-pilot'
);
const PID_FILE = path.join(STATE_DIR, 'serve.json');

function writePidFile() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      PID_FILE,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      'utf8'
    );
  } catch {}
}

function removePidFile() {
  try {
    const cur = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (cur.pid === process.pid) fs.unlinkSync(PID_FILE);
  } catch {}
}
function siteOf(script) {
  const urls = [script.url, ...(script.steps || []).map((s) => s.url).filter(Boolean)].filter(Boolean);
  let host = '';
  try {
    host = new URL(urls[0]).host;
  } catch {
    host = '';
  }
  return { urls, host };
}

const args = parseArgs(process.argv.slice(2));

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  process.stdout.write(
    [
      '用法：node src/serve.mjs [选项]',
      '',
      '常驻执行器：持有唯一一条 CDP 连接，从 stdin 读 NDJSON 作业，向 stdout 写 NDJSON 结果。',
      'Chrome 只在它启动时要一次「允许」，之后所有作业复用这条连接。',
      '',
      '选项：',
      '  --attach            必须附着你现有的 Chrome（失败就退出并报错）',
      '  --shared            只用工具自己维护的窗口',
      '  （都不给）          自动：优先 attach，拿不到再退回 shared',
      '  --timeout <ms>      单步默认超时',
      '  --channel <name>    chrome（默认）| msedge',
      '  --idle-minutes <n>  空闲多久自动退出，默认 15',
      '',
      '协议：',
      '  入 {"type":"job","id":1,"outDir":"...","script":{...},"creds":{...}}',
      '  入 {"type":"ping"} / {"type":"quit"}',
      '  出 {"type":"ready",...} / {"type":"result",...} / {"type":"error",...}',
    ].join('\n') + '\n'
  );
  process.exit(0);
}
const timeout = args.timeout || 15000;

let session = null;
let sessionInfo = {};

async function ensureSession() {
  if (session) return session;
  if (args.mode === 'shared') {
    session = await openSharedSession({ channel: args.channel || 'chrome', timeout });
    sessionInfo = { sessionMode: 'shared', attachVia: null };
    return session;
  }
  if (args.mode === 'attach') {
    session = await openAttachedSession({ timeout });
    sessionInfo = { sessionMode: 'attached', attachVia: session.attachVia || null };
    return session;
  }
  // auto：优先附着你自己的浏览器（带登录态），拿不到再退回自己维护的窗口
  try {
    session = await openAttachedSession({ timeout });
    sessionInfo = { sessionMode: 'attached', attachVia: session.attachVia || null };
  } catch (err) {
    if (!(err instanceof AttachUnavailable)) throw err;
    session = await openSharedSession({ channel: args.channel || 'chrome', timeout });
    sessionInfo = { sessionMode: 'shared', attachVia: null, attachSkipped: err.message };
  }
  return session;
}

/** 跑一个作业：写输出、执行步骤、落盘、留痕自检 */
async function runJob(job) {
  const { script = {}, outDir, creds } = job;
  const steps = script.steps || [];
  const { urls, host } = siteOf(script);

  const secrets = [creds?.user, creds?.pass].filter(Boolean);
  const redact = makeRedactor(secrets);

  const dir = prepareOutputDir(outDir);
  const s = await ensureSession();

  // 同主机的标签优先复用；没给站点时，附着你自己的浏览器就读你正在看的那个
  // 真实网页（跳过 about:blank / chrome:// 这类页面），并把自己新开的标签在作业结束关掉。
  let page = null;
  let created = false;
  const isWeb = (p) => {
    try {
      return /^https?:/i.test(p.url());
    } catch {
      return false;
    }
  };
  if (host) {
    page =
      s.context.pages().find((p) => {
        try {
          return new URL(p.url()).host === host;
        } catch {
          return false;
        }
      }) || null;
  }
  if (!page && sessionInfo.sessionMode === 'attached') {
    const web = s.context.pages().filter(isWeb);
    page = web.length ? web[web.length - 1] : null;
  }
  if (!page) {
    page = await s.context.newPage();
    created = true;
  }

  const transcript = [];
  const pick = (e) => {
    if (e.error) return `  ${e.error}`;
    if (e.file) return `  ${e.file}`;
    if (e.status !== undefined) return `  http ${e.status}`;
    if (e.neterrors) return `  ${e.neterrors}`;
    if (e.frames) return `  frames=${e.frames}`;
    if (e.frame) return `  frame=${e.frame}`;
    if (e.urlHost) return `  host=${e.urlHost}`;
    if (e.pages) return `  ${e.pages}`;
    if (e.title) return `  ${e.title}`;
    if (e.snapshot) return `  ${e.count} 个引用${e.refsFile ? '（refs.json）' : ''}`;
    if (e.asserted) return '  ok';
    if (e.probe) return `  共 ${e.probe.total} 个`;
    if (e.box) return `  ${e.box}`;
    if (e.text) return `  ${String(e.text).slice(0, 160).replace(/\s+/g, ' ')}`;
    if (e.count !== undefined) return `  ${e.count}`;
    return '';
  };
  const log = (entry) => {
    const ok = entry.ok ? 'OK ' : 'FAIL';
    const retried = entry.retriedAfter ? `（重试 ${entry.retriedAfter} 次后成功）` : '';
    transcript.push(`[${ok}] #${entry.index} ${entry.type}${pick(entry)} (${entry.ms}ms)${retried}`);
  };

  let results = [];
  let fatal = null;
  try {
    results = await runSteps(page, steps, {
      outDir: dir,
      redact,
      credentials: creds || null,
      netErrors: s.netErrors,
      log,
      state: { frame: null, frameLabel: null, refs: {} },
    });
  } catch (err) {
    fatal = redact(err?.message || String(err));
  } finally {
    // 自己开的标签自己收，别在你浏览器里堆空白页
    if (created && job.keepPage !== true) {
      try {
        await page.close();
      } catch {}
    }
  }

  const manifest = {
    tool: 'browser-pilot',
    version: VERSION,
    startedAt: new Date().toISOString(),
    targetFingerprint: urls[0] ? hostFingerprint(urls[0]) : null,
    accountProvided: secrets.length > 0,
    steps: results.length,
    failed: results.filter((r) => !r.ok).length,
    screenshots: results.filter((r) => r.file).length,
    zeroRetention: false,
    sessionMode: sessionInfo.sessionMode,
    attachVia: sessionInfo.attachVia,
    viaDaemon: true,
    note: '本文件不含网址、账号或密码原文；targetFingerprint 是站点主机的不可逆哈希。',
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'steps.json'), JSON.stringify(results, null, 2));

  let audit = '通过（输出目录内无网址与凭据原文）';
  try {
    auditNoLeak(dir, [...secrets, ...urls]);
  } catch (err) {
    audit = `失败 — ${redact(err.message)}`;
  }

  const code = audit.startsWith('失败') ? 3 : fatal ? 1 : results.some((r) => !r.ok) ? 1 : 0;
  return { transcript, results, manifest, outDir: dir, audit, fatal, code };
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ type: 'error', error: 'job 不是合法 JSON' });
      continue;
    }
    handle(msg).catch((err) => send({ type: 'error', error: String(err?.message || err) }));
  }
});

async function handle(msg) {
  const id = msg.id || null;
  if (msg.type === 'ping') return send({ type: 'pong', id });
  if (msg.type === 'quit') {
    try {
      await session?.close();
    } catch {}
    removePidFile();
    return process.exit(0);
  }
  if (msg.type !== 'job') return send({ type: 'error', id, error: `未知消息类型 ${msg.type}` });

  touchIdle();
  try {
    const r = await runJob(msg);
    send({ type: 'result', id, ...r });
  } catch (err) {
    const message = err?.message || String(err);
    // 会话掉了（Chrome 重启、开关关掉）就丢掉旧会话，下次重建
    if (err instanceof AttachUnavailable || /closed|Target|Session/.test(message)) {
      try {
        await session?.close();
      } catch {}
      session = null;
    }
    send({ type: 'error', id, error: message });
  }
}

/** 空闲太久就自己退：不长期占着你的浏览器的调试连接 */
const IDLE_MS = Number(args.idleMinutes || 15) * 60 * 1000;
let idleTimer = null;
function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    try {
      await session?.close();
    } catch {}
    removePidFile();
    process.exit(0);
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

process.stdin.on('end', async () => {
  try {
    await session?.close();
  } catch {}
  process.exit(0);
});

// 启动即建立连接，把「一次授权」花在启动这一刻，而不是每个作业上
(async () => {
  try {
    await ensureSession();
    writePidFile();
    touchIdle();
    send({ type: 'ready', ...sessionInfo, version: VERSION, pid: process.pid });
  } catch (err) {
    send({ type: 'error', error: err?.message || String(err) });
    process.exit(2);
  }
})();
