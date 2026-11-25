/**
 * 动作执行器。
 *
 * 脚本文件里只允许出现「选择器 / 文字 / 参数」，
 * 绝不允许出现账号密码 —— 凭据由运行时注入（见 credentials 参数）。
 * 这样脚本可以放心提交进 Git。
 */
import path from 'node:path';

const MAX_TEXT = 4000;

function truncate(s, n = MAX_TEXT) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + `…（已截断，共 ${str.length} 字）` : str;
}

async function resolveTarget(page, step) {
  if (step.selector) return page.locator(step.selector).first();
  if (step.text) return page.getByText(step.text, { exact: !!step.exact }).first();
  if (step.role && step.name) return page.getByRole(step.role, { name: step.name }).first();
  if (step.placeholder) return page.getByPlaceholder(step.placeholder).first();
  if (step.label) return page.getByLabel(step.label).first();
  throw new Error('这一步缺少定位信息：selector / text / role+name / placeholder / label 之一');
}

/**
 * 按顺序执行脚本里的 steps。
 * @param {import('playwright-core').Page} page
 * @param {Array<object>} steps
 * @param {object} ctx { outDir, shot, redact, credentials, log }
 * @returns {Promise<Array<object>>} 每一步的结果（已脱敏）
 */
export async function runSteps(page, steps, ctx) {
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const type = String(step.type || '').toLowerCase();
    const entry = { index: i, type };
    const t0 = Date.now();
    try {
      switch (type) {
        case 'goto': {
          if (!step.url) throw new Error('goto 缺少 url');
          const resp = await page.goto(step.url, {
            waitUntil: step.waitUntil || 'domcontentloaded',
          });
          entry.status = resp ? resp.status() : null;
          entry.title = ctx.redact(await page.title());
          break;
        }

        case 'wait': {
          if (step.ms) {
            await page.waitForTimeout(Number(step.ms));
            entry.waited = Number(step.ms);
          } else if (step.selector) {
            await page.locator(step.selector).first().waitFor({ state: step.state || 'visible' });
            entry.waited = 'selector';
          } else if (step.text) {
            await page.getByText(step.text).first().waitFor({ state: step.state || 'visible' });
            entry.waited = 'text';
          } else {
            throw new Error('wait 需要 ms / selector / text 之一');
          }
          break;
        }

        case 'shot': {
          const name = String(step.name || `shot-${i}`).replace(/[^\w.-]+/g, '_');
          const file = path.join(ctx.outDir, `${String(i).padStart(2, '0')}-${name}.png`);
          await page.screenshot({ path: file, fullPage: !!step.fullPage });
          entry.file = path.basename(file);
          break;
        }

        case 'click': {
          const target = await resolveTarget(page, step);
          await target.click({ timeout: step.timeout });
          entry.clicked = true;
          break;
        }

        case 'fill': {
          const value =
            step.valueFrom && ctx.credentials
              ? ctx.credentials[step.valueFrom]
              : step.value;
          if (value === undefined || value === null || value === '') {
            throw new Error(
              `fill 缺少值：要么给 value，要么给 valueFrom（如 "user"/"pass"）并确保运行时注入了凭据`
            );
          }
          const target = await resolveTarget(page, step);
          await target.fill(String(value), { timeout: step.timeout });
          entry.filled = true;
          break;
        }

        case 'press': {
          const key = step.key || 'Enter';
          if (step.selector || step.text) {
            const target = await resolveTarget(page, step);
            await target.press(key, { timeout: step.timeout });
          } else {
            await page.keyboard.press(key);
          }
          entry.pressed = key;
          break;
        }

        case 'login': {
          if (!ctx.credentials || !ctx.credentials.user || !ctx.credentials.pass) {
            throw new Error('login 需要运行时提供凭据（user / pass）');
          }
          if (step.userSelector) {
            await page.locator(step.userSelector).first().fill(String(ctx.credentials.user));
          }
          if (step.passSelector) {
            await page.locator(step.passSelector).first().fill(String(ctx.credentials.pass));
          }
          if (step.submitSelector || step.submitText) {
            const t = await resolveTarget(page, {
              selector: step.submitSelector,
              text: step.submitText,
            });
            await Promise.all([
              page.waitForLoadState('domcontentloaded').catch(() => {}),
              t.click(),
            ]);
          } else {
            await page.keyboard.press('Enter');
          }
          entry.loggedIn = true;
          break;
        }

        case 'text': {
          const target = step.selector || step.text || step.role
            ? await resolveTarget(page, step)
            : page.locator('body');
          const raw = await target.innerText();
          entry.text = ctx.redact(truncate(raw, step.max || MAX_TEXT));
          break;
        }

        case 'title': {
          entry.title = ctx.redact(await page.title());
          break;
        }

        case 'url': {
          // 用于判断是否被重定向到登录页或其他站点
          entry.url = ctx.redact(page.url());
          break;
        }

        case 'neterrors': {
          // 报告加载失败的请求（主机 + 类型 + 错误），页面空白时先看这个
          const list = ctx.netErrors || [];
          const max = Number(step.max || 12);
          entry.neterrors = list.length
            ? list.slice(0, max).map((e) => `${e.host} ${e.resource} ${e.error}`).join(' ; ') +
              (list.length > max ? ` ; …共 ${list.length} 条` : '')
            : 'none';
          break;
        }

        case 'frames': {
          // 列出所有框架（含主框架）的主机名，用于判断内容是否在 iframe 里、是否跨域
          const list = page.frames().map((f, i) => {
            let host = '';
            try {
              host = new URL(f.url()).host;
            } catch {
              host = f.url() ? f.url().slice(0, 16) : 'about:blank';
            }
            return `${i}:${host || 'same-origin'}`;
          });
          entry.frames = list.join(' | ');
          break;
        }

        case 'urlhost': {
          // 只返回主机名：足够判断是否跨站跳转，又不暴露带 token / 工程 id 的完整路径
          try {
            entry.urlHost = new URL(page.url()).host;
          } catch {
            entry.urlHost = 'invalid';
          }
          break;
        }

        case 'count': {
          if (!step.selector) throw new Error('count 缺少 selector');
          entry.count = await page.locator(step.selector).count();
          break;
        }

        case 'scroll': {
          const y = Number(step.y ?? 800);
          await page.mouse.wheel(0, y);
          entry.scrolled = y;
          break;
        }

        default:
          throw new Error(`未知动作类型：${type || '(空)'}`);
      }
      entry.ok = true;
    } catch (err) {
      entry.ok = false;
      entry.error = ctx.redact(err && err.message ? err.message : String(err));
    }
    entry.ms = Date.now() - t0;
    results.push(entry);
    if (ctx.log) ctx.log(entry);
    if (!entry.ok && step.continueOnError !== true) break;
  }
  return results;
}
