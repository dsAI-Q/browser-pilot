/**
 * 零留痕策略：这是 --ephemeral 模式的红线（默认的共享浏览器模式另有说明）。
 *
 * 两种模式的区别：
 *   - 默认「共享浏览器」（src/shared.mjs）：登录态留在调用方指定的配置目录里，
 *     目的是「登录一次、之后不再问」。它有意保留 Cookie，所以不在这里的管辖范围。
 *   - --ephemeral：本文件负责的严格模式 —— 只用内存上下文，用完即焚。
 *
 * --ephemeral 下的三条硬规则：
 *   1. 只用内存上下文（browser.newContext），绝不使用 launchPersistentContext。
 *   2. 禁止 recordHar / recordVideo / storageState 落盘。
 *   3. 运行结束后自检：输出目录里不得出现任何网址或凭据原文。
 *
 * 两种模式共同遵守的只有第 2 条和第 3 条（输出侧永远脱敏、永远自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { containsSecret } from './redact.mjs';

const BANNED_CONTEXT_OPTIONS = ['recordHar', 'recordVideo', 'storageState', 'video', 'har'];

/** 启动前校验：一旦有人给上下文传了会落盘的选项，直接拒绝启动。 */
export function assertZeroRetention(contextOptions = {}) {
  const hit = BANNED_CONTEXT_OPTIONS.filter((k) => {
    const v = contextOptions[k];
    return v !== undefined && v !== null && v !== false;
  });
  if (hit.length) {
    throw new Error(
      `零留痕策略拒绝启动：上下文接受了会落盘的选项 [${hit.join(', ')}]。` +
        `本工具只允许内存上下文。`
    );
  }
  return true;
}

/** 启动前校验：输出目录必须是本次新建的空目录，避免覆盖或混入旧数据。 */
export function prepareOutputDir(dir) {
  const abs = path.resolve(dir);
  if (fs.existsSync(abs)) {
    const entries = fs.readdirSync(abs);
    if (entries.length > 0) {
      throw new Error(`输出目录非空，拒绝写入：${abs}`);
    }
  } else {
    fs.mkdirSync(abs, { recursive: true });
  }
  return abs;
}

/**
 * 运行后自检：扫描输出目录里所有文件，确认不含本次用到的网址与凭据原文。
 * 这是这个工具最有价值的一步——「我说我没记录」不如「跑完扫一遍给你看」。
 */
export function auditNoLeak(dir, needles = []) {
  const abs = path.resolve(dir);
  const findings = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      // 截图是像素数据，只查文本类文件
      if (!/\.(json|txt|md|log|csv|html?)$/i.test(entry.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const n of needles) {
        if (typeof n === 'string' && n.length >= 4 && text.includes(n)) {
          findings.push({ file: path.relative(abs, p), leak: 'matched secret' });
        }
      }
    }
  };
  if (fs.existsSync(abs)) walk(abs);
  if (findings.length) {
    throw new Error(
      `留痕自检失败：以下文件里出现了网址或凭据原文 ${JSON.stringify(findings)}`
    );
  }
  return { clean: true, scanned: abs };
}

export { containsSecret };
