/**
 * 会话：内存上下文，用完即焚。
 *
 * 刻意不使用 launchPersistentContext —— 那是把浏览历史、Cookie、登录态
 * 写进磁盘的入口，与本工具的零留痕原则冲突。
 */
import { chromium } from 'playwright-core';
import { assertZeroRetention } from './policy.mjs';

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/**
 * 打开一个浏览器会话。
 * @param {object} opts
 * @param {boolean} [opts.headless=true]
 * @param {string}  [opts.channel='chrome'] 复用系统已装的 Chrome，不下载 Chromium
 * @param {object}  [opts.viewport]
 * @param {number}  [opts.timeout=15000]
 */
export async function openSession(opts = {}) {
  const {
    headless = true,
    channel = 'chrome',
    viewport = DEFAULT_VIEWPORT,
    timeout = 15000,
  } = opts;

  const contextOptions = {
    viewport,
    acceptDownloads: false,
    // 显式声明：不录 HAR、不录像、不注入落盘的 storageState
    recordHar: undefined,
    recordVideo: undefined,
    storageState: undefined,
  };
  assertZeroRetention(contextOptions);

  let browser;
  try {
    browser = await chromium.launch({ channel, headless });
  } catch (err) {
    throw new Error(
      `启动浏览器失败（channel=${channel}）。请确认系统已装 Chrome，` +
        `或用 --channel msedge 改用 Edge。原始错误：${err.message}`
    );
  }

  const context = await browser.newContext(contextOptions);
  context.setDefaultTimeout(timeout);
  context.setDefaultNavigationTimeout(timeout);
  const page = await context.newPage();

  async function close() {
    try {
      await context.close();
    } catch {}
    try {
      await browser.close();
    } catch {}
  }

  return { browser, context, page, close };
}
