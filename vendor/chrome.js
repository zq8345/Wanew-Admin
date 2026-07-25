// #52 批2：chrome 注入核心 —— 从 scripts/chrome-sync.mjs 抽出的纯函数库（单真源，W1b 铁律）。
// 消费方两个：① scripts/chrome-sync.mjs（全站常驻同步器，fs 版 pageExists）
//            ② admin-worker（运行时 regen 双步的第二步，闭集版 pageExists）
// ⚠️ 逻辑与 chrome-sync 原实现逐字等价 —— 收敛闸=重构后 dry run 全站「变更 0」（字节级）。
// 零 IO：所有数据（catalog/locales/partial/manifest）与 pageExists 谓词由调用方注入。

// content equality ignoring whitespace — the approved acceptance criterion
export const wsNorm = (s) => s.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();

const sliceBetween = (s, a, b, inc) => {
  const i = s.indexOf(a); if (i < 0) return null;
  const j = s.indexOf(b, i + a.length); if (j < 0) return null;
  return { start: i, end: inc ? j + b.length : j, text: s.slice(i, inc ? j + b.length : j) };
};

function deleteScriptWith(html, marker) {
  const m = html.indexOf(marker); if (m < 0) return html;
  const s = html.lastIndexOf("<script", m), e = html.indexOf("</script>", m);
  if (s < 0 || e < 0) return html;
  return html.slice(0, s) + html.slice(e + 9);
}

// W2d：清除历史内联切换器样式块（phase2 时代逐页注入的 <style>，块内注释原话就说
// "move to tejoy-redesign.css at global rollout"——W2d 即那次 rollout，样式已进 v57）。
// 与 deleteScriptWith 同族：常驻清理，漏网页面在每次 sync 时被扶正。
function deleteStyleWith(html, marker) {
  const m = html.indexOf(marker); if (m < 0) return html;
  const s = html.lastIndexOf("<style", m), e = html.indexOf("</style>", m);
  if (s < 0 || e < 0) return html;
  return html.slice(0, s) + html.slice(e + 8);
}

const ORPHAN_COMMENTS = [
  "<!-- 多语言页脚数据：所有语言的 Products 和 Service 子分类 -->",
  "<!-- 多语言Home/首页客户端翻译（放在body尾部确保DOM已就绪） -->",
];

const ANCHORS = [
  ["header", '<header class="main-header clearfix">', "</header>", true],
  ["footer", '<footer class="site-footer">', "</footer>", true],
  ["mobilenav", '<div class="mobile-nav__wrapper">', '<a href="#" data-target="html" class="scroll-to-target scroll-to-top">', false],
];

const FORM_KEY = { "Cables": "cables", "Mounts & Brackets": "mounts", "Power & Charging": "power", "Networking": "networking", "Cases & Protection": "cases" };

// localeDirs 规则的最小内联复刻由调用方传入（locDir 映射）——真源仍是 scripts/locale-dirs.mjs / regen。

export function makeChrome({ catalog, locales, partial, manifest, pageExists, locDir }) {
  const src = partial.replace(/\r/g, "");
  const block = (name) => {
    const m = src.match(new RegExp(`<!-- #block:${name} -->\\n([\\s\\S]*?)\\n<!-- #endblock -->`));
    if (!m) throw new Error(`partial 缺 #block:${name}`);
    return m[1];
  };
  const BLOCKS = { header: block("header"), switcher: block("switcher"), switcheritem: block("switcheritem"),
    switchercurrent: block("switchercurrent"), footer: block("footer"), mobilenav: block("mobilenav") };

  const LOCALES = locales.enabled;
  const DEFAULT_LOC = locales.default;
  const LOC_DIR = locDir;

  const pick = (key, readerLocale) => {
    const e = catalog[key];
    if (!e) throw new Error(`chrome: catalog 缺 key ${key}`);
    const v = e[readerLocale];
    if (v === undefined || v === null || v === "") throw new Error(`chrome: ${key} 缺 ${readerLocale} — guard 应该先拦住`);
    return v;
  };

  function localizeUrl(p, locale) {
    const dir = LOC_DIR[locale] ?? "";
    if (!dir) return p;   // default locale: VERBATIM（byte-identity 是重构闸）
    const abs = p.match(/^https?:\/\/(?:www\.)?wanew\.com(\/.*)$/);
    if (abs) p = abs[1];
    if (p.startsWith(`/${dir}/`)) return p;
    const m = p.match(/^(\/[^#?]*)([#?].*)?$/);
    if (!m) return p;
    const [, route, frag = ""] = m;
    const target = `${dir}${route}`;
    const file = route.endsWith("/") ? `${target}index.html` : `${target}.html`;
    return pageExists(file) ? `/${target}${frag}` : p;
  }

  const counts = { all: manifest.length };
  for (const [form, key] of Object.entries(FORM_KEY)) counts[key] = manifest.filter((e) => e.form === form).length;

  function renderBlock(blockSrc, locale, vars) {
    let out = blockSrc.replace(/\{\{t\.([a-z0-9_.]+)\}\}/gi, (m, key) => {
      const e = catalog[key];
      if (!e) throw new Error(`partial 引用了 catalog 没有的 key: ${key}`);
      const v = e[locale];
      if (v === undefined || v === null || v === "") throw new Error(`catalog ${key} 缺 ${locale} — guard 应该先拦住这个`);
      return v;
    });
    out = out.replace(/\{\{count\.([a-z]+)\}\}/g, (m, k) => { if (counts[k] === undefined) throw new Error(`未知计数 ${k}`); return counts[k]; });
    out = out.replace(/\{\{url\.([^}]+)\}\}/g, (m, p) => localizeUrl(p, locale));
    out = out.replace(/\{\{switcher\}\}/g, vars.switcher ?? "");
    out = out.replace(/\{\{var\.([a-z_]+)\}\}/g, (m, k) => vars[k] ?? "");
    return out;
  }

  // 对一张页面注入 chrome（输入=去 \r 的 html 与仓内相对路径），返回 { html, errors }。
  // locale 由目录反查（二元化石教训）；switcher=语言列表（存在性规则，非单链）。
  function applyChrome(html0, pagePath) {
    const errors = [];
    const seg1 = pagePath.split("/")[0];
    const locale = LOCALES.find((loc) => LOC_DIR[loc] && LOC_DIR[loc] === seg1) ?? DEFAULT_LOC;
    const dirSelf = LOC_DIR[locale];
    const enPath = "/" + (dirSelf ? pagePath.slice(dirSelf.length + 1) : pagePath).replace(/index\.html$/, "").replace(/\.html$/, "");

    // W2d：切换器=🌐悬停菜单，恒列全部语言。当前语言=高亮不可点(span)；其它语言=对应页存在→
    // 对应页，不存在→该语言首页兜底（存在性规则只决定 href，不再决定条目有无）。
    const items = LOCALES.map((loc) => {
      const short = loc.split("-")[0];
      const label = pick(`switcher.code.${short}`, locale);
      if (loc === locale)
        return renderBlock(BLOCKS.switchercurrent, locale, {}).replace(/\{\{sw\.([a-z]+)\}\}/g, () => label);
      const dir = LOC_DIR[loc] ?? "";
      const rel = dir ? `${dir}${enPath}` : enPath.slice(1);
      const file = !rel || rel.endsWith("/") ? `${rel}index.html` : `${rel}.html`;
      const o = { href: pageExists(file) ? (dir ? `/${dir}${enPath}` : enPath) : (dir ? `/${dir}/` : "/"),
        hreflang: loc, label, aria: pick(`switcher.aria.to_${short}`, locale) };
      return renderBlock(BLOCKS.switcheritem, locale, {}).replace(/\{\{sw\.([a-z]+)\}\}/g, (m, k) => o[k]);
    });
    const switcher = renderBlock(BLOCKS.switcher, locale, {
      current_code: pick(`switcher.code.${locale.split("-")[0]}`, locale),
      items: items.join("\n            "),
    });

    let html = html0;
    for (const [name, a, b, inc] of ANCHORS) {
      const found = sliceBetween(html, a, b, inc);
      if (!found) { errors.push(`${pagePath}: 找不到锚点 ${name}`); continue; }
      let rendered;
      try { rendered = renderBlock(BLOCKS[name], locale, { switcher }); }
      catch (e) { errors.push(`${pagePath} ${name}: ${e.message}`); continue; }
      html = html.slice(0, found.start) + rendered + html.slice(found.end);
    }
    html = deleteScriptWith(html, "var FOOTER_LANGS");
    html = deleteScriptWith(html, "function getCookie");
    html = deleteStyleWith(html, ".lang-switch{position");
    for (const c of ORPHAN_COMMENTS) html = html.split(c).join("");
    return { html, errors, locale };
  }

  return { applyChrome, localizeUrl, renderBlock, wsNorm };
}
