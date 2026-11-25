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
 * 默认内存上下文，用完即焚。
 *
 * 例外：显式传 profile 时改用 launchPersistentContext（登录态留在该目录），
 * 这是给「扫码登录一次、后面反复跑」这类站点用的 opt-in 开关，
 * 目录必须由调用方自己指定，工具不会偷偷建。
 *
 * @param {object} opts
 * @param {boolean} [opts.headless=true]
 * @param {string}  [opts.channel='chrome'] 复用系统已装的 Chrome，不下载 Chromium
 * @param {object}  [opts.viewport]
 * @param {number}  [opts.timeout=15000]
 *
 * 注意：本函数只做「用完即焚」的临时会话（--ephemeral）。
 * 需要复用登录态的共享浏览器在 src/shared.mjs，那边才用持久化配置目录。
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
  let context;
  let page;

  try {
    browser = await chromium.launch({ channel, headless });
  } catch (err) {
    throw new Error(
      `启动浏览器失败（channel=${channel}）。请确认系统已装 Chrome，` +
        `或用 --channel msedge 改用 Edge。原始错误：${err.message}`
    );
  }
  context = await browser.newContext(contextOptions);
  page = await context.newPage();

  context.setDefaultTimeout(timeout);
  context.setDefaultNavigationTimeout(timeout);

  // 记录失败的请求：页面空白最常见的原因就是某个子框架/资源 404 或被拦，
  // 只有拿到「哪个主机 + 什么错」才诊断得下去。只保留主机名，不留完整网址。
  const netErrors = [];
  const record = (request) => {
    let host = '';
    try {
      host = new URL(request.url()).host;
    } catch {
      host = 'invalid';
    }
    const failure = request.failure();
    netErrors.push({
      host,
      method: request.method(),
      resource: request.resourceType(),
      error: failure ? String(failure.errorText).slice(0, 120) : 'unknown',
    });
  };
  page.on('requestfailed', record);

  async function close() {
    try {
      page.off('requestfailed', record);
    } catch {}
    try {
      await context.close();
    } catch {}
    try {
      await browser.close();
    } catch {}
  }

  return { browser, context, page, close, netErrors };
}
