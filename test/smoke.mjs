/**
 * 冒烟测试：
 *   1. 用 data: URL 跑一遍完整 CLI，验证能启动浏览器、截图、落盘
 *   2. 验证输出目录里**不含**那个 URL（零留痕真的生效）
 *   3. 验证 manifest.json 里只有站点指纹，没有网址
 *
 * 不需要任何账号，可以在 CI 里跑。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const SECRET_URL = 'data:text/html,<h1>browser-pilot smoke</h1><p>ok</p>';

let failed = 0;
const check = (name, cond, extra = '') => {
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}\n`);
  if (!cond) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-smoke-'));
const scriptPath = path.join(tmp, 'script.json');
const outDir = path.join(tmp, 'out');

fs.writeFileSync(
  scriptPath,
  JSON.stringify({
    url: SECRET_URL,
    steps: [
      { type: 'goto', url: SECRET_URL },
      { type: 'shot', name: '01' },
      { type: 'title' },
      { type: 'text', selector: 'h1' },
    ],
  })
);

const res = spawnSync(
  NODE,
  [path.join(ROOT, 'src', 'cli.mjs'), 'run', scriptPath, '--out', outDir],
  { encoding: 'utf8', timeout: 180000 }
);

process.stdout.write('--- CLI stdout ---\n' + (res.stdout || '') + '\n');
if (res.stderr) process.stdout.write('--- CLI stderr ---\n' + res.stderr + '\n');

check('CLI 退出码为 0', res.status === 0, `实际 ${res.status}`);
check('输出了留痕自检通过', /留痕自检：通过/.test(res.stdout || ''));
check('生成了 manifest.json', fs.existsSync(path.join(outDir, 'manifest.json')));
check('生成了 steps.json', fs.existsSync(path.join(outDir, 'steps.json')));
check(
  '生成了截图',
  fs.readdirSync(outDir).some((f) => f.endsWith('.png'))
);

const manifestRaw = fs.existsSync(path.join(outDir, 'manifest.json'))
  ? fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8')
  : '';
check('manifest 里没有网址原文', !manifestRaw.includes(SECRET_URL));
check('manifest 里有站点指纹', /"targetFingerprint"\s*:\s*"h_[0-9a-f]{8}"/.test(manifestRaw));

const stepsRaw = fs.existsSync(path.join(outDir, 'steps.json'))
  ? fs.readFileSync(path.join(outDir, 'steps.json'), 'utf8')
  : '';
check('steps.json 里没有网址原文', !stepsRaw.includes(SECRET_URL));

// 全目录扫描
let leaked = false;
for (const f of fs.readdirSync(outDir)) {
  if (!/\.(json|txt|md|log)$/i.test(f)) continue;
  const t = fs.readFileSync(path.join(outDir, f), 'utf8');
  if (t.includes(SECRET_URL)) leaked = true;
}
check('整个输出目录无网址原文', !leaked);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}

process.stdout.write(failed === 0 ? '\n全部通过\n' : `\n${failed} 项失败\n`);
process.exit(failed === 0 ? 0 : 1);
