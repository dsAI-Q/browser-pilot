/**
 * 可复用引用（ref）。
 *
 * 为什么要有：agent 手写 CSS 选择器最容易失败——类名是构建产物、结构一改就废。
 * 这里把页面上可交互的元素扫一遍，给每个元素一个短引用 ref:eN，
 * 后面所有动作都能写 {"type":"click","ref":"ref:e3"}，不用猜选择器。
 *
 * ref 只对本次会话有效（页面结构一变就可能对不上），所以每次 snapshot 都重新编号。
 */

const MAX_ELEMENTS = 200;

/** 在页面里跑的采集函数（会被序列化进页面上下文，必须自包含） */
function collectInPage(max) {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (Number(cs.opacity) === 0) return false;
    return !!(el.offsetParent || cs.position === 'fixed');
  };

  const cssPath = (el) => {
    if (el.id) {
      const sel = '#' + CSS.escape(el.id);
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {}
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      const tag = node.tagName.toLowerCase();
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      const idx = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
      node = parent;
    }
    return parts.length ? 'html > ' + parts.join(' > ') : 'html';
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(t)) return t;
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };

  const nameOf = (el) => {
    const pick = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const aria = pick(el.getAttribute('aria-label'));
    if (aria) return aria;
    const ph = pick(el.getAttribute('placeholder'));
    if (ph) return ph;
    const title = pick(el.getAttribute('title'));
    if (title) return title;
    const alt = pick(el.getAttribute('alt'));
    if (alt) return alt;
    const label = pick(el.getAttribute('aria-labelledby'));
    if (label) return label;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const v = pick(el.value);
      if (v) return v;
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) return pick(lab.textContent);
      }
    }
    return pick(el.innerText || el.textContent).slice(0, 40);
  };

  const selector =
    'a[href],button,input,select,textarea,summary,[role=button],[role=link],' +
    '[role=tab],[role=menuitem],[contenteditable=""],[contenteditable="true"]';
  const all = Array.from(document.querySelectorAll(selector));
  const items = [];
  for (const el of all) {
    if (items.length >= max) break;
    if (el.disabled) continue;
    if (!isVisible(el)) continue;
    items.push({
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el),
      selector: cssPath(el),
    });
  }
  return { total: all.length, items };
}

/**
 * 扫一遍页面，产出 ref 表。
 * @param {import('playwright-core').Page|import('playwright-core').Frame} root
 * @returns {Promise<{items: Array<{ref:string,role:string,name:string,tag:string}>, map: Record<string,string>, total:number}>}
 */
export async function buildRefs(root, { max = MAX_ELEMENTS } = {}) {
  const { total, items } = await root.evaluate(collectInPage, max);
  const map = {};
  const out = items.map((it, i) => {
    const ref = `ref:e${i + 1}`;
    map[ref] = it.selector;
    return { ref, role: it.role, name: it.name, tag: it.tag };
  });
  return { items: out, map, total };
}

/** 把 ref:e3 换成 CSS 选择器；找不到就抛错，并提示先 snapshot */
export function resolveRef(map, ref) {
  const key = String(ref || '').trim();
  if (!map || !map[key]) {
    const known = Object.keys(map || {}).length;
    throw new Error(
      `未知引用 ${key}：本次会话里没有这个 ref` +
        (known ? `（当前有 ${known} 个，最近一次 snapshot 之后页面可能已变化）` : '，先执行一次 snapshot 动作')
    );
  }
  return map[key];
}

/** 一行一条，给 agent 读的紧凑格式 */
export function formatRefs(items) {
  return items
    .map((it) => `${it.ref}\t${it.role}\t"${it.name}"\t${it.tag}`)
    .join('\n');
}
