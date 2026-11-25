/**
 * 脱敏器。
 *
 * 本工具所有「会离开内存」的东西（stdout、写入磁盘的 JSON、错误信息）
 * 都必须先过这里：网址、账号、邮箱、IP 一律替换成占位符。
 */
import crypto from 'node:crypto';

const URL_RE = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>)}\]]+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const BEARER_RE = /\b(?:bearer|token|api[_-]?key|password|passwd|pwd)\s*[=:]\s*\S+/gi;

/**
 * @param {string[]} secrets 本次运行里用到的账号/密码等明文，长的优先替换
 * @returns {(input: unknown) => string}
 */
export function makeRedactor(secrets = []) {
  const list = secrets
    .filter((s) => typeof s === 'string' && s.length >= 2)
    .sort((a, b) => b.length - a.length);

  return function redact(input) {
    if (input === null || input === undefined) return '';
    let s = String(input);
    for (const sec of list) {
      s = s.split(sec).join('<cred>');
    }
    s = s.replace(URL_RE, '<url>');
    s = s.replace(EMAIL_RE, '<email>');
    s = s.replace(BEARER_RE, (m) => m.replace(/\S+$/, '<redacted>'));
    s = s.replace(IPV4_RE, '<ip>');
    return s;
  };
}

/**
 * 站点指纹：只保留 host 的不可逆哈希，用来在日志里区分「打开了哪个站」，
 * 但无法反推出网址。
 */
export function hostFingerprint(url) {
  try {
    const host = new URL(url).host;
    return 'h_' + crypto.createHash('sha256').update(host).digest('hex').slice(0, 8);
  } catch {
    return 'invalid';
  }
}

/** 判断一段文本里是否含给定的敏感串（用于泄漏自检）。 */
export function containsSecret(text, needles = []) {
  const s = String(text);
  return needles.some((n) => typeof n === 'string' && n.length >= 3 && s.includes(n));
}
