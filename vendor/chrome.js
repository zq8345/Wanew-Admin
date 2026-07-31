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

// localeDirs 规则的最小内联复刻由调用方传入（locDir 映射）——真源仍是 scripts/locale-dirs.mjs / regen。
// `forms` = data/forms.json 的 forms[] 单源（[{key,name}]），由调用方（chrome-sync / admin worker）读入后传进来，
// 本模块保持无 fs。缺省 [] 是防御下限（nav 计数会全 0=肉眼可见，非崩溃），真源缺失应由调用方 flag。

/* 品类 key → 它在 chrome.json 里的标签键。
   🔴 **键名是历史包袱,不是语义** —— 它们从旧英文显示名 slug 派生(power → header.power_charging、
   cases → header.cases_protection)。所以这张表【无法从数据派生】,必须显式存在。
   ⚠️ 但键名难看无害:它只是内部标识符。真正的病是"改了显示名、页面上不变",那个由下面
   applyFormNames 治掉。**不要为了让键名好看去改键名** —— 改键要动 698 页的模板引用,而收益是零。
   ⚠️ 已知欠账:render.js 里还有一份同样的表(函数内局部)。今天不动它是为了把改动面压到最小,
   收敛成一份单独排。**两份变一份可以等,但别变成三份。** */
export const FORM_LABEL_KEY = {
  mounts: "header.mounts", power: "header.power_charging", cables: "header.cables",
  networking: "header.networking", cases: "header.cases_protection",
};

/* `data/forms.json` 的 name 是品类显示名的【真源】—— Joe 在后台改的就是它。
   在这之前,页面上的品类名读 chrome.json 的 header.*,两条链平行不相交 ⇒
   **后台改完名、跑多少次构建都不变**(2026-07-29 实测:改名后 621 个页面一字未动)。
   这个函数把真源覆盖到 catalog 上,调用方读入 chrome.json 之后立刻套一次。

   只覆盖 en。es/pt/zh 保持 chrome.json 现值 —— **那不是 bug**:西语标签不必是英语的直译,
   它们是各自语言里对同一品类的叫法(Energía y carga 之于 Charging)。多语言编辑是另一件事。

   ⚠️ 按 FORM_LABEL_KEY 遍历,不按 forms 遍历。forms.json 里出现表里没有的新 key 时,
   这里【静默跳过】而不是抛 —— 抛会让"在后台加一个品类"直接保存失败。
   那种情况该由常驻闸报红(看得见、且不挡任何人的操作),不该由渲染期抛异常。 */
/* 🔴 `forms.json` 存【纯文本】("Cases & Protection")，`chrome.json` 存【HTML 就绪】的转义文本
   ("Cases &amp; Protection")——catalog 的值是直接插进 HTML 的，pick() 不做转义。
   2026-07-29 实测:第一版没转义就写进去，243 个页面的 `Cases &amp; Protection` 变成裸 `&`。
   ⚠️ **而坏掉的是我根本没打算改的那个品类** —— 被改的 Charging 完全正确。
      只验"改名生效了吗"会全绿;是"差异必须恰好等于声明的那一处"这条抓到的。
   ⚠️ 负向前查断言:只转义【不是实体开头】的 &，否则后台里输入 "&amp;" 会被二次转义成 "&amp;amp;"。 */
export const htmlReady = (s) => String(s)
  .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
  .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/* 🔴 `"` 是 2026-07-30 补的，而它是这一族里代价最大的那个字符：
   产品 662 的 pt 文案含 `0.3"`，插进 <meta content="…"> 后把属性【提前闭合】，
   后面的正文全部漏进标签、meta 被截断 —— 页面照样 200，没有任何闸会红。
   ⚠️ 转义 `&<>` 够文本上下文，**不够属性上下文**。这两个上下文必须一起满足，
      因为同一个值（如 TITLE）在模板里既进 <h1> 也进 value="…"。 */

export function applyFormNames(catalog, forms = []) {
  const byKey = new Map(forms.map((f) => [f.key, f]));
  const out = { ...catalog };
  for (const [formKey, catKey] of Object.entries(FORM_LABEL_KEY)) {
    const f = byKey.get(formKey);
    if (!f || !f.name || !out[catKey]) continue;
    out[catKey] = { ...out[catKey], en: htmlReady(f.name) };
  }
  return out;
}

export function makeChrome({ catalog, locales, partial, manifest, pageExists, locDir, forms = [] }) {
  // form-factor bucket name -> data-form key, derived from the single source (not hardcoded).
  /* 🔴 name 与 key 【都】映射到 key —— C 步 1:读取侧两者都认。
   产品数据里 `form` 存的是【显示名】当外键,所以改一个显示名要重写上百个文件。
   根治是把它改成存 key,而这是第一步:**读取侧先能同时认两种**,admin 才敢动数据。
   ⚠️ 顺序不可颠倒 —— 这一步没上线就迁移,线上按显示名匹配会全部落空,
   产品会从 /type/ 页整批消失。 */
const FORM_KEY = Object.fromEntries(forms.flatMap((f) => [[f.name, f.key], [f.key, f.key]]));
  const src = partial.replace(/\r/g, "");
  const block = (name) => {
    const m = src.match(new RegExp(`<!-- #block:${name} -->\\n([\\s\\S]*?)\\n<!-- #endblock -->`));
    if (!m) throw new Error(`partial 缺 #block:${name}`);
    return m[1];
  };
  const BLOCKS = { header: block("header"), switcher: block("switcher"), switcheritem: block("switcheritem"),
    switchercurrent: block("switchercurrent"), footer: block("footer"), mobilenav: block("mobilenav") };

  // render-set: enabled(SEO) ∪ render_extra(内部/no-SEO，如 zh)。切换器与目录反查按 render-set，
  // 所以 zh 会出现在语言菜单里、/zh/ 页能被反查出 locale=zh(否则回落 en → zh 页出英文导航)。
  // hreflang/sitemap 不看这里(它们只吃 enabled)——zh 因此渲染但不进 SEO。
  // render_extra 缺省 → LOCALES===enabled，行为逐字不变(收敛闸:en/pt/es chrome 字节不动)。
  const LOCALES = [...locales.enabled, ...(locales.render_extra || [])];
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
  // ⚠️ 必须按 forms 遍历、用 FORM_KEY 归一化 e.form ——
  // 表变双向之后,原来的 `Object.entries(FORM_KEY)` 会把同一个 key 遍历两遍(name 一次、key 一次),
  // 后一次的结果覆盖前一次。计数不会报错,只会变成"只数了其中一种写法"。
  for (const f of forms) counts[f.key] = manifest.filter((e) => FORM_KEY[e.form] === f.key).length;

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
      const label = pick(`switcher.native.${short}`, locale);   // dropdown = endonym (English/Português/Español/简体中文); button keeps the short code
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
