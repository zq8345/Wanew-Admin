// Canonical product-page render — imported by BOTH scripts/regen.mjs (Node, local) and
// the CF Pages Function (Workers, publish-time regen). Pure string templating; no runtime
// APIs. related is generated from lightweight manifest entries {id,category,form,title,thumb}
// so publish-time regen needs only the manifest (not every product JSON).

// #52 批1：类目显示名硬编码（原 CATMAP）迁 data/categories.json（唯一真源，管理页可编辑）。
// render.js 保持纯函数不做 IO —— 调用方（regen.mjs / admin worker）读 json 后经 catmapOf() 传入。
export function catmapOf(categoriesJson) {
  const m = {};
  for (const c of (categoriesJson?.categories || [])) m[c.slug] = c.display;
  return m;
}

export function resolveImg(im, imgBase) {
  return im && im.key !== undefined ? imgBase + im.key : (im ? im.src : "");
}

// Field-level locale merge: every field falls back to en when the locale lacks it
// (i18n[locale][field] ?? en[field]) — including title (a pt title still carries tokens like
// Type-C/RJ45/AWG and the model name).
//
// meta_title is deliberately NOT read from data here — it is DERIVED (see metaTitleOf). A derived
// value stored as data drifts the moment someone edits the title, and the drift is invisible:
// that is exactly how "For Roteador Starlink Mini Cable…" (half English, half pt) got shipped.
// Derived values are not data.
export function mergeI18n(prod, locale) {
  const en = prod.i18n.en;
  if (locale === "en") return en;
  const loc = (prod.i18n && prod.i18n[locale]) || {};
  return {
    title: loc.title ?? en.title,
    summary_html: loc.summary_html ?? en.summary_html,
    description_html: loc.description_html ?? en.description_html,
    meta_description: loc.meta_description ?? en.meta_description,
  };
}

// meta_title = {localized title}-{model display}-Wanew{locale brand suffix}.
// Reproduces the stored value for all 64 products exactly, so deriving loses nothing and cannot
// go half-translated. Adding a language costs one catalog key, not 64 stored strings.
export function metaTitleOf(e, prod, locale, modelDisplay, catalog) {
  const sfx = catalog && catalog["meta.title.suffix"];
  const model = modelDisplay && modelDisplay[prod.category];
  // Without the catalog/model map wired in, fall back to the STORED meta_title so this change is
  // strictly additive: a caller that hasn't been updated behaves exactly as before. Deriving with
  // an empty suffix would silently drop the brand tail from every en <title> — a caller half-way
  // through migration must not be able to quietly break output.
  if (!sfx || !model) return prod.i18n.en.meta_title;
  const suffix = sfx[locale] ?? sfx.en ?? "";
  return `${e.title}-${model}-Wanew${suffix}`;
}

export function render(prod, { template, imgBase, related, locale = "en", modelDisplay, catalog, urlOf, enabled, catmap = {} }) {
  const e = mergeI18n(prod, locale);
  // Gallery alt is DERIVED from the localized title, not stored (总工 2026-07-14, verified across
  // all 428: 369 already duplicate the title verbatim, 59 are filenames, 0 are real descriptions —
  // so deriving loses nothing, fixes the filenames, and makes every future language correct for
  // free). phase2-convert used to achieve the same pt result by string-replacing the English title
  // with the Portuguese one; this does it by rule instead. Same output, no bypass to keep in sync.
  // Joe's explicit alt from the admin wins — the admin has an alt field, so it is his to set.
  // Derivable = empty, a filename, or the title in some dressed-up form. Test it BOTH ways: 670's
  // alts read "For Starlink Gen 2 Mount, Pivot Mount - wanew" — the title plus a suffix — so
  // title.startsWith(alt) is false while alt.startsWith(title) is true. Checking one direction
  // only left 10 images rendering English alt on pt pages.
  const enTitle = prod.i18n.en.title || "";
  const head = (s) => s.slice(0, 40);
  const isDerivable = (a) => !a || !a.trim() || /\.(jpe?g|png|webp|gif)\b|images? ?\(\d+\)/i.test(a)
    || enTitle.startsWith(head(a)) || a.startsWith(head(enTitle));
  const altOfImage = (im) => (isDerivable(im.alt) ? e.title : im.alt);
  const slides = prod.images.map((im) =>
    `\n                  <div class="swiper-slide feedback-single bg-white position-relative rounded"><img src="${resolveImg(im, imgBase)}" alt="${altOfImage(im)}" class="img-fluid" loading="lazy"></div>`
  ).join("") + "\n                ";
  const cards = related.map((c) =>
    `\n              <div class="col-xl-3 col-lg-4 col-md-6">\n                <div class="blog-one__single">\n                  <a href="${c.href}">\n                    <div class="blog-one__img"><img src="${c.img}" alt="${c.alt}" loading="lazy"></div>\n                    <div class="blog-content"><h3 class="blog-one__title">${c.title}</h3></div>\n                  </a>\n                </div>\n              </div>`
  ).join("") + "\n            ";
  const summary = e.summary_html ? `<div class="item-explain">\n                ${e.summary_html}\n              </div>` : "";
  const robots = prod.robots ? `\n<meta name="robots" content="${prod.robots}">` : "";
  // JSON-LD Product embeds the English meta_description verbatim; for a non-en locale swap it so
  // the structured data matches the visible <meta>. The name field stays en (SKU/model).
  let jsonldProduct = prod.jsonld_product || "";
  if (locale !== "en" && jsonldProduct) {
    const enDesc = prod.i18n.en.meta_description;
    if (enDesc && e.meta_description && e.meta_description !== enDesc) jsonldProduct = jsonldProduct.split(enDesc).join(e.meta_description);
  }
  // The template only knows how to be English. Everything phase2-convert used to do for pt on its
  // way past has to be done here now, or regenerating from the template silently un-does it —
  // canonical is the dangerous one: a pt page canonical'd to the EN page tells Google not to index
  // pt at all, and no check I own would go red. (r2-report.md §7 lists the full set.)
  const path = `/${prod.category}/${prod.id}`;
  const canonical = `https://wanew.com${urlOf ? urlOf(path, locale) : path}`;
  const enUrl = `https://wanew.com${path}`;
  // ⭐ 原来这里只发三条:en、【自己】、x-default —— 也就是"只认对侧"的二元形状。es 上线后,
  //   一个 pt 产品页会闭口不提它有西语版,反之亦然。hreflang 是互指的,漏一边等于没挂。
  //   → 每一门 enabled 语种都发,当且仅当【它那边真的有这个页】(urlOf 原样还回来 = 没有)。
  //   ⚠️ en 侧维持现状(不发 hreflang):那是本轮之前就有的结构缺口,改它会动 64 个英文页的
  //      <head>,不属于"上线 es"这次改动 —— 单独记账,不夹带。
  const hreflang = urlOf && locale !== "en" && Array.isArray(enabled) && enabled.length
    ? enabled
        .filter((loc) => loc === "en" || urlOf(path, loc) !== path)
        .map((loc) => `\n<link rel="alternate" hreflang="${loc}" href="https://wanew.com${urlOf(path, loc)}" />`)
        .join("") + `\n<link rel="alternate" hreflang="x-default" href="${enUrl}" />`
    : "";
  const reps = {
    META_TITLE: metaTitleOf(e, prod, locale, modelDisplay, catalog), META_DESC: e.meta_description,
    ROBOTS_META: robots, CANONICAL: canonical, HREFLANG: hreflang,
    HTML_LANG: locale, OG_LOCALE: locale === "en" ? "" : `\n<meta property="og:locale" content="${locale.replace("-", "_")}" />`,
    GALLERY_MAIN: slides, GALLERY_THUMB: slides, CATEGORY: (modelDisplay && modelDisplay[prod.category]) || catmap[prod.category] || prod.category,
    TITLE: e.title, SUMMARY_BLOCK: summary, DESCRIPTION: e.description_html,
    RELATED: cards, JSONLD_BREADCRUMB: prod.jsonld_breadcrumb || "", JSONLD_PRODUCT: jsonldProduct,
  };
  let r = template;
  for (const [k, v] of Object.entries(reps)) r = r.split(`{{${k}}}`).join(v);
  // Resolve the body-chrome catalog tokens (item 7). Tokenizing the template without teaching the
  // renderer to read them shipped literal "{{t.body.back}}" onto every page — the tokens ARE the
  // English now, so an unresolved one is a leak, not a cosmetic bug. Throw rather than leave the
  // brace on the page: a missing key must fail loudly, not render as markup.
  r = r.replace(/\{\{t\.([a-z0-9_.-]+)\}\}/gi, (m, key) => {
    const e = catalog && catalog[key];
    if (!e) throw new Error(`template references catalog key that does not exist: ${key}`);
    const v = e[locale] ?? e.en;
    if (v === undefined || v === null || v === "") throw new Error(`catalog ${key} has no value for ${locale} — the guard should have caught this first`);
    return v;
  });
  return r;
}

// entries: manifest rows {id,category,form,title,thumb}. Returns up to 4 related cards,
// same-category first, then same form-factor, then any — so no product is left empty.
// A manifest entry's title/excerpt are English; a locale's are under entry.i18n[locale].
// Same field-level fallback rule as the catalog — one rule, applied everywhere.
export const entryTitle = (e, locale) => (e.i18n && e.i18n[locale] && e.i18n[locale].title) || e.title;
export const entryExcerpt = (e, locale) => (e.i18n && e.i18n[locale] && e.i18n[locale].excerpt) ?? (e.excerpt || "");
// The card alt suffix is a template string, so it belongs in the catalog — not hardcoded here,
// where no guard could ever see it and every new language would inherit English silently.
// (The i18n window argues this suffix should not exist at all — 64 cards means a screen-reader
// user hears it 64 times — but removing it changes the EN alt output and would break R2's own
// "en byte-identical" gate. So: use it now, delete it as its own change. r1-findings.md §8.5.)
const altOf = (title, locale, catalog) => {
  const s = catalog && catalog["card.alt.suffix"];
  const suffix = (s && (s[locale] ?? s.en)) ?? "- wanew Products";
  return `${title} ${suffix}`;
};

// urlOf must be passed for a non-default locale, or every related-product card on a pt page
// points back at the English site. R1's routing rule was correct; this function simply drove
// around it — which is how e_links went 35 -> 256 on R2's first landing. A rule with an
// unblocked bypass is not a rule.
export function genRelated(prodEntry, entries, locale = "en", catalog, urlOf) {
  const byId = (a, b) => a.id - b.id;
  const others = entries.filter((p) => p.id !== prodEntry.id);
  const sameCat = others.filter((p) => p.category === prodEntry.category).sort(byId);
  const sameForm = others.filter((p) => p.category !== prodEntry.category && p.form === prodEntry.form).sort(byId);
  const rest = others.filter((p) => p.category !== prodEntry.category && p.form !== prodEntry.form).sort(byId);
  return [...sameCat, ...sameForm, ...rest].slice(0, 4).map((s) => {
    const title = entryTitle(s, locale);
    const p = `/${s.category}/${s.id}`;
    return { href: urlOf ? urlOf(p, locale) : p, img: s.thumb || "", alt: altOf(title, locale, catalog), title };
  });
}

// ---- List-page regen (/products/ + /{category}/): rebuild the card grid + chip counts ----
// form-factor bucket name -> data-form key used on the list pages.
export const FORM_KEY = {
  "Cables": "cables", "Mounts & Brackets": "mounts", "Power & Charging": "power",
  "Networking": "networking", "Cases & Protection": "cases",
};

export function cardHtml(e, locale = "en", catalog, urlOf) {
  const title = entryTitle(e, locale);
  const alt = altOf(title, locale, catalog);
  const href = urlOf ? urlOf(`/${e.category}/${e.id}`, locale) : `/${e.category}/${e.id}`;
  return `\n              <div class="col-xl-3 col-lg-4 col-md-6 wow fadeInUp" data-wow-delay="200ms" data-cat="${e.category}" data-form="${FORM_KEY[e.form] || ""}">\n                <div class="blog-one__single">\n                  <a href="${href}">\n                    <div class="blog-one__img">\n                      <img src="${e.thumb}" alt="${alt}" loading="lazy">\n                    </div>\n                    <div class="blog-content">\n                      <h3 class="blog-one__title">${title}</h3>\n                      <p class="blog-one__tt">${entryExcerpt(e, locale)}</p>\n                    </div>\n                  </a>\n                </div>\n              </div>`;
}

function updateChips(html, id, countFn) {
  return html.replace(new RegExp(`(<div class="product-chips" id="${id}">)([^]*?)(</div>)`), (m, open, inner, close) => {
    const upd = inner.replace(/(data-filter="([^"]+)"[^>]*>[^<]*<span class="product-chip__n">)(\d+)(<\/span>)/g,
      (mm, pre, f, old, post) => pre + countFn(f) + post);
    return open + upd + close;
  });
}

// A list page's <title> is DERIVED, never hand-written: `{name}-Wanew{suffix}`, suffix from the
// catalog. It was hand-written on all 25 pt pages, and 5 of them still carried the English suffix
// — the R1 thesis exactly: one catalog beats 159 hand-kept copies. Verified byte-identical against
// all 7 existing en category pages before being switched on, so it moves no en baseline.
//
// `name` is either a literal (model names — "Mini", "Performance (Gen 3)" — are brand terms and do
// not translate) or {t:key} for a common noun that does ("Products"/"Produtos" is body.banner.title,
// already in the catalog). Nothing new to sign for pt: both inputs already existed.
export function listTitleOf(name, locale, catalog) {
  const sfx = catalog && catalog["meta.title.suffix"];
  if (!sfx) return null;                                    // no catalog -> caller leaves the page alone
  const n = typeof name === "object" ? (catalog[name.t] && (catalog[name.t][locale] ?? catalog[name.t].en)) : name;
  if (!n) return null;
  return `${n}-Wanew${sfx[locale] ?? sfx.en}`;
}

// Homepage model tiles: alt is DERIVED from the tile's own href — `{model} {suffix}` — instead of
// hand-written 8× per locale. pt had 2 of 7 translated and 5 still English, which is what
// hand-keeping the same sentence in two places always converges to.
//
// The company-wall photo gets alt="" rather than a translation. Its alt only NAMED the image
// ("TEJOY company background wall") instead of carrying information the adjacent About copy
// doesn't already carry — the textbook definition of decorative, where empty alt is the correct
// a11y treatment. So it needs no pt value, in this or any future language: the string stops
// existing rather than getting translated.
export function setTileAlts(html, locale, catalog, modelDisplay) {
  const s = catalog && catalog["card.alt.category"];
  if (!s || !modelDisplay) return html;
  const suffix = s[locale] ?? s.en;
  html = html.replace(/(href="\/(?:pt\/)?([a-z0-9-]+)\/"[\s\S]{0,300}?alt=")([^"]*)(")/g,
    (m, pre, cat, old, post) => (modelDisplay[cat] ? pre + `${modelDisplay[cat]} ${suffix}` + post : m));
  return html.replace(/(<img[^>]*tejoy-company-wall\.png[^>]*alt=")[^"]*(")/g, "$1$2");
}

// R3(a) 首页:模板 + 散文目录 + 机型卡 -> 页面。
//
// 机型卡按【存在性】过滤,不是按一张写死的清单:一张卡只在它指向的页面于该语种存在时才出现。
// 这不是我发明的规则 —— 它精确预测了 pt 首页的现状(7 张,正好是有 pt 页的 7 个分类)。en 8 张。
// 好处是它自己会长:等 /pt/performance-gen-2/ 建出来,pt 首页自动就有第 8 张,没人需要记得。
export function renderHome(tpl, { locale, catalog, tiles, modelDisplay, urlOf, exists, dirOf, enabled }) {
  const sfx = catalog["card.alt.category"];
  const suffix = sfx[locale] ?? sfx.en;
  const cards = tiles
    .filter((t) => exists(`/${t.cat}/`, locale))
    .map((t) => {
      const name = modelDisplay[t.cat];
      return `<div class="product-grid-item">\n            <a href="${urlOf(`/${t.cat}/`, locale)}" class="product-grid-link">\n` +
        `              <div class="product-grid-img">\n                <img src="${t.img}" alt="${name} ${suffix}" loading="lazy">\n` +
        `              </div>\n              <div class="product-grid-text"><b>${name}</b></div>\n            </a>\n          </div>`;
    })
    .join("\n          \n          ");
  return renderPage(tpl.split("{{TILES}}").join(cards), { locale, catalog, urlOf, dirOf, enabled });
}

// R3 的通用页渲染:模板 + 散文目录 -> 页面。首页只是它多一个 {{TILES}} 的特例。
// (a) 是为首页定制的;(b) 有 11 个页、(c)(d)(e) 还有 71 个 —— 同一套机器,参数化一次用四桶。
export function renderPage(tpl, { locale, catalog, urlOf, path = "/", dirOf, enabled }) {
  let out = tpl;
  // ⛔ 目录前缀必须【派生】,不许在这里写死。原来这里是 `locale === "en" ? path : "/pt" + path`
  //    —— 一个【二元】判据:凡不是 en 的一律当 pt。第三门语言一进来,82 个 es 页的 canonical
  //    全部指向 /pt/,等于对 Google 声明"西语页是葡语页的副本"。它不报错、不白屏,和上面
  //    那个 canonical 事故是同一种死法。
  //    ⭐ 这是同一条规则第三次被写死:scripts/regen.mjs 的 dirOf(已修)、这里、以及 8 个
  //    列表页手写烘死的 head(本轮走一次性修,收口另记)。**判据是二元的,语言不是。**
  //    → dirOf 由调用方从 data/locales.json 派生(scripts/locale-dirs.mjs 是唯一真源)传进来。
  if (typeof dirOf !== "function") throw new Error("renderPage: 必须传 dirOf(locale) —— 目录名从 locales.json 派生,缺省回落到 'pt' 正是要根除的那个 bug");
  if (!Array.isArray(enabled) || !enabled.length) throw new Error("renderPage: 必须传 enabled(locales.json 的 enabled) —— hreflang 的语种集合不许在这里写死");
  // ⛔ canonical 必须是【每页自己的】路径。第一版我把首页的逻辑当成了通用的(写死 "/"),于是
  // 11 个信息页的 canonical 全指向 https://wanew.com/ —— 等于告诉 Google 这 11 个页不该被单独
  // 收录。它不报错、不白屏、页面看着完全正常,只会在几周后表现为"这些页从搜索结果消失了",
  // 而那时没人会联想到这次重构。(c)(d)(e) 复用这台机器,所以它是断言,不是"我记得"。
  if (!path.startsWith("/") || !path.endsWith("/")) throw new Error(`renderPage: path 必须形如 "/slug/",拿到 ${JSON.stringify(path)}`);
  const pre = (loc) => { const d = dirOf(loc); return d ? `/${d}` : ""; };   // "" | "/pt" | "/es"
  const self = `${pre(locale)}${path}`;
  const enUrl = `https://wanew.com${path}`;
  const reps = {
    HTML_LANG: locale,
    CANONICAL: `https://wanew.com${self}`,
    // breadcrumb 的 position 1 指【首页】,position 2 才指本页 —— 两件不同的东西,我第一版
    // 把它们合成了一个 token,于是 /faq/ 的面包屑第一级指向了 /faq/ 自己。
    // 首页恰好两者相同,所以这个错在 (a) 里完全不可见 —— 又一次:重复不可见的那一侧最会骗人。
    // 默认语种没有前缀 -> 站点根(无尾斜杠);有前缀的 -> 前缀 + 尾斜杠。判据是"有没有目录",
    // 不是"是不是 en" —— 同一条规则,不再点名任何一门语言。
    HOME_URL: pre(locale) ? `https://wanew.com${pre(locale)}/` : "https://wanew.com",
    CANONICAL_NOSLASH: self === "/" ? "https://wanew.com" : `https://wanew.com${self}`,
    OG_LOCALE: locale === "en" ? "" : `\n<meta property="og:locale" content="${locale.replace("-", "_")}" />`,
    // hreflang 由 route 算出来,【每一门 enabled 语种都发】—— hreflang 本来就是互指的,
    // 只在一侧挂等于没挂。现网 en 侧【时有时无】(en/about 就没有),pt 侧齐全:又是 pt 对、
    // en 残缺,和 breadcrumb 同一个形状。派生顺带把 en 缺的补齐 ——
    // 按总工那条线,正确答案可计算 = 结构修复,免费,该做。
    // ⭐ 原来这三行把 en / pt-BR 写死了。切换器已经在每个页上挂出 ES 按钮,hreflang 却不认 es
    //   —— 等于告诉 Google「有这个链接,但它不是本站的语言版本」。**半加一门语言比不加更糟。**
    // ⚠️ 存在性是规则:某语种没有这个页(比如 es-hold 扣留的产品),就【不发】它的 alternate,
    //   否则是在声明一个 404。这和切换器、body 内链用的是同一条规则,不是这里新发明的。
    HREFLANG: `<!-- hreflang alternates (derived from locales.json + page existence) -->\n` +
      enabled
        // urlOf 把 p 原样还回来 = "该语种没有这个页" —— 复用它,不另造一个 exists 参数。
        .filter((loc) => !pre(loc) || urlOf(path, loc) !== path)
        .map((loc) => `<link rel="alternate" hreflang="${loc}" href="https://wanew.com${urlOf(path, loc)}" />`)
        .concat(`<link rel="alternate" hreflang="x-default" href="${enUrl}" />`).join("\n"),
  };
  for (const [k, v] of Object.entries(reps)) out = out.split(`{{${k}}}`).join(v);
  // body 内链走同一条存在性规则(chrome 早就在用):有该语种的页就加前缀,没有就留原样。
  // 这不是我为首页新发明的 —— 它精确复现了 pt 首页的现状:/pt/products/ 有前缀,而 /power/4384
  // 没有,因为那 3 个指南页没有 pt 版。URL 的差异不是翻译,不进目录(R1 洞②)。
  out = out.replace(/\{\{url\.([^}]+)\}\}/g, (m, p) => urlOf(p, locale));
  // ⭐ 语言标注:【派生】,不写死。多语言的理由,而且它是这周每个坑的形状:
  //   「手写 30 个 'em inglês' → Phase 3 译完后必须有人记得删掉那 30 个 → 忘了就【反向撒谎】
  //    (说是英文,其实是葡语)。一个写的时候对、后来烂掉的值。」
  // 规则和首页机型卡按存在性过滤是【同一条】:目标页在读者的语种里不存在 → 标注;存在 → 没有。
  // en 那侧永远存在 → 永远没有标注,不需要任何特例。Phase 3 一落地,标注自动消失、链接自动切,
  // 没人需要记得任何事。
  //
  // 「卡片用葡语描述英文文章不是撒谎 —— 那是图书馆目录:用读者的语言告诉他这本书讲什么。
  //   缺的只有一句『这本书是英文的』。」措辞由多语言签(pt 真源),机制是这里的。
  // 不需要新接线:urlOf 本身【就是】存在性规则 —— 它把 p 原样还回来,就意味着"该语种没有这个页"。
  // 复用它,而不是再造一个 exists 参数:同一个事实只该有一个来源,两个来源迟早会分叉。
  out = out.replace(/\{\{badge\.([^}]+)\}\}/g, (m, p) => {
    if (locale === "en") return "";                       // en 侧一切都在 en 里 —— 规则自然,不是特例
    if (urlOf(p, locale) !== p) return "";                // 该语种有这个页 -> 不标注
    const b = catalog["card.lang_badge"];
    if (!b) throw new Error("renderPage: 模板要 {{badge.*}} 但 catalog 里没有 card.lang_badge");
    const v = b[locale] ?? b.en;
    if (!v) throw new Error(`renderPage: card.lang_badge 在 ${locale} 下没有值`);
    return ` <span class="tj-lang-badge">${v}</span>`;
  });
  // 缺 key 就抛 —— 一个没解析的 token 印在页面上就是泄漏,静默回退成英文更糟(R1 的教训)
  out = out.replace(/\{\{t\.([a-z0-9_.-]+)\}\}/gi, (m, key) => {
    const e = catalog[key];
    if (!e) throw new Error(`renderPage: 模板引用了不存在的 key: ${key}`);
    const v = e[locale] ?? e.en;
    if (v === undefined || v === null || v === "") throw new Error(`renderPage: catalog ${key} 在 ${locale} 下没有值`);
    return v;
  });
  return assertNoTokens(out, locale);
}

// ⛔ 否定式:输出里【只要还剩任何 {{...}}】就炸 —— 不是"我认得出、但解析不了的才炸"。
//
// 上一版正好相反,于是它漏掉了自己:token 正则是 [a-z0-9_.],而 slug 里有连字符,
// {{t.certifications-testing.meta.keywords}} 于是原样印在了页面上 —— 那道专门为
// 「未解析 token = 泄漏」建的抛错保护【一次都没触发】,因为它不认识那是个 token。
// 网只网得住它看得见的东西。所以别再让网去认东西:凡是没被解析掉的花括号,一律炸。
// 这样下一个我还没想到的 token 形状(拼错的、新加的、大小写的)也会炸,而不是安静通过。
export function assertNoTokens(out, locale) {
  const left = out.match(/\{\{[^}]*\}\}/g);
  if (left) throw new Error(`renderPage: 输出里还剩 ${left.length} 个未解析的 token(${locale}): ${[...new Set(left)].slice(0, 5).join(" ")}`);
  return out;
}

// 列表页的 banner 标题 + 筛选栏标签。这 10 条串以前【写死在 8 个列表页的 HTML 里】,
// catalog 一条都没有。后果:加一门语言时,拿 en 页复制留英文、拿 pt 页复制留葡语,两条路都不通。
//
// ⭐ banner 不存 7 条串,存【一个模式】:en "Starlink {model} Accessories" /
//    pt "Acessórios para Starlink {model}",7 个机型页的标题由 model_display 派生。
//    存 7 条串就是把同一个决定存 7 遍,其中一条迟早漂 —— pt 的 standard 就漂了
//    ("Acessórios Starlink Standard",少一个 para),7 条里错 1 条,没人发现。
//    加一门语言,母语方只需要签【一个模式】。
//
// ⚠️ 只碰 catalog 真正拥有的那几处:机型 chip 的名字(Mini/Standard…)是 model_display,
//    属于 fallback 里的型号名、不翻;形态 chip(Mounts & Brackets…)在 chrome 里,已经有主了。
export function setListLabels(html, { locale, catalog, model }) {
  const t = (key) => {
    const e = catalog[key];
    if (!e) throw new Error(`setListLabels: catalog 缺 key ${key}`);
    const v = e[locale] ?? e.en;
    if (v === undefined || v === null || v === "") throw new Error(`setListLabels: ${key} 在 ${locale} 下没有值`);
    return v;
  };
  let out = html;
  if (model) {
    const h1 = t("list.banner.model").replace("{model}", model);
    out = out.replace(/(<h1 class="page-header__title">)[^<]*(<\/h1>)/, `$1${h1}$2`);
  }
  // 筛选栏两个标签:第一个是机型轴、第二个是形态轴 —— 顺序由页面结构固定,不是我猜的。
  let n = 0;
  out = out.replace(/(<span class="product-chiprow__label">)[^<]*(<\/span>)/g,
    (m, a, b) => a + t(n++ === 0 ? "list.filter.model" : "list.filter.type") + b);
  // 两条轴各有一个 "All" chip,同一个词。只认 href 指向该轴全集的那一个,
  // 不按文本 "All" 认 —— 型号 chip 里将来若出现同名值,按文本认会误伤。
  const ALL = t("list.chip.all");
  out = out.replace(/(<a class="product-chip[^"]*" href="[^"]*"(?: data-filter="all")?>)([^<]*?)( <span class="product-chip__n">)/g,
    (m, a, label, b) => (label === "All" || label === ALL ? a + ALL + b : m));
  return out;
}

export function setListTitle(html, name, locale, catalog) {
  const t = listTitleOf(name, locale, catalog);
  if (!t) return html;
  return html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
}

// Rebuild #productGrid cards + the model/form chip counts. catFilter=null for /products/,
// or a category slug for /{category}/. Returns updated html (unchanged if no #productGrid).
// catFilter accepts a category slug (as before), null for /products/, an ARRAY of slugs (the
// Gen 2 page aggregates the Performance family — it has 0 products of its own and must not be a
// dead click), or {form} for the /type/ pages. One predicate covers all four so no caller needs a
// special case, and adding a fifth kind of list page later costs nothing.
export function regenListPage(html, entries, catFilter, { locale = "en", catalog, urlOf } = {}) {
  const inScope = (e) => {
    if (!catFilter) return true;
    if (Array.isArray(catFilter)) return catFilter.includes(e.category);
    if (typeof catFilter === "object") return catFilter.form ? e.form === catFilter.form : true;
    return e.category === catFilter;
  };
  const scope = entries.filter(inScope)
    .sort((a, b) => a.category.localeCompare(b.category) || a.id - b.id);
  // NB: must be an arrow, not `scope.map(cardHtml)` — map passes (el, index, array), so the bare
  // reference would feed the INDEX in as `locale`. It would even look fine in en (an unknown
  // locale falls back to English), which is the worst kind of wrong: right by accident.
  const cards = scope.map((e) => cardHtml(e, locale, catalog, urlOf)).join("") + "\n            ";
  html = html.replace(
    /(<div class="row" id="productGrid">)(?:\s*<div class="col-xl-3[^"]*"[^>]*data-cat="[^"]*"[^>]*>[\s\S]*?<\/a>\s*<\/div>\s*<\/div>)*\s*(<\/div>)/,
    (m, open, close) => open + cards + close
  );
  // Both chip rows count WITHIN scope — a chip's number has to describe the grid under it, or it
  // lies. Provably a no-op today: on /products/ scope IS entries (catFilter null), and that is the
  // only page carrying modelChips. It's what makes the /type/ pages, whose scope is one form,
  // count 33 cables per model instead of reporting all 64 products over a 33-card grid.
  const countModel = (f) => (f === "all" ? scope.length : scope.filter((e) => e.category === f).length);
  const countForm = (f) => (f === "all" ? scope.length : scope.filter((e) => FORM_KEY[e.form] === f).length);
  html = updateChips(html, "modelChips", countModel);
  html = updateChips(html, "formChips", countForm);
  return html;
}

// Short text excerpt for list cards (first ~92 chars of description/summary).
// Derived, never stored: the excerpt is the head of the description. Deriving it per locale means
// a pt card excerpt follows the pt description automatically — nobody has to remember to update
// a second copy, and it cannot go stale.
export function excerptOf(prod, locale = "en") {
  const e = mergeI18n(prod, locale);
  const txt = (e.description_html || e.summary_html || "")
    .replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  return txt ? txt.slice(0, 92).trim() + " ···" : "";
}
