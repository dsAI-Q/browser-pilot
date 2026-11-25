/**
 * 冒烟测试
 *   A. 只读脚本：能启动浏览器、截图、取文字，且**不询问凭据**
 *   B. 零留痕：输出目录里不含那个 URL
 *   C. 凭据门控：需要登录的脚本在非交互环境下**明确报错而不是卡住**
 *
 * 不需要任何账号，可在 CI 里跑。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsCredentials, collectNeeded } from '../src/prompt.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const SECRET_URL = 'data:text/html,<h1>browser-pilot smoke</h1><p>ok</p>';

let failed = 0;
const check = (name, cond, extra = '') => {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}\n`);
  if (!cond) failed++;
};

// ---------- 纯逻辑：凭据门控 ----------
process.stdout.write('--- 凭据门控逻辑 ---\n');
check('只读脚本不需要凭据',
  needsCredentials([{ type: 'goto' }, { type: 'shot' }, { type: 'text' }]) === false);
check('login 动作需要凭据', needsCredentials([{ type: 'login' }]) === true);
check('valueFrom=pass 需要凭据', needsCredentials([{ type: 'fill', valueFrom: 'pass' }]) === true);
check('login 同时需要账号和密码',
  JSON.stringify(collectNeeded([{ type: 'login' }])) === '{"user":true,"pass":true}');
check('只填密码时只问密码',
  JSON.stringify(collectNeeded([{ type: 'fill', valueFrom: 'pass' }])) === '{"user":false,"pass":true}');

// ---------- A + B：只读脚本跑一遍 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-smoke-'));
const roScript = path.join(tmp, 'readonly.json');
const outDir = path.join(tmp, 'out');
fs.writeFileSync(roScript, JSON.stringify({
  url: SECRET_URL,
  steps: [
    { type: 'goto', url: SECRET_URL },
    { type: 'shot', name: '01' },
    { type: 'title' },
    { type: 'text', selector: 'h1' },
  ],
}));

const res = spawnSync(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'run', roScript, '--out', outDir],
  { encoding: 'utf8', timeout: 180000 });

process.stdout.write('--- CLI stdout ---\n' + (res.stdout || '') + '\n');
if (res.stderr) process.stdout.write('--- CLI stderr ---\n' + res.stderr + '\n');

check('只读脚本退出码为 0', res.status === 0, `实际 ${res.status}`);
check('只读脚本没有被要求输入账号', !/需要登录凭据/.test(res.stdout + res.stderr));
check('留痕自检通过', /留痕自检：通过/.test(res.stdout || ''));
check('生成了 manifest.json', fs.existsSync(path.join(outDir, 'manifest.json')));
check('生成了截图', fs.readdirSync(outDir).some((f) => f.endsWith('.png')));
check('manifest 标明未提供账号',
  /"accountProvided":\s*false/.test(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')));

const manifestRaw = fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8');
check('manifest 里没有网址原文', !manifestRaw.includes(SECRET_URL));
check('manifest 里有站点指纹', /"targetFingerprint"\s*:\s*"h_[0-9a-f]{8}"/.test(manifestRaw));
check('steps.json 里没有网址原文',
  !fs.readFileSync(path.join(outDir, 'steps.json'), 'utf8').includes(SECRET_URL));

// ---------- C：需要登录但没凭据，非交互环境 ----------
const loginScript = path.join(tmp, 'login.json');
fs.writeFileSync(loginScript, JSON.stringify({
  url: SECRET_URL,
  steps: [
    { type: 'goto', url: SECRET_URL },
    { type: 'login', userSelector: '#u', passSelector: '#p' },
  ],
}));
const res2 = spawnSync(NODE, [path.join(ROOT, 'src', 'cli.mjs'), 'run', loginScript],
  { encoding: 'utf8', timeout: 60000 });

check('需要登录但无凭据时退出码为 2', res2.status === 2, `实际 ${res2.status}`);
check('报错里给出了三种提供方式', /三种提供方式/.test(res2.stderr || ''));
check('报错里没有卡住等输入（运行未超时）', res2.error === undefined);

// ---------- 清理 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.stdout.write(failed === 0 ? '\n全部通过\n' : `\n${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);
