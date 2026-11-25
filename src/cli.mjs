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
 *   --no-prompt         缺少凭据时不要询问，直接报错（适合 CI）
 *   --no-audit          跳过留痕自检（不推荐，仅供调试）
 *
 * 凭据处理：
 *   脚本里只有登录动作（login / valueFrom）时才需要凭据；
 *   真的需要又没提供时，会自动在终端里询问（密码不回显），全程不落盘。
 *
 * 退出码：0 成功 / 1 有步骤失败 / 2 用法或凭据错误 / 3 留痕自检失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSession } from './session.mjs';
import { runSteps } from './actions.mjs';
import { makeRedactor, hostFingerprint } from './redact.mjs';
import { prepareOutputDir, auditNoLeak } from './policy.mjs';
import {
  needsCredentials,
  collectNeeded,
  promptCredentials,
  credentialsHint,
  parsePair,
} from './prompt.mjs';
import { loadRemembered, saveRemembered } from './creds.mjs';
import { openSharedSession } from './shared.mjs';
import { openAttachedSession, AttachUnavailable, attachHelp, readActivePort } from './attach.mjs';
import { saveAuth, loadAuth, listAuth, forgetAuth } from './auth.mjs';
import { VERSION } from './version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function usage(code = 0) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(HERE, '..', 'docs', 'USAGE.txt'), 'utf8');
  } catch {
    text =
      'browser-pilot run <script.json> [--out <dir>] [--ephemeral] [--cdp-port <n>]\n' +
      '            [--creds-stdin] [--no-gui] [--no-prompt] [--channel chrome|msedge]\n' +
      '（未找到 docs/USAGE.txt，这是精简帮助）\n';
  }
  process.stdout.write(text);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headed') out.headed = true;
    else if (a === '--creds-stdin') out.credsStdin = true;
    else if (a === '--no-prompt') out.noPrompt = true;
    else if (a === '--no-audit') out.noAudit = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--channel') out.channel = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--creds-file') out.credsFile = argv[++i];
    else if (a === '--profile') out.profile = argv[++i];
    else if (a === '--ephemeral') out.ephemeral = true;
    else if (a === '--no-gui') out.noGui = true;
    else if (a === '--cdp-port') out.cdpPort = Number(argv[++i]);
    else if (a === '--attach') out.attach = true;
    else if (a === '--no-attach') out.noAttach = true;
    else if (a === '--user-data-dir') out.userDataDir = argv[++i];
    else if (a === '--auth') out.auth = argv[++i];
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

/**
 * 读 JSON 文件，自动剥掉 UTF-8 BOM。
 * Windows 上 PowerShell 的 Set-Content -Encoding UTF8 默认会写 BOM，
 * 不处理会导致 JSON.parse 直接报 "Unexpected token ''"。
 */
function readJsonFile(p) {
  const raw = fs.readFileSync(path.resolve(p), 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

function loadCredentialsFromEnvOrFile(args) {
  if (args.credsStdin) return null; // 由 main 异步读
  if (args.credsFile) return readJsonFile(args.credsFile);
  const { BP_CREDS, BP_USER, BP_PASS } = process.env;
  if (BP_CREDS) {
    const pair = parsePair(BP_CREDS);
    if (pair) return pair;
  }
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

function siteLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 选浏览器：附着到你现有 Chrome → 自己维护的共享窗口 → 临时上下文。
 *
 * 默认策略：
 *   - 你已经开了 chrome://inspect 的远程调试开关 → 直接附着，沿用你的登录态和已打开的标签
 *   - 没开 → 用自己维护的窗口（登录一次后复用），不打扰你
 *   - --attach 强制附着（失败就报错并给开启指引）；--no-attach 永不着附
 *   - --ephemeral 走临时上下文，两者都不碰
 */
async function openAnySession(args, site) {
  const channel = args.channel || 'chrome';
  const timeout = args.timeout || 15000;

  if (args.ephemeral) {
    return await openSession({ headless: !args.headed, channel, timeout });
  }

  const udd = args.userDataDir || undefined;
  if (!args.noAttach) {
    const available = !!readActivePort(udd);
    if (available || args.attach) {
      try {
        const s = await openAttachedSession({ userDataDir: udd, targetHost: site, timeout });
        process.stderr.write(`已附着到你正在用的 Chrome（沿用其登录态，通过 ${s.attachVia}）\n`);
        return s;
      } catch (err) {
        if (!(err instanceof AttachUnavailable)) throw err;
        process.stderr.write(`附着失败：${err.message}\n`);
        if (args.attach) {
          process.stderr.write(attachHelp(udd) + '\n');
          process.exit(2);
        }
      }
    } else if (args.attach) {
      process.stderr.write(attachHelp(udd) + '\n');
      process.exit(2);
    }
  }

  return await openSharedSession({
    channel,
    timeout,
    port: args.cdpPort || undefined,
    profileDir: args.profile ? path.resolve(args.profile) : undefined,
    targetHost: site,
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') usage(0);

  const cmd = argv[0];

  // ---- auth 子命令：登录态快照（cookie）----
  if (cmd === 'auth') {
    const sub = argv[1];
    const rest = argv.slice(2);
    if (sub === 'list') {
      const rows = listAuth();
      if (!rows.length) {
        process.stdout.write('还没有保存过登录快照。用法：browser-pilot auth save <名字>\n');
        return 0;
      }
      for (const r of rows) {
        process.stdout.write(
          r.error
            ? `${r.name}\t${r.error}\n`
            : `${r.name}\t保存于 ${r.savedAt}\t${r.cookies} 个 Cookie\t${r.domains} 个域名\n`
        );
      }
      return 0;
    }
    if (sub === 'forget') {
      const name = rest[0];
      if (!name) {
        process.stderr.write('用法：browser-pilot auth forget <名字>\n');
        return 2;
      }
      const ok = forgetAuth(name);
      process.stdout.write(ok ? `已删除快照 ${name}\n` : `没有找到快照 ${name}\n`);
      return ok ? 0 : 1;
    }
    if (sub === 'save') {
      const name = rest[0];
      if (!name) {
        process.stderr.write('用法：browser-pilot auth save <名字>\n');
        return 2;
      }
      const args = parseArgs(rest.slice(1));
      const session = await openAnySession(args, '', { interactive: true });
      try {
        const cookies = await session.context.cookies();
        const r = saveAuth(name, cookies);
        process.stdout.write(
          `已保存登录快照 ${name}：${r.count} 个 Cookie（DPAPI 加密）\n${r.file}\n` +
            '注意：Cookie 等价于登录凭据，别把这个文件拷给别人。\n'
        );
      } finally {
        await session.close();
      }
      return 0;
    }
    process.stderr.write('用法：browser-pilot auth save|list|forget ...\n');
    return 2;
  }

  if (cmd !== 'run') {
    process.stderr.write(`未知命令：${cmd}\n`);
    usage(2);
  }

  const args = parseArgs(argv.slice(1));
  if (args.ephemeral && args.profile) {
    process.stderr.write(
      '--ephemeral（零留痕）和 --profile（保留登录态）是互斥的：前者不落任何状态，后者就是要落。请二选一。\n'
    );
    process.exit(2);
  }
  const scriptPath = args._[0];
  if (!scriptPath) {
    process.stderr.write('缺少脚本文件路径\n');
    usage(2);
  }

  const script = readJsonFile(scriptPath);
  const steps = script.steps || [];

  // ---- 收集本次出现过的网址（用于站点提示与泄漏自检）----
  const urls = [script.url, ...steps.map((s) => s.url).filter(Boolean)].filter(Boolean);
  const site = siteLabel(urls[0]);

  // ---- 凭据：先看显式来源，再按需询问 ----
  let credentials = loadCredentialsFromEnvOrFile(args);
  if (args.credsStdin) {
    const raw = await readStdin();
    if (raw.trim()) {
      // 允许两种：{"user","pass"} 的 JSON，或一行「账号|密码」
      let parsed = null;
      try {
        parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      } catch {
        parsed = parsePair(raw);
      }
      if (parsed) credentials = parsed;
    }
  }

  const need = collectNeeded(steps);
  const wantsCreds = needsCredentials(steps);
  const missing =
    wantsCreds &&
    (!credentials || (need.user && !credentials.user) || (need.pass && !credentials.pass));

  if (missing) {
    // 1) 记住过的：直接复用，不问
    const recalled = loadRemembered(site);
    if (recalled && (!need.user || recalled.user) && (!need.pass || recalled.pass)) {
      credentials = recalled;
      process.stderr.write(`已复用记住的账号：${site}\n`);
    } else if (!args.noPrompt) {
      // 2) 图形弹框（带「长期保留」勾选）——agent 也能用，因为不依赖终端
      const got = args.noGui ? null : askViaGui(site);
      if (got && got.cancelled) {
        process.stderr.write('已取消登录，未执行。\n');
        process.exit(130);
      } else if (got) {
        credentials = { user: got.user, pass: got.pass };
        if (got.remember) {
          try {
            const f = saveRemembered(site, credentials);
            process.stderr.write(`已记住该站点账号（DPAPI 加密）：${f}\n`);
          } catch (e) {
            process.stderr.write(`记住账号失败（不影响本次运行）：${e.message}\n`);
          }
        }
      } else if (process.stdin.isTTY && process.stdout.isTTY) {
        // 3) 终端询问（人在终端里跑时）
        credentials = await promptCredentials({
          site,
          needUser: need.user,
          needPass: need.pass,
        });
      } else {
        process.stderr.write(credentialsHint(site) + '\n');
        process.exit(2);
      }
    } else {
      process.stderr.write(credentialsHint(site) + '\n');
      process.exit(2);
    }
  }

  const secrets = [credentials?.user, credentials?.pass].filter(Boolean);
  const redact = makeRedactor(secrets);

  // ---- 输出目录 ----
  const outDir = prepareOutputDir(args.out || path.join(process.cwd(), '.bp-out', stamp()));

  const transcript = [];
  const pick = (entry) => {
    if (entry.error) return `  ${entry.error}`;
    if (entry.file) return `  ${entry.file}`;
    if (entry.status !== undefined) return `  http ${entry.status}`;
    if (entry.neterrors) return `  ${entry.neterrors}`;
    if (entry.frames) return `  frames=${entry.frames}`;
    if (entry.frame) return `  frame=${entry.frame}`;
    if (entry.urlHost) return `  host=${entry.urlHost}`;
    if (entry.title) return `  ${entry.title}`;
    if (entry.snapshot) return `  ${entry.count} 个引用${entry.refsFile ? '（refs.json）' : ''}`;
    if (entry.asserted) return `  ok`;
    if (entry.probe) return `  共 ${entry.probe.total} 个`;
    if (entry.box) return `  ${entry.box}`;
    if (entry.text) return `  ${String(entry.text).slice(0, 160).replace(/\s+/g, ' ')}`;
    if (entry.count !== undefined) return `  ${entry.count}`;
    return '';
  };
  const log = (entry) => {
    const ok = entry.ok ? 'OK ' : 'FAIL';
    const retried = entry.retriedAfter ? `（重试 ${entry.retriedAfter} 次后成功）` : '';
    transcript.push(`[${ok}] #${entry.index} ${entry.type}${pick(entry)} (${entry.ms}ms)${retried}`);
  };

  // ---- 登录态快照：先读文件（错了立刻报，不用等浏览器起来）----
  let authCookies = null;
  if (args.auth) {
    try {
      const data = loadAuth(args.auth);
      authCookies = data.cookies;
      process.stderr.write(`已载入登录快照 ${args.auth}（${data.cookies.length} 个 Cookie）\n`);
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
  }

  // ---- 浏览器：附着你现有的 Chrome → 自己的共享窗口 → 临时上下文 ----
  const session = await openAnySession(args, site);

  if (authCookies) {
    await session.context.addCookies(authCookies);
  }

  let results = [];
  let fatal = null;
  try {
    results = await runSteps(session.page, steps, {
      outDir,
      redact,
      credentials,
      netErrors: session.netErrors,
      log,
      state: { frame: null, frameLabel: null, refs: {} },
    });
  } catch (err) {
    fatal = redact(err?.message || String(err));
  } finally {
    await session.close();
  }

  // ---- 落盘（全部脱敏）----
  const manifest = {
    tool: 'browser-pilot',
    version: VERSION,
    startedAt: new Date().toISOString(),
    targetFingerprint: urls[0] ? hostFingerprint(urls[0]) : null,
    accountProvided: secrets.length > 0,
    authSnapshot: args.auth || null,
    steps: results.length,
    failed: results.filter((r) => !r.ok).length,
    screenshots: results.filter((r) => r.file).length,
    zeroRetention: !!args.ephemeral,
    sessionMode: args.ephemeral ? 'ephemeral' : session.attached ? 'attached' : 'shared',
    attachVia: session.attachVia || null,
    note: '本文件不含网址、账号或密码原文；targetFingerprint 是站点主机的不可逆哈希。',
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, 'steps.json'), JSON.stringify(results, null, 2));

  process.stdout.write(transcript.join('\n') + '\n');

  // snapshot 的结果单独成块输出：agent 下一步就是拿这些 ref 去操作
  const snaps = results.filter((r) => r.snapshot);
  for (const s of snaps) {
    process.stdout.write(`\n--- snapshot #${s.index}（${s.count} 个可交互元素）---\n`);
    process.stdout.write(s.snapshot + '\n');
  }

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
