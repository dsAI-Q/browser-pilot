#!/usr/bin/env node
/**
 * browser-pilot CLI
 *
 * 用法：
 *   browser-pilot run <script.json> [选项]
 *
 * 选项：
 *   --out <dir>         输出目录（默认 ./.bp-out/<时间戳>）
 *   --headed            显示浏览器窗口（默认无头）
 *   --channel <name>    chrome（默认）| msedge
 *   --timeout <ms>      单步默认超时，默认 15000
 *   --creds-file <p>    从 JSON 文件读凭据 {user, pass}
 *   --creds-stdin       从标准输入读凭据 JSON
 *   --no-audit          跳过留痕自检（不推荐，仅供调试）
 *
 * 凭据来源优先级：--creds-stdin > --creds-file > 环境变量 BP_USER / BP_PASS
 *
 * 退出码：0 成功 / 1 有步骤失败 / 2 用法错误 / 3 留痕自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession } from './session.mjs';
import { runSteps } from './actions.mjs';
import { makeRedactor, hostFingerprint } from './redact.mjs';
import { prepareOutputDir, auditNoLeak } from './policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function usage(code = 0) {
  const text = fs.readFileSync(path.join(HERE, '..', 'docs', 'USAGE.txt'), 'utf8');
  process.stdout.write(text);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headed') out.headed = true;
    else if (a === '--creds-stdin') out.credsStdin = true;
    else if (a === '--no-audit') out.noAudit = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--channel') out.channel = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--creds-file') out.credsFile = argv[++i];
    else if (a.startsWith('-')) {
      process.stderr.write(`未知选项：${a}\n`);
      usage(2);
    } else out._.push(a);
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function loadCredentials(args) {
  // --creds-stdin 是异步读的，由 main 处理
  if (args.credsStdin) return null;
  if (args.credsFile) {
    return JSON.parse(fs.readFileSync(path.resolve(args.credsFile), 'utf8'));
  }
  const { BP_USER, BP_PASS } = process.env;
  if (BP_USER || BP_PASS) return { user: BP_USER, pass: BP_PASS };
  return null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') usage(0);

  const cmd = argv[0];
  if (cmd !== 'run') {
    process.stderr.write(`未知命令：${cmd}\n`);
    usage(2);
  }

  const args = parseArgs(argv.slice(1));
  const scriptPath = args._[0];
  if (!scriptPath) {
    process.stderr.write('缺少脚本文件路径\n');
    usage(2);
  }

  const script = JSON.parse(fs.readFileSync(path.resolve(scriptPath), 'utf8'));

  // ---- 凭据 ----
  let credentials = loadCredentials(args);
  if (args.credsStdin) {
    credentials = JSON.parse(await readStdin());
  }
  const secrets = [credentials?.user, credentials?.pass].filter(Boolean);

  // ---- 收集本次出现过的网址，用于泄漏自检 ----
  const urls = [
    script.url,
    ...(script.steps || []).map((s) => s.url).filter(Boolean),
  ].filter(Boolean);

  const redact = makeRedactor(secrets);

  // ---- 输出目录 ----
  const outDir = prepareOutputDir(
    args.out || path.join(process.cwd(), '.bp-out', stamp())
  );

  const transcript = [];
  const log = (entry) => {
    const ok = entry.ok ? 'OK ' : 'FAIL';
    const extra =
      entry.error ? `  ${entry.error}` :
      entry.file ? `  ${entry.file}` :
      entry.status !== undefined ? `  http ${entry.status}` :
      entry.title ? `  ${entry.title}` :
      entry.text ? `  ${String(entry.text).slice(0, 160).replace(/\s+/g, ' ')}` :
      entry.count !== undefined ? `  ${entry.count}` : '';
    transcript.push(`[${ok}] #${entry.index} ${entry.type}${extra} (${entry.ms}ms)`);
  };

  const session = await openSession({
    headless: !args.headed,
    channel: args.channel || 'chrome',
    timeout: args.timeout || 15000,
  });

  let results = [];
  let fatal = null;
  try {
    results = await runSteps(session.page, script.steps || [], {
      outDir,
      redact,
      credentials,
      log,
    });
  } catch (err) {
    fatal = redact(err?.message || String(err));
  } finally {
    await session.close();
  }

  // ---- 落盘（全部脱敏）----
  const targetUrl = urls[0];
  const manifest = {
    tool: 'browser-pilot',
    version: '0.1.0',
    startedAt: new Date().toISOString(),
    targetFingerprint: targetUrl ? hostFingerprint(targetUrl) : null,
    steps: results.length,
    failed: results.filter((r) => !r.ok).length,
    screenshots: results.filter((r) => r.file).length,
    zeroRetention: true,
    note: '本文件不含网址、账号或密码原文；targetFingerprint 是站点主机的不可逆哈希。',
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'steps.json'), JSON.stringify(results, null, 2));

  process.stdout.write(transcript.join('\n') + '\n');
  process.stdout.write(`输出目录：${outDir}\n`);

  // ---- 留痕自检 ----
  if (!args.noAudit) {
    try {
      auditNoLeak(outDir, [...secrets, ...urls]);
      process.stdout.write('留痕自检：通过（输出目录内无网址与凭据原文）\n');
    } catch (err) {
      process.stderr.write(`留痕自检：失败 — ${redact(err.message)}\n`);
      return 3;
    }
  }

  if (fatal) {
    process.stderr.write(`执行中断：${fatal}\n`);
    return 1;
  }
  return results.some((r) => !r.ok) ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`未捕获错误：${err?.stack || err}\n`);
    process.exit(1);
  });
