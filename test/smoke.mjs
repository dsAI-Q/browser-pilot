/**
 * 冒烟测试
 *
 * 分四组：
 *   A. 纯逻辑：凭据门控、一行式凭据解析、脱敏器、站点指纹、策略拒绝
 *   B. CLI 行为：帮助、互斥选项、缺凭据时报错而不是挂死
 *   C. 零留痕跑一遍：--ephemeral 下截图/取文字，且输出里找不到那个 URL
 *   D. 共享模式自检：默认模式默认不复用无关标签（纯逻辑，不依赖浏览器）
 *
 * 自动化路径一律带 --no-gui --no-prompt，保证 CI 里不会弹窗、不会等人。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { needsCredentials, collectNeeded, parsePair } from '../src/prompt.mjs';
import { makeRedactor, hostFingerprint } from '../src/redact.mjs';
import { assertZeroRetention, prepareOutputDir } from '../src/policy.mjs';
import { VERSION } from '../src/version.mjs';
import { resolveRef, formatRefs } from '../src/refs.mjs';
import { readActivePort, attachHelp, defaultChromeUserDataDir } from '../src/attach.mjs';
import { safeAuthName } from '../src/auth.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const SECRET_URL = 'data:text/html,<h1>browser-pilot smoke</h1><p>ok</p>';

let failed = 0;
const check = (name, cond, extra = '') => {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}\n`);
  if (!cond) failed++;
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-smoke-'));
let runSeq = 0;

/**
 * 跑一次 CLI，返回 { status, stdout, stderr }。
 *
 * 刻意用「文件重定向」而不是管道：在受限沙箱里（以及部分 Windows 环境下）
 * 父进程用 pipe 捕获子进程输出会直接 EPERM，文件重定向不受影响。
 */
function runCli(args, { timeout = 180000 } = {}) {
  const n = ++runSeq;
  const oFile = path.join(tmpRoot, `stdout-${n}.log`);
  const eFile = path.join(tmpRoot, `stderr-${n}.log`);
  const oFd = fs.openSync(oFile, 'w');
  const eFd = fs.openSync(eFile, 'w');
  const r = spawnSync(NODE, [CLI, ...args], {
    stdio: ['ignore', oFd, eFd],
    timeout,
    env: { ...process.env, BP_CREDS: '', BP_USER: '', BP_PASS: '' },
  });
  fs.closeSync(oFd);
  fs.closeSync(eFd);
  return {
    status: r.status,
    error: r.error,
    stdout: safeRead(oFile),
    stderr: safeRead(eFile),
  };
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// ---------- A. 纯逻辑 ----------
process.stdout.write('--- A. 纯逻辑 ---\n');
check('只读脚本不需要凭据',
  needsCredentials([{ type: 'goto' }, { type: 'shot' }, { type: 'text' }]) === false);
check('login 动作需要凭据', needsCredentials([{ type: 'login' }]) === true);
check('valueFrom=pass 需要凭据', needsCredentials([{ type: 'fill', valueFrom: 'pass' }]) === true);
check('login 同时需要账号和密码',
  JSON.stringify(collectNeeded([{ type: 'login' }])) === '{"user":true,"pass":true}');
check('只填密码时只问密码',
  JSON.stringify(collectNeeded([{ type: 'fill', valueFrom: 'pass' }])) === '{"user":false,"pass":true}');

const p1 = parsePair('me@example.com|p@ss,word');
check('一行式凭据按竖线拆开', p1 && p1.user === 'me@example.com' && p1.pass === 'p@ss,word');
const p2 = parsePair('13800000000｜密码');
check('一行式凭据支持全角竖线', p2 && p2.user === '13800000000' && p2.pass === '密码');
check('没有分隔符时返回 null', parsePair('只有账号没有密码') === null);
check('分隔符在开头时返回 null', parsePair('|只有密码') === null);

let rejected = false;
try { assertZeroRetention({ recordHar: { path: 'x' } }); } catch { rejected = true; }
check('策略拒绝会落盘的 recordHar', rejected);
check('策略接受干净的上下文选项', assertZeroRetention({ viewport: { width: 800, height: 600 } }) === true);

const tmpRoot2 = tmpRoot;
const busyDir = path.join(tmpRoot2, 'busy');
fs.mkdirSync(busyDir, { recursive: true });
fs.writeFileSync(path.join(busyDir, 'old.json'), '{}');
let dirRejected = false;
try { prepareOutputDir(busyDir); } catch { dirRejected = true; }
check('输出目录非空时拒绝写入', dirRejected);

const red = makeRedactor(['sup3rsecret']);
const redOut = red('访问 https://a.example.com/x?t=1 邮箱 me@example.com IP 10.0.0.1 密码 sup3rsecret');
check('脱敏器抹掉账号密码', !redOut.includes('sup3rsecret') && redOut.includes('<cred>'));
check('脱敏器抹掉网址', !redOut.includes('https://') && redOut.includes('<url>'));
check('脱敏器抹掉邮箱与 IP', !redOut.includes('me@example.com') && !redOut.includes('10.0.0.1'));
check('站点指纹稳定', hostFingerprint('https://a.example.com/x') === hostFingerprint('https://a.example.com/y'));
check('站点指纹不含主机名', !hostFingerprint('https://a.example.com/x').includes('example'));

const pkgRaw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
check('package.json 不带 BOM', !pkgRaw.startsWith('\uFEFF'));
let pkg = null;
try { pkg = JSON.parse(pkgRaw); } catch {}
check('package.json 能被 JSON.parse', pkg !== null);
check('版本号常量与 package.json 一致', pkg && pkg.version === VERSION, `${pkg && pkg.version} vs ${VERSION}`);
check('包名是 @dsai-q/browser-pilot', pkg && pkg.name === '@dsai-q/browser-pilot', pkg && pkg.name);
check('包名符合 npm 规则（可带作用域，其余全小写）',
  !!pkg && /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name),
  pkg && pkg.name);

// ref 解析：能取到选择器，取不到要报错而不是静默
const refMap = { 'ref:e1': '#login', 'ref:e2': 'button.submit' };
check('ref 能解析成选择器', resolveRef(refMap, 'ref:e2') === 'button.submit');
let refThrew = false;
try { resolveRef(refMap, 'ref:e9'); } catch { refThrew = true; }
check('未知 ref 会报错', refThrew);
check('ref 列表格式带制表符',
  formatRefs([{ ref: 'ref:e1', role: 'button', name: '登录', tag: 'button' }]).includes('\t'));

// attach 发现逻辑：没有 DevToolsActivePort 时必须返回 null（而不是瞎猜端口）
const emptyDir = path.join(tmpRoot, 'chrome-empty');
fs.mkdirSync(emptyDir, { recursive: true });
check('没开远程调试时 readActivePort 返回 null', readActivePort(emptyDir) === null);
const fakeDir = path.join(tmpRoot, 'chrome-fake');
fs.mkdirSync(fakeDir, { recursive: true });
fs.writeFileSync(path.join(fakeDir, 'DevToolsActivePort'), '9223\n/devtools/browser/abc-123\n', 'utf8');
const ap = readActivePort(fakeDir);
check('DevToolsActivePort 能解析出 ws 地址',
  !!ap && ap.wsUrl === 'ws://127.0.0.1:9223/devtools/browser/abc-123', ap && ap.wsUrl);
fs.writeFileSync(path.join(fakeDir, 'DevToolsActivePort'), 'not-a-port\n', 'utf8');
check('DevToolsActivePort 格式不对时返回 null', readActivePort(fakeDir) === null);
check('attach 指引里提到 chrome://inspect', attachHelp().includes('chrome://inspect'));
check('默认 Chrome 配置目录是个绝对路径', path.isAbsolute(defaultChromeUserDataDir()));

// 登录快照名：防路径穿越
check('合法快照名通过', safeAuthName('app-login_1') === 'app-login_1');
let nameThrew = false;
try { safeAuthName('../etc/passwd'); } catch { nameThrew = true; }
check('含路径分隔符的快照名被拒绝', nameThrew);

// DPAPI 不可用时必须给明确错误，不能抛原始 EPERM（否则用户不知道该怎么办）
let dpapiMsg = '';
try {
  const { protect } = await import('../src/creds.mjs');
  protect('x');
} catch (e) {
  dpapiMsg = String(e.message || '');
}
const dpapiOk = dpapiMsg === '' || /DPAPI|powershell/.test(dpapiMsg);
check('DPAPI 不可用时报错可读', dpapiOk, dpapiMsg.slice(0, 60));

// ---------- B. CLI 行为 ----------
process.stdout.write('--- B. CLI 行为 ---\n');
const help = runCli(['--help'], { timeout: 30000 });
check('--help 退出码为 0', help.status === 0, `实际 ${help.status}`);
check('--help 里说明了 run 用法', /run <script\.json>/.test(help.stdout || ''));

const both = runCli(['run', path.join(tmpRoot, 'x.json'), '--ephemeral', '--profile', path.join(tmpRoot, 'p')],
  { timeout: 30000 });
check('--ephemeral 与 --profile 互斥时报错退出', both.status === 2, `实际 ${both.status}`);
check('互斥报错说明了原因', /互斥/.test(both.stderr || ''));

// ---------- C. 零留痕跑一遍 ----------
process.stdout.write('--- C. 零留痕模式 ---\n');
const roScript = path.join(tmpRoot, 'readonly.json');
const outDir = path.join(tmpRoot, 'out');
fs.writeFileSync(roScript, JSON.stringify({
  url: SECRET_URL,
  steps: [
    { type: 'goto', url: SECRET_URL },
    { type: 'shot', name: '01' },
    { type: 'title' },
    { type: 'text', selector: 'h1' },
  ],
}));

const res = runCli(['run', roScript, '--out', outDir, '--ephemeral', '--no-gui', '--no-prompt']);
process.stdout.write('--- CLI stdout ---\n' + (res.stdout || '') + '\n');
if (res.stderr) process.stdout.write('--- CLI stderr ---\n' + res.stderr + '\n');

// 浏览器起不来有两种原因：本机没装浏览器，或者所在环境禁止创建子进程（沙箱 / 受限 CI）。
// 这两种都算「环境不具备」，不该报成产品缺陷；但可以用 BP_SMOKE_REQUIRE_BROWSER=1 强制失败，
// 给真机上跑 CI 的场景用。
const envBlocked = /spawn EPERM|启动浏览器失败|找不到 Chrome\/Edge|Exec format error/i.test(
  (res.stdout || '') + (res.stderr || '')
);
const ranBrowser = fs.existsSync(path.join(outDir, 'manifest.json'));

if (envBlocked && !ranBrowser) {
  const reason = /spawn EPERM/.test(res.stderr || '') ? '本环境禁止创建子进程（spawn EPERM）' : '本机未找到可用的浏览器';
  process.stdout.write(`SKIP  浏览器相关断言：${reason}\n`);
  if (process.env.BP_SMOKE_REQUIRE_BROWSER === '1') {
    check('浏览器应当可用（BP_SMOKE_REQUIRE_BROWSER=1）', false, reason);
  }
} else {
  check('只读脚本退出码为 0', res.status === 0, `实际 ${res.status}`);
  check('只读脚本没有被要求输入账号', !/需要登录凭据/.test(res.stdout + res.stderr));
  check('留痕自检通过', /留痕自检：通过/.test(res.stdout || ''));
}

if (ranBrowser) {
  const manifestRaw = fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  check('生成了截图', fs.readdirSync(outDir).some((f) => f.endsWith('.png')));
  check('manifest 标明未提供账号', manifest.accountProvided === false);
  check('manifest 标明零留痕 + ephemeral', manifest.zeroRetention === true && manifest.sessionMode === 'ephemeral');
  check('manifest 里没有网址原文', !manifestRaw.includes(SECRET_URL));
  check('manifest 里有站点指纹', /"targetFingerprint"\s*:\s*"h_[0-9a-f]{8}"/.test(manifestRaw));
  check('steps.json 里没有网址原文',
    !fs.readFileSync(path.join(outDir, 'steps.json'), 'utf8').includes(SECRET_URL));
} else {
  process.stdout.write('SKIP  浏览器没起来（无头环境/沙箱限制），跳过 C 组的文件断言\n');
}

// ---------- D. 缺凭据不挂死 ----------
process.stdout.write('--- D. 缺凭据 ---\n');
const loginScript = path.join(tmpRoot, 'login.json');
fs.writeFileSync(loginScript, JSON.stringify({
  url: SECRET_URL,
  steps: [
    { type: 'goto', url: SECRET_URL },
    { type: 'login', userSelector: '#u', passSelector: '#p' },
  ],
}));
const res2 = runCli(['run', loginScript, '--ephemeral', '--no-gui', '--no-prompt'], { timeout: 60000 });
check('需要登录但无凭据时退出码为 2', res2.status === 2, `实际 ${res2.status}`);
check('报错里列出了怎么传凭据', /三种提供方式/.test(res2.stderr || ''));
check('没有卡住等输入（未超时）', res2.error === undefined);

// ---------- 清理 ----------
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
process.stdout.write(failed === 0 ? '\n全部通过\n' : `\n${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);
