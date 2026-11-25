/**
 * 动作执行器。
 *
 * 脚本文件里只允许出现「选择器 / 文字 / 参数 / ref」，
 * 绝不允许出现账号密码 —— 凭据由运行时注入（见 credentials 参数）。
 * 这样脚本可以放心提交进 Git。
 *
 * 定位优先级：ref > selector > text > role+name > placeholder > label。
 * ref 来自 snapshot 动作（ref:e3 这种短引用），比手写 CSS 选择器稳。
 */
import path from 'node:path';
import { resolveRef, buildRefs, formatRefs } from './refs.mjs';

const MAX_TEXT = 4000;
const DEFAULT_RETRY_DELAY = 500;

function truncate(s, n = MAX_TEXT) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + `…（已截断，共 ${str.length} 字）` : str;
}

/** 当前操作根：切进 iframe 后就是那个 frame，否则是 page */
function rootOf(page, state) {
  return state && state.frame ? state.frame : page;
}

function selectorOf(step, state) {
  if (step.ref) return resolveRef(state?.refs || {}, step.ref);
  if (step.selector) return step.selector;
  return null;
}

async function resolveTarget(page, step, state) {
  const root = rootOf(page, state);
  const sel = selectorOf(step, state);
  if (sel) return root.locator(sel).first();
  if (step.text) return root.getByText(step.text, { exact: !!step.exact }).first();
  if (step.role && step.name) return root.getByRole(step.role, { name: step.name }).first();
  if (step.placeholder) return root.getByPlaceholder(step.placeholder).first();
  if (step.label) return root.getByLabel(step.label).first();
  throw new Error(
    '这一步缺少定位信息：ref / selector / text / role+name / placeholder / label 之一'
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 取框架的 url 做标签：不同 Playwright 版本里 url 可能是方法也可能是属性 */
function frameUrl(frame) {
  if (!frame) return '';
  try {
    if (typeof frame.url === 'function') return String(frame.url());
    if (typeof frame.url === 'string') return frame.url;
  } catch {}
  return '';
}

/** 断言类动作：不满足直接抛错，让这一步失败 */
function failAssert(what, actual) {
  const err = new Error(`断言失败：${what}（实际：${String(actual).slice(0, 200)}）`);
  err.isAssertion = true;
  return err;
}

/**
 * 按顺序执行脚本里的 steps。
 * @param {import('playwright-core').Page} page
 * @param {Array<object>} steps
 * @param {object} ctx { outDir, redact, credentials, netErrors, log, state }
 * @returns {Promise<Array<object>>} 每一步的结果（已脱敏）
 */
export async function runSteps(page, steps, ctx) {
  const state = ctx.state || (ctx.state = { frame: null, frameLabel: null, refs: {} });
  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const type = String(step.type || '').toLowerCase();
    const attempts = 1 + Math.max(0, Number(step.retries) || 0);
    const retryDelay = Number(step.retryDelay ?? DEFAULT_RETRY_DELAY);
    let entry = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      entry = { index: i, type, attempt };
      const t0 = Date.now();
      try {
        await execStep(page, step, ctx, state, entry);
        entry.ok = true;
      } catch (err) {
        entry.ok = false;
        const base = ctx.redact(err && err.message ? err.message : String(err));
        entry.error = step.hint ? `${base}\n提示：${ctx.redact(String(step.hint))}` : base;
      }
      entry.ms = Date.now() - t0;
      if (entry.ok || attempt === attempts) break;
      await sleep(retryDelay);
    }

    if (entry.attempt > 1 && entry.ok) entry.retriedAfter = entry.attempt - 1;
    results.push(entry);
    if (ctx.log) ctx.log(entry);
    if (!entry.ok && step.continueOnError !== true) break;
  }
  return results;
}

async function execStep(page, step, ctx, state, entry) {
  const type = String(step.type || '').toLowerCase();

  switch (type) {
    case 'goto': {
      if (!step.url) throw new Error('goto 缺少 url');
      const resp = await page.goto(step.url, { waitUntil: step.waitUntil || 'domcontentloaded' });
      entry.status = resp ? resp.status() : null;
      entry.title = ctx.redact(await page.title());
      break;
    }

    case 'wait': {
      if (step.ms) {
        await page.waitForTimeout(Number(step.ms));
        entry.waited = Number(step.ms);
      } else if (step.selector || step.ref) {
        await (await resolveTarget(page, step, state)).waitFor({
          state: step.state || 'visible',
          timeout: step.timeout,
        });
        entry.waited = 'element';
      } else if (step.text) {
        await (await resolveTarget(page, step, state)).waitFor({
          state: step.state || 'visible',
          timeout: step.timeout,
        });
        entry.waited = 'text';
      } else {
        throw new Error('wait 需要 ms / ref / selector / text 之一');
      }
      break;
    }

    case 'shot': {
      const name = String(step.name || `shot-${entry.index}`).replace(/[^\w.-]+/g, '_');
      const file = path.join(ctx.outDir, `${String(entry.index).padStart(2, '0')}-${name}.png`);
      // 动画一直跑的页面（编辑器、数据大屏）截图会卡住，给足超时并默认冻结动画
      await page.screenshot({
        path: file,
        fullPage: !!step.fullPage,
        timeout: step.timeout ?? 30000,
        animations: step.animations === false ? 'allow' : 'disabled',
        caret: 'hide',
      });
      entry.file = path.basename(file);
      break;
    }

    case 'click': {
      const target = await resolveTarget(page, step, state);
      await target.click({ timeout: step.timeout, force: !!step.force });
      entry.clicked = true;
      break;
    }

    case 'dblclick': {
      const target = await resolveTarget(page, step, state);
      await target.dblclick({ timeout: step.timeout, force: !!step.force });
      entry.dblclicked = true;
      break;
    }

    case 'fill': {
      const value =
        step.valueFrom && ctx.credentials ? ctx.credentials[step.valueFrom] : step.value;
      if (value === undefined || value === null || value === '') {
        throw new Error(
          `fill 缺少值：要么给 value，要么给 valueFrom（如 "user"/"pass"）并确保运行时注入了凭据`
        );
      }
      const target = await resolveTarget(page, step, state);
      await target.fill(String(value), { timeout: step.timeout, force: !!step.force });
      entry.filled = true;
      break;
    }

    case 'type': {
      if (step.value === undefined) throw new Error('type 缺少 value');
      if (step.ref || step.selector || step.text || step.role || step.placeholder || step.label) {
        const target = await resolveTarget(page, step, state);
        await target.click({ timeout: step.timeout, force: !!step.force });
      }
      await page.keyboard.type(String(step.value), { delay: Number(step.delay || 25) });
      entry.typed = true;
      break;
    }

    case 'selectall': {
      await page.keyboard.press('Control+A');
      entry.selectedAll = true;
      break;
    }

    case 'press': {
      const key = step.key || 'Enter';
      if (step.ref || step.selector || step.text || step.role || step.placeholder || step.label) {
        const target = await resolveTarget(page, step, state);
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
      const root = rootOf(page, state);
      if (step.userSelector) {
        await root.locator(step.userSelector).first().fill(String(ctx.credentials.user));
      }
      if (step.passSelector) {
        await root.locator(step.passSelector).first().fill(String(ctx.credentials.pass));
      }
      if (step.submitSelector || step.submitText) {
        const t = await resolveTarget(page, {
          selector: step.submitSelector,
          text: step.submitText,
        }, state);
        await Promise.all([page.waitForLoadState('domcontentloaded').catch(() => {}), t.click()]);
      } else {
        await page.keyboard.press('Enter');
      }
      entry.loggedIn = true;
      break;
    }

    case 'text': {
      const hasTarget =
        step.ref || step.selector || step.text || step.role || step.placeholder || step.label;
      const target = hasTarget ? await resolveTarget(page, step, state) : rootOf(page, state).locator('body');
      const raw = await target.innerText();
      entry.text = ctx.redact(truncate(raw, step.max || MAX_TEXT));
      break;
    }

    case 'title': {
      entry.title = ctx.redact(await page.title());
      break;
    }

    case 'url': {
      entry.url = ctx.redact(page.url());
      break;
    }

    case 'urlhost': {
      try {
        entry.urlHost = new URL(page.url()).host;
      } catch {
        entry.urlHost = 'invalid';
      }
      break;
    }

    case 'neterrors': {
      const list = ctx.netErrors || [];
      const max = Number(step.max || 12);
      entry.neterrors = list.length
        ? list.slice(0, max).map((e) => `${e.host} ${e.resource} ${e.error}`).join(' ; ') +
          (list.length > max ? ` ; …共 ${list.length} 条` : '')
        : 'none';
      break;
    }

    case 'frames': {
      const list = page.frames().map((f, i) => {
        const u = frameUrl(f);
        let host = '';
        try {
          host = u ? new URL(u).host : '';
        } catch {
          host = u ? 'non-http' : 'about:blank';
        }
        return `${i}:${host || 'same-origin'}`;
      });
      entry.frames = list.join(' | ');
      break;
    }

    case 'switchframe': {
      // 跨域（OOPIF）也支持：Playwright 的 Frame 直接持有跨进程上下文
      let frame = null;
      if (step.ref || step.selector) {
        // 注意：locator.contentFrame() 在新版 Playwright 里返回的是 FrameLocator
        // （只有 locator/getBy*，没有 evaluate/url）。这里要的是真正的 Frame，
        // 所以走 elementHandle().contentFrame()。
        const target = await resolveTarget(page, step, state);
        const handle = await target.elementHandle({ timeout: step.timeout });
        if (!handle) throw new Error('拿不到 iframe 元素句柄');
        frame = await handle.contentFrame();
        if (!frame) throw new Error('这个元素不是 iframe（contentFrame 为空）');
      } else if (step.url) {
        frame = page.frames().find((f) => frameUrl(f).includes(step.url)) || null;
        if (!frame) throw new Error(`没有匹配 url 包含 ${step.url} 的框架`);
      } else if (step.name) {
        frame = page.frame({ name: step.name });
        if (!frame) throw new Error(`没有名为 ${step.name} 的框架`);
      } else if (step.index !== undefined) {
        frame = page.frames()[Number(step.index)] || null;
        if (!frame) throw new Error(`没有第 ${step.index} 个框架`);
      } else {
        throw new Error('switchframe 需要 ref / selector / url / name / index 之一');
      }
      state.frame = frame;
      state.frameLabel = ctx.redact(frameUrl(frame));
      // 换框架后旧 ref 失效
      state.refs = {};
      entry.frame = state.frameLabel || 'switched';
      break;
    }

    case 'switchtomain': {
      state.frame = null;
      state.frameLabel = null;
      state.refs = {};
      entry.frame = 'main';
      break;
    }

    case 'snapshot': {
      // 扫页面可交互元素，产出 ref:eN 供后续动作使用
      const root = rootOf(page, state);
      const { items, map, total } = await buildRefs(root, { max: Number(step.max || 200) });
      state.refs = map;
      entry.snapshot = items.length
        ? ctx.redact(formatRefs(items))
        : `没找到可交互元素（扫描到 ${total} 个候选，均不可见或已禁用）`;
      entry.count = items.length;
      if (step.save !== false) {
        const file = path.join(ctx.outDir, 'refs.json');
        await (await import('node:fs/promises')).writeFile(
          file,
          JSON.stringify(
            { frame: state.frameLabel, total, items, selectors: map },
            null,
            2
          ),
          'utf8'
        );
        entry.refsFile = 'refs.json';
      }
      break;
    }

    case 'asserturl': {
      const actual = page.url();
      const ok = step.regex
        ? new RegExp(step.regex).test(actual)
        : step.exact
          ? actual === step.exact
          : actual.includes(step.contains || step.expect || '');
      if (!ok) {
        throw failAssert(
          `当前网址应${step.regex ? `匹配 ${step.regex}` : `包含 ${step.contains || step.expect || ''}`}`,
          ctx.redact(actual)
        );
      }
      entry.asserted = 'url';
      break;
    }

    case 'asserttext': {
      const target = await resolveTarget(page, step, state);
      const actual = (await target.innerText()).trim();
      const expected = step.contains ?? step.expect ?? '';
      const ok = step.regex
        ? new RegExp(step.regex).test(actual)
        : step.equals !== undefined
          ? actual === step.equals
          : actual.includes(expected);
      if (!ok) {
        throw failAssert(
          `文字应${step.regex ? `匹配 ${step.regex}` : step.equals !== undefined ? `等于「${step.equals}」` : `包含「${expected}」`}`,
          ctx.redact(actual)
        );
      }
      entry.asserted = 'text';
      entry.text = ctx.redact(truncate(actual, 200));
      break;
    }

    case 'assertcount': {
      const sel = selectorOf(step, state);
      if (!sel) throw new Error('assertcount 需要 ref 或 selector');
      const n = await rootOf(page, state).locator(sel).count();
      const ok =
        step.equals !== undefined
          ? n === Number(step.equals)
          : step.min !== undefined
            ? n >= Number(step.min)
            : step.max !== undefined
              ? n <= Number(step.max)
              : n > 0;
      if (!ok) throw failAssert(`元素数量应符合条件`, `${n} 个`);
      entry.asserted = 'count';
      entry.count = n;
      break;
    }

    case 'assertvisible': {
      const target = await resolveTarget(page, step, state);
      const visible = await target.isVisible().catch(() => false);
      if (step.visible === false) {
        if (visible) throw failAssert('元素应当不可见', '可见');
        entry.asserted = 'hidden';
      } else {
        if (!visible) throw failAssert('元素应当可见', '不可见');
        entry.asserted = 'visible';
      }
      break;
    }

    case 'dom': {
      const target = await resolveTarget(page, step, state);
      const html = await target.evaluate((el) => el.outerHTML);
      entry.html = ctx.redact(truncate(html, Number(step.max || 3000)));
      break;
    }

    case 'probe': {
      const sel = selectorOf(step, state);
      if (!sel) throw new Error('probe 需要 ref 或 selector');
      const max = Number(step.max || 20);
      const loc = rootOf(page, state).locator(sel);
      const total = await loc.count();
      const items = [];
      for (let k = 0; k < Math.min(total, max); k++) {
        const el = loc.nth(k);
        const info = await el
          .evaluate((node) => ({
            tag: node.tagName.toLowerCase(),
            type: node.getAttribute('type') || '',
            id: node.getAttribute('id') || '',
            cls: String(node.className || '').slice(0, 60),
            aria: node.getAttribute('aria-label') || '',
            ph: node.getAttribute('placeholder') || '',
            txt: (node.innerText || node.textContent || '').trim().slice(0, 40),
            vis: !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length),
          }))
          .catch(() => null);
        if (info) {
          items.push(
            `${k} <${info.tag}${info.type ? ' type=' + info.type : ''}${info.id ? ' id=' + info.id : ''}>${
              info.vis ? '' : '[hidden]'
            } ph="${info.ph}" aria="${info.aria}" txt="${info.txt}"`
          );
        }
      }
      entry.probe = { total, items: items.join(' | ') };
      break;
    }

    case 'bbox': {
      const target = await resolveTarget(page, step, state);
      const box = await target.boundingBox();
      entry.box = box
        ? `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`
        : 'none';
      break;
    }

    case 'clickxy': {
      if (step.x === undefined || step.y === undefined) throw new Error('clickxy 需要 x / y');
      await page.mouse.click(Number(step.x), Number(step.y));
      entry.clickedAt = `${step.x},${step.y}`;
      break;
    }

    case 'count': {
      const sel = selectorOf(step, state);
      if (!sel) throw new Error('count 需要 ref 或 selector');
      entry.count = await rootOf(page, state).locator(sel).count();
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
}
