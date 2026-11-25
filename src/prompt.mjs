/**
 * 凭据交互层。
 *
 * 设计原则：
 *   1. 只有脚本里真的需要账号密码（login 动作、或 valueFrom: "user"/"pass"）才询问，
 *      纯只读脚本一个字都不问。
 *   2. 交互式终端里用隐藏回显的提示，不把密码打在屏幕上。
 *   3. 非交互环境（agent、CI、管道）绝不偷偷弹窗卡住，而是明确报错告诉你怎么传。
 *   4. 无论哪条路径，凭据只在内存里，绝不落盘。
 */

/**
 * 把「账号|密码」这种一行写法拆成 {user, pass}。
 * 允许的分隔符：| ｜ :: Tab ， , —— 取最先出现的那个。
 * 账号里不会出现这些字符；密码只按第一个分隔符切，后面的原样保留。
 * @returns {{user:string, pass:string}|null}
 */
export function parsePair(raw) {
  const s = String(raw ?? '');
  for (const d of ['|', '｜', '::', '\t', '，', ',']) {
    const i = s.indexOf(d);
    if (i > 0) return { user: s.slice(0, i).trim(), pass: s.slice(i + d.length) };
  }
  return null;
}

/** 脚本是否需要凭据 */
export function needsCredentials(steps = []) {  return steps.some(
    (s) =>
      s &&
      (String(s.type || '').toLowerCase() === 'login' || typeof s.valueFrom === 'string')
  );
}

/** 具体需要哪几个字段 */
export function collectNeeded(steps = []) {
  let user = false;
  let pass = false;
  for (const s of steps) {
    if (!s) continue;
    if (String(s.type || '').toLowerCase() === 'login') {
      user = true;
      pass = true;
    }
    if (s.valueFrom === 'user') user = true;
    if (s.valueFrom === 'pass') pass = true;
    if (typeof s.valueFrom === 'string' && !['user', 'pass'].includes(s.valueFrom)) {
      // 引用未知字段时，两个都问，避免跑一半缺值
      user = true;
      pass = true;
    }
  }
  return { user, pass };
}

function askLine(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      stdin.pause();
      stdin.removeListener('data', onData);
      resolve(String(chunk).replace(/[\r\n]+$/, ''));
    };
    stdin.once('data', onData);
  });
}

/** 密码输入：显示 * 号，不回显明文 */
function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const cleanup = () => {
      stdin.setRawMode(wasRaw || false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') {
          cleanup();
          process.stdout.write('\n已取消。\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        buf += c;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * 交互式询问（TTY）。
 * @param {{site?: string, needUser: boolean, needPass: boolean}} opts
 */
export async function promptCredentials(opts) {
  const { site, needUser = true, needPass = true } = opts;
  process.stdout.write('\n');
  process.stdout.write('────────────────────────────────────────────\n');
  process.stdout.write('browser-pilot 需要登录凭据\n');
  if (site) process.stdout.write(`目标站点：${site}\n`);
  process.stdout.write('凭据只在内存中使用，不会写入磁盘，也不会出现在日志里。\n');
  process.stdout.write('────────────────────────────────────────────\n');

  const out = {};
  if (needUser) out.user = await askLine('账号（用户名／邮箱／手机号）：');
  if (needPass) out.pass = await askHidden('密码（输入时不显示明文）：');

  if ((needUser && !out.user) || (needPass && !out.pass)) {
    process.stdout.write('未填写完整，已取消。\n');
    process.exit(130);
  }
  return out;
}

/**
 * 非交互环境下的报错文案：告诉用户三种传法，绝不静默失败。
 */
export function credentialsHint(site) {
  return [
    '这个脚本需要登录凭据，但当前不是交互式终端，无法向你询问。',
    site ? `目标站点：${site}` : '',
    '',
    '三种提供方式，任选其一：',
    '  1) 让它在终端里问你（最适合自己用）：直接在自己的终端里运行本命令',
    '  2) 环境变量：  set BP_USER=你的账号  &&  set BP_PASS=你的密码',
    '  3) 管道传入：  echo {"user":"...","pass":"..."} | browser-pilot run 脚本.json --creds-stdin',
    '',
    '如果这个脚本其实不需要登录，请把 login 动作或 valueFrom 字段去掉。',
  ]
    .filter(Boolean)
    .join('\n');
}
