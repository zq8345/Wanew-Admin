import { htmlReady as esc } from "./chrome.js";
/* 🔴 输出转义。改之前 reps 里每一个值都【原样】插进模板 —— 而它们来自产品数据，
   也就是 Joe 随时会打字进去的地方。2026-07-30 线上实证（产品 662 pt）：
     meta_description 里的 `0.3"` 把 <meta content="…"> 属性提前闭合
     同一个引号让 JSON-LD 第 4 块 JSON.parse 失败
   两处都返回 200，没有任何闸会红。**这不是某个产品的问题，是每加一个产品就多一次机会。**

   ⚠️ 只转义【承载用户数据、且落在文本/属性上下文】的键。
      DESCRIPTION / SUMMARY_BLOCK / GALLERY_* / RELATED / JSONLD_* 是我们自己生成的 HTML 片段，
      转义它们会把标签变成可见字符 —— **"全都转义"在这里是错的，比不转义更明显地坏。**
   ⚠️ 复用 chrome.js 的 htmlReady，不另写一份：它已经处理了"不许二次转义已有实体"那个坑。 */
const ESCAPED_KEYS = ["META_TITLE", "META_DESC", "TITLE", "CARD_TITLE", "CATEGORY"];

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

// ── #66/#8：图片固有尺寸（防 CLS）─────────────────────────────────────────────
//
// 没有 width/height 时，浏览器要等图下载完才知道该留多大位置，内容就会跳。全站量到 5569 个
// <img> 没有这两个属性。正文里的图已经在构建时补上了（regen 的 imgAttrs），但**由本文件生成的**
// 画廊 / 卡片 / 瓦片图补不了：render.js 是双运行时（regen 用 Node，Admin 用 CF Worker），
// **Worker 读不到磁盘，量不出尺寸**。
//
// ⭐ 所以尺寸不在这里量，而是【构建期量好、作为数据穿进来】：`data/media-sizes.json`
//   （路径 -> [w,h]），regen 从磁盘生成它，Admin Worker 经 GitHub API 读同一份。
//   两条渲染路径吃同一份事实 —— 这正是之前 formKey 用过的那条路子。
// ⚠️ 查不到就【什么都不写】：一个错的宽高比比没有更糟（会按错的比例预留位置）。
//   所以 sizes 缺失时行为与今天完全一致，不会出坏页。
export function dimAttr(src, sizes) {
  const d = sizes && sizes[src];
  return Array.isArray(d) && d.length === 2 ? ` width="${d[0]}" height="${d[1]}"` : "";
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
    // ⚠️ 本函数是白名单不是透传:没列在这里的字段会被静默丢掉。加字段必须同时加这里。
    card_title: loc.card_title ?? en.card_title,
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

export function render(prod, { template, imgBase, related, locale = "en", modelDisplay, catalog, urlOf, enabled, catmap = {}, sizes }) {
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
    `\n                  <div class="swiper-slide feedback-single bg-white position-relative rounded"><img src="${resolveImg(im, imgBase)}"${dimAttr(resolveImg(im, imgBase), sizes)} alt="${altOfImage(im)}" class="img-fluid" loading="lazy"></div>`
  ).join("") + "\n                ";
  const cards = related.map((c) =>
    `\n              <div class="col-xl-3 col-lg-4 col-md-6">\n                <div class="blog-one__single">\n                  <a href="${c.href}">\n                    <div class="blog-one__img"><img src="${c.img}"${dimAttr(c.img, sizes)} alt="${c.alt}" loading="lazy"></div>\n                    <div class="blog-content"><h3 class="blog-one__title">${c.title}</h3></div>\n                  </a>\n                </div>\n              </div>`
  ).join("") + "\n            ";
  const summary = e.summary_html ? `<div class="item-explain">\n                ${e.summary_html}\n              </div>` : "";
  // P5: 详情页视频区(Admin #79 上传已做,官网渲染当时排期中→现补)。videos[] 真实形状(661.json):
  // [{ key:"u_file/uploads/x.mp4", poster:{key:"...webp"}, alt:"" }]。src/poster 走同一 resolveImg
  // (key→imgBase+key);无 videos→空串,不出空区。type 由扩展名派生(Admin 未来传 webm 也对)。
  const vids = Array.isArray(prod.videos) ? prod.videos.filter((v) => v && v.key) : [];
  const videosBlock = vids.length
    ? `\n  <section class="w3-pvideo">\n    <div class="w3-container">\n      <h2 class="w3-pvideo__title">{{t.body.videos.title}}</h2>\n      <div class="w3-pvideo__grid">` +
      vids.map((v) => {
        const ext = (v.key.split(".").pop() || "mp4").toLowerCase();
        const type = ext === "webm" ? "video/webm" : ext === "ogg" ? "video/ogg" : "video/mp4";
        const poster = v.poster && v.poster.key ? ` poster="${resolveImg(v.poster, imgBase)}"` : "";
        const label = v.alt && v.alt.trim() ? ` aria-label="${v.alt.replace(/"/g, "&quot;")}"` : "";
        return `\n        <video class="w3-pvideo__player" controls preload="metadata" playsinline${poster}${label}><source src="${resolveImg(v, imgBase)}" type="${type}"></video>`;
      }).join("") +
      `\n      </div>\n    </div>\n  </section>\n`
    : "";
  const robots = prod.robots ? `\n<meta name="robots" content="${prod.robots}">` : "";
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
  //   ⭐ 2026-07-26 补上 en 侧欠账(审计挖出的真 SEO bug):原来 en 详情页发 0 条 hreflang,而
  //      es/pt 各发 4 条簇 → 非互惠,Google 整簇忽略,整个产品目录国际定向失效。去掉 `locale!=="en"`
  //      让 en 也发互惠簇(en 自指 + es/pt 存在则发 + x-default→en)。逻辑与其它语种同一套,零特例。
  const hreflang = urlOf && Array.isArray(enabled) && enabled.length
    ? enabled
        .filter((loc) => loc === "en" || urlOf(path, loc) !== path)
        .map((loc) => `\n<link rel="alternate" hreflang="${loc}" href="https://wanew.com${urlOf(path, loc)}" />`)
        .join("") + `\n<link rel="alternate" hreflang="x-default" href="${enUrl}" />`
    : "";
  /* ⭐ Product / BreadcrumbList JSON-LD —— **派生,不存储**(总工 2026-08-01 拍板)。
     判据来自实测,不是偏好:在线产品 68,其 jsonld image 指向【自己图册里那张】的只有 4 个
     (4208-4211,今晚人手写的),**机器写过的 64 份存储拷贝一份对的都没有**。
     样本 650 存 bb55cff3ea,图册里是 f6f88df527… —— 图册被重排/裁剪过,而拷贝留在原地。
     ⇒ "保存时重算再存"这条路这个仓里走过了,成绩 0/64。所以不是重算,是【根本不存】。

     它不是先例,是把例外收回来:本文件已有三处同款派生 —— metaTitleOf(注释原话
     "deliberately NOT read from data — DERIVED")、CANONICAL/HREFLANG 从路由算、
     以及下面 renderPage 里整块 FAQPage 也是现场派生的。

     ⚠️ 取值全部复用本文件已有的表达式,不另猜一套等价规则:
        品类名 = 上面 CATEGORY 用的那一支    图片 = resolveImg(与页面 <img> 同一支)
        产品 URL = canonical(已算好)         品类/首页 URL = urlOf(与 hreflang 同一支)
     ⚠️ name 保持 en:它是 SKU/型号,不随语言变(沿用被删那段注释里的原判断)。
     ⚠️ description 用【当前 locale】的 meta_description —— 这正是被删掉那段手术在做的事,
        现在它是构造对象时的一个赋值,不是事后在文本里找替换。
     ⚠️ brand 全站 68 个产品逐字相同({"@type":"Brand","name":"Wanew"}),且 locales.json 的
        fallback 把 "Wanew" 显式声明为 brand(不译)。它不是每个产品的数据,所以放在这里一处。
        (若日后要可配置,该进 data/site.json —— 那是新增数据字段,得先报。) */
  const BRAND = { "@type": "Brand", name: "Wanew" };
  const catName = (modelDisplay && modelDisplay[prod.category]) || catmap[prod.category] || prod.category;
  const catPath = `/${prod.category}/`;
  const homeLabel = (catalog && catalog["header.home"] && (catalog["header.home"][locale] ?? catalog["header.home"].en)) || "Home";
  const homeRel = urlOf ? urlOf("/", locale) : "/";
  const galleryImg = (prod.images || []).map((x) => resolveImg(x, imgBase)).filter(Boolean)[0] || "";
  const jsonldProduct = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: (prod.i18n && prod.i18n.en && prod.i18n.en.title) || e.title,
    description: e.meta_description || "",
    ...(galleryImg ? { image: galleryImg } : {}),
    category: catName,
    brand: BRAND,
  });
  /* 层级 = Home → 品类 → 产品自身。
     ⚠️ 既有 64 份把第 2 级叫「Mini」却把 item 指向【首页】—— 那描述的是一个不存在的站。
        派生不是内容决定,是让标记描述真实的站,所以这里指 /${category}/,并补上第 3 级。
     ⚠️ 三个 URL 都随 locale 走:一个葡语页的面包屑说"首页"是英文根,说的是另一个页面。 */
  const jsonldBreadcrumb = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      // 首页 URL 照 renderPage 的 HOME_URL 同一条规则:默认语种【不带尾斜杠】,有目录前缀的才带。
      // 不自己另定一套 —— 站里已经有这条约定了。
      { "@type": "ListItem", position: 1, name: homeLabel, item: `https://wanew.com${homeRel === "/" ? "" : homeRel}` },
      { "@type": "ListItem", position: 2, name: catName, item: `https://wanew.com${urlOf ? urlOf(catPath, locale) : catPath}` },
      { "@type": "ListItem", position: 3, name: (prod.i18n && prod.i18n.en && prod.i18n.en.title) || e.title, item: canonical },
    ],
  });
  const reps = {
    META_TITLE: metaTitleOf(e, prod, locale, modelDisplay, catalog), META_DESC: e.meta_description,
    ROBOTS_META: robots, CANONICAL: canonical, HREFLANG: hreflang,
    HTML_LANG: locale, OG_LOCALE: locale === "en" ? "" : `\n<meta property="og:locale" content="${locale.replace("-", "_")}" />`,
    GALLERY_MAIN: slides, GALLERY_THUMB: slides, CATEGORY: (modelDisplay && modelDisplay[prod.category]) || catmap[prod.category] || prod.category,
    TITLE: e.title,                       // 长标题:询盘表单要靠它认出是哪一个(68 个产品短名会撞)
    CARD_TITLE: e.card_title || e.title,  // h1 用短名,留空回落长标题
    COMPAT_BADGES: compatBadges(prod, locale, modelDisplay, catmap, catalog),
    SUMMARY_BLOCK: summary, DESCRIPTION: e.description_html, VIDEOS_BLOCK: videosBlock,
    RELATED: cards, JSONLD_BREADCRUMB: jsonldBreadcrumb, JSONLD_PRODUCT: jsonldProduct,
  };
  let r = template;
  for (const [k, v] of Object.entries(reps)) r = r.split(`{{${k}}}`).join(ESCAPED_KEYS.includes(k) ? esc(v) : v);
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
  // {{url./some/path/}} -> the locale's version of that path, falling back to the default when
  // that locale has no such page (urlOf's existence rule). renderHome/renderPage already had this;
  // render() did not, so the product template's compatibility link shipped the token verbatim into
  // the href — caught by checking the built page rather than trusting that the token "looked
  // supported". Without urlOf (a caller mid-migration) the raw path is emitted, which is still a
  // working link, never a leftover token.
  r = r.replace(/\{\{url\.(\/[a-z0-9/-]*)\}\}/gi, (m, p) => (urlOf ? urlOf(p, locale) : p));
  return r;
}

// entries: manifest rows {id,category,form,title,thumb}. Returns up to 4 related cards,
// same-category first, then same form-factor, then any — so no product is left empty.
// A manifest entry's title/excerpt are English; a locale's are under entry.i18n[locale].
// Same field-level fallback rule as the catalog — one rule, applied everywhere.
export const entryTitle = (e, locale) => (e.i18n && e.i18n[locale] && e.i18n[locale].title) || e.title;
// 卡面短名。跟语言走(产品标题本来分语言,单语短名会让 pt/es 卡面冒英文)。
// 留空 → 回落长标题,所以 Joe 没填的产品现状一字不变。
// ⚠️ 只用于【看得见的卡面标题】。alt 仍走长标题:alt 有 en 逐字节门看着(见 altOf 上方注释),
// 而且屏幕阅读器用户听到的应该是那句更具体的描述,不是短名。
export const entryCardTitle = (e, locale) =>
  (e.i18n && e.i18n[locale] && e.i18n[locale].card_title) || e.card_title || entryTitle(e, locale);
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

/* 产品详情页的站内链接。**三处调用共用它**:相关推荐 / 列表页卡片 / 首页产品条。
   ⚠️ 这三处此前各自写着 `/${e.category}/${e.id}` —— 三份拷贝就是三条会各自漂的规则,
      而它们漂开的表现是"其中一处还指着旧址":全站 200,没有任何东西会报错。
      (首页产品条和列表卡片本来就长得不像同一套组件,正是这种地方最容易只切一半。)
   🔴 缺 path 就抛,不回落到旧址:`/products/undefined` 会是一条【返回 200 的死链】,
      而"悄悄退回旧形态"会让第 5b 步删旧址那天才暴露 —— 那时已经没人记得这里有个回落。 */
const productHref = (e) => {
  if (!e || !e.path) throw new Error(`productHref: 产品 ${e && e.id} 没有规范 path —— 算不出新址`);
  return `/products/${e.path}`;
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
    const p = productHref(s);
    return { href: urlOf ? urlOf(p, locale) : p, img: s.thumb || "", alt: altOf(title, locale, catalog), title };
  });
}

// ---- List-page regen (/products/ + /{category}/): rebuild the card grid + chip counts ----
// form-factor bucket name -> data-form key. render.js is dual-runtime (Node regen.mjs + the CF
// Worker at functions/api/admin/[[path]].js) and must NOT touch fs, so the map is not read here —
// it is threaded in as `formKey` by each caller from the single source data/forms.json. `{}` is a
// defensive floor only: an unthreaded caller yields empty data-form / 0 chip counts (visibly wrong,
// caught by forms-integrity-check + the /type/ curl verify), never a crash on the live publish path.

/* 适配徽章。顶层 `compatible_with` 存【机型 slug】不存显示名 —— 存显示名的话 Joe 改一次机型名
   就要回写 68 个产品(双源);存 slug,徽章跟着显示名自动变。
   显示名优先级与页面别处一致:locales.json 的 model_display(品牌机型词,分语言) > categories.json 的 display。
   ⚠️ 空数组 / 无此字段 / slug 查不到显示名 → 该项不出,全空则整块不出。
   这正是 PDP 体检时我拒做徽章的那条理由的另一面:那时【没有】结构化适配数据,只有散文,
   做出来就得靠猜;现在有了字段,没填的产品照样什么都不显示 —— 不编。 */
export function compatBadges(prod, locale, modelDisplay, catmap, catalog) {
  const slugs = Array.isArray(prod && prod.compatible_with) ? prod.compatible_with : [];
  const names = slugs
    .map((s) => (modelDisplay && modelDisplay[s]) || (catmap && catmap[s]) || "")
    .filter(Boolean);
  if (!names.length) return "";
  const lbl = (catalog && catalog["pdp.compatible_with"] && (catalog["pdp.compatible_with"][locale] ?? catalog["pdp.compatible_with"].en)) || "Compatible with";
  return `<div class="pdp-compat"><span class="pdp-compat__lbl">${lbl}</span>`
    + names.map((n) => `<span class="pdp-compat__b">${n}</span>`).join("")
    + `</div>`;
}

export function cardHtml(e, locale = "en", catalog, urlOf, formKey = {}, sizes) {
  const title = entryTitle(e, locale);
  const alt = altOf(title, locale, catalog);          // alt 仍是长标题(en 逐字节门 + 无障碍)
  const cardTitle = entryCardTitle(e, locale);        // 卡面显示短名,缺省回落长标题
  const rel = productHref(e);
  const href = urlOf ? urlOf(rel, locale) : rel;
  /* 卡面只有【主图 + 标题】(Joe 2026-07-28)。
     摘要原来是 `<p class="blog-one__tt">${entryExcerpt(e, locale)}</p>`,内容是从 Amazon 商品
     描述头部截出来的一段 —— 关键词堆,而且**每一条都断在半个词上**。
     > **一段断在半个词处的营销文案,唯一传达的信息是"这里有一段我们没处理完的文字"。**
     去掉它,列表页才像一份目录:卡片的工作是让人认出这是什么并点进去,不是在列表页塞完参数。

     ⚠️ `entryExcerpt` 与 manifest 里的 `excerpt` 字段【都保留】 —— 只停止在卡上渲染。
        字段还被 i18n 派生链用着(regen.mjs:231 按语种重算),删字段是另一件事,不在这条里做。
        于是 `entryExcerpt` 暂时没有调用方:**这是有意的,不是漏删。** */
  return `\n              <div class="col-xl-3 col-lg-4 col-md-6 wow fadeInUp" data-wow-delay="200ms" data-cat="${e.category}" data-form="${formKey[e.form] || ""}">\n                <div class="blog-one__single">\n                  <a href="${href}">\n                    <div class="blog-one__img">\n                      <img src="${e.thumb}"${dimAttr(e.thumb, sizes)} alt="${alt}" loading="lazy">\n                    </div>\n                    <div class="blog-content">\n                      <h3 class="blog-one__title">${cardTitle}</h3>\n                    </div>\n                  </a>\n                </div>\n              </div>`;
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
export function renderHome(tpl, { locale, catalog, tiles, modelDisplay, urlOf, exists, dirOf, enabled, products, featured, formOrder, internal_noindex = [], sizes }) {
  const sfx = catalog["card.alt.category"];
  const suffix = sfx[locale] ?? sfx.en;
  const cards = tiles
    .filter((t) => exists(`/${t.cat}/`, locale))
    .map((t) => {
      const name = modelDisplay[t.cat];
      return `<div class="product-grid-item">\n            <a href="${urlOf(`/${t.cat}/`, locale)}" class="product-grid-link">\n` +
        `              <div class="product-grid-img">\n                <img src="${t.img}"${dimAttr(t.img, sizes)} alt="${name} ${suffix}" loading="lazy">\n` +
        `              </div>\n              <div class="product-grid-text"><b>${name}</b></div>\n            </a>\n          </div>`;
    })
    .join("\n          \n          ");
  let out = tpl.split("{{TILES}}").join(cards);
  // W3 首页产品图模块(机型瓦片之上):真实产品照走同一存在性/本地化规则 —— 从 manifest 挑
  // 按【形态多样性】轮询的一组(至多 8 件,每件带真实缩略图+本地化标题+详情链接),不写死 id,
  // 产品增删自动跟随。en 侧不发前缀,pt/es 侧存在则前缀(urlOf 复用),alt 派生(entryTitle+altOf)。
  if (out.includes("{{PRODUCT_STRIP}}")) {
    const strip = pickHomeProducts(products || [], 8, featured, formOrder).map((e) => {
      const title = entryTitle(e, locale);
      const href = urlOf(productHref(e), locale);   // 首页产品条:和列表卡片不是同一套组件,但必须同一条规则
      return `<a class="w3-pstrip__card" href="${href}">\n` +
        `            <div class="w3-pstrip__img"><img src="${e.thumb}"${dimAttr(e.thumb, sizes)} alt="${altOf(title, locale, catalog)}" loading="lazy"></div>\n` +
        `            <div class="w3-pstrip__title">${title}</div>\n          </a>`;
    }).join("\n          ");
    out = out.split("{{PRODUCT_STRIP}}").join(strip);
  }
  // W3 "browse by type" 卡片:专属 /type/X/ 页目前只有 en。对没有本地化 /type/ 页的语种,
  // 原来是「链英文 /type/ + 挂 en inglés 标注」—— 对母语用户像"站没做完"。但同一批产品在
  // 本地化 /products/ 页的「Tipo」筛选里【存在】(w3.js 的 hash 深链会激活对应 chip)。
  // 规则(存在性派生,零特例,和机型卡/badge 同一条):typecard 目标 = 该语种【有】本地化
  //   /type/X/ 就用它;【没有】则回落到本地化 /products/#X(而不是英文页+标注)。
  //   en 天然有 /type/X/ → 永远走 /type/(它们是 en 自己的收录落地页、且是首页给它们的唯一
  //   内链,绝不能改成 /products/ 把它们变孤儿);es/pt 无 /type/ 但有 /products/ → 走筛选视图。
  //   /type/ 将来若本地化,`dedicated!==` 自动改回本地化 /type/ 页,无需再动这里。
  const typeRedirect = {};
  out = out.replace(/\{\{url\.\/type\/([a-z-]+)\/\}\}/g, (m, slug) => {
    const dedicated = urlOf(`/type/${slug}/`, locale);        // 本地化 /type/ 存在则返回它,否则原样
    if (dedicated !== `/type/${slug}/`) return dedicated;     // 该语种有专属页 → 用它
    // urlOf 不处理 hash(查 `es/products/#x.html` 必不存在),所以对 /products/ 本身查存在性再拼 #slug。
    const base = urlOf(`/products/`, locale);                 // "/es/products/" | "/pt/products/" | "/products/"
    if (base !== `/products/`) { typeRedirect[slug] = true; return `${base}#${slug}`; }
    return dedicated;                                         // en / 无本地化替代 → 英文 /type/
  });
  // 改走本地化 products 视图的卡不再需要语言标注;其余(en)交给通用 badge 处理(它对 en 返回空)。
  out = out.replace(/\{\{badge\.\/type\/([a-z-]+)\/\}\}/g, (m, slug) => (typeRedirect[slug] ? "" : m));
  return renderPage(out, { locale, catalog, urlOf, dirOf, enabled, internal_noindex });
}

// Home product strip = a CURATED shortlist (总工: 6–8 hand-picked heroes with good photos, never a
// catalog dump). If data/pages/home-featured.json supplies ids, use exactly those in order (that is
// the curation, made against real photo quality). Only when no curated list is wired does it fall
// back to the diversity round-robin below. `featured` is the id array (or null) passed by the caller.
/* ⚠️ **下面的轮转分桶当前走不到,而它仍然值得钉死。**
   首页 strip 由 home-featured.json 的【显式 ids】驱动 —— 实测四语种的 strip 与那 8 个 id
   逐位相同,所以 featured 那个分支永远命中,轮转是 fallback。
   > **"死"是当前状态,不是性质。** home-featured 哪天空了或 id 全失效,它立刻变活,
   > 而那时不会有人记得它按字母序排。**改的是 fallback 的正确性,不是首页的展示逻辑。**
   🔴 原来是 `[...byForm.keys()].sort()` = 字母序,而 data/forms.json 的【数组顺序】
      才是这个站的形态次序(regen.mjs 里「order = /type page + chip order」,后台那列「顺序」也是它)。
      两者当前**恰好同序**,只因为每个 key 恰好是 name 首词的小写:
        cables < cases < mounts < networking < power
      来一个 "Antenna Mounts" / key "mounts",两个序当场分家。
      > **一个"恰好相等"的性质,和一个"必然相等"的性质,今天长得一样,明天不一样。**
   ⚠️ formOrder 里 key 与 name **都**登记进 rank,所以 C 步把 e.form 归一化成 key 之后
      这段不需要跟着改 —— 分桶键是显示名还是 key,排序结果都一样。
      不传 formOrder 时退回字母序,与改动前逐字一致(向后兼容,调用方漏传不会炸)。 */
export function pickHomeProducts(entries, cap = 8, featured = null, formOrder) {
  /* 🔴 **formOrder 是必需输入,漏传即抛。** 这条是契约,不是这个函数的偏好:
     vendored 模块新增输入时,「不传就退回旧行为」读起来像贴心,实际是
     **「你可以忘记传我,而我不会告诉你」** —— 而 Admin 是 renderHome 的另一个调用方,
     它第一次就没传(靠字节守卫 re-vendor 才发现)。那和 manifest 丢 path 不只是同一形状,
     **是同一个机制:一个可以缺席而不出声的输入。**
     改成必需之后:官网加参数 → Admin re-vendor → **调用点当场炸** → 必须跟上。
     > **漂移变成一次崩溃,而不是一个需要被发现的差异。**
     ⚠️ 显式传 `null` 是合法的 —— 它的意思是"我确实不需要按清单排序,用字母序"。
     **"我明确说不需要"和"我忘了"必须长得不一样**,所以只有 undefined 抛。 */
  if (formOrder === undefined) {
    throw new Error("pickHomeProducts: 缺 formOrder。传 data/forms.json 的 forms 数组以按站点形态次序排;" +
      "确实不需要排序就显式传 null —— 漏传不等于不需要。");
  }
  if (Array.isArray(featured) && featured.length) {
    const byId = new Map(entries.filter((e) => e.thumb).map((e) => [e.id, e]));
    const picked = featured.map((id) => byId.get(Number(id))).filter(Boolean);
    if (picked.length) return picked.slice(0, cap);
  }
  const byForm = new Map();
  for (const e of entries) {
    if (!e.thumb) continue;
    const k = e.form || "";
    if (!byForm.has(k)) byForm.set(k, []);
    byForm.get(k).push(e);
  }
  for (const list of byForm.values()) list.sort((a, b) => a.id - b.id);
  const rank = new Map();
  (Array.isArray(formOrder) ? formOrder : []).forEach((f, i) => {
    if (f && typeof f === "object") { if (f.key) rank.set(f.key, i); if (f.name) rank.set(f.name, i); }
    else if (f) rank.set(f, i);
  });
  const forms = [...byForm.keys()].sort((a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    // 清单里没登记的排最后,彼此之间仍按字母序 —— 保证顺序是全序,不依赖 sort 的稳定性
    return ra !== rb ? ra - rb : String(a).localeCompare(String(b));
  });
  const out = [];
  for (let round = 0; out.length < cap; round++) {
    let progressed = false;
    for (const f of forms) {
      const list = byForm.get(f);
      if (round < list.length) { out.push(list[round]); progressed = true; if (out.length >= cap) break; }
    }
    if (!progressed) break;
  }
  return out;
}

// R3 的通用页渲染:模板 + 散文目录 -> 页面。首页只是它多一个 {{TILES}} 的特例。
// (a) 是为首页定制的;(b) 有 11 个页、(c)(d)(e) 还有 71 个 —— 同一套机器,参数化一次用四桶。
export function renderPage(tpl, { locale, catalog, urlOf, path = "/", dirOf, enabled, internal_noindex = [], config = {} }) {
  let out = tpl;
  // internal locale(如 zh):no-SEO —— 强制 noindex 且【零 hreflang】。zh 不在 enabled 里,所以
  // en/pt/es 的 hreflang 簇本就不会指向它(一个方向);这里堵另一个方向:zh 页自己不发 hreflang
  // (否则会挂出指向 en/pt/es 的 alternate 却漏自指,是坏簇)。用 {{HREFLANG}} 那个 <head> 槽位
  // 承载 robots meta —— 不新增注入点,en/pt/es 分支逐字不变(zero-diff)。
  const isInternal = Array.isArray(internal_noindex) && internal_noindex.includes(locale);
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
    HREFLANG: isInternal
      // zh: 内部页,不收录、零 hreflang。
      // ⚠️ 幂等:模板里若已自带 robots(page-video.html 就有一条 —— 那是 en/es/pt 的 video 页
      //    noindex 的【唯一】来源,不能删),这里再发一条就成了重复标签。实测 zh/video 曾有 2 条。
      //    重复的 noindex 不改变行为,但**它是"两个机制管同一件事"的可见症状** —— 下一次
      //    只要有人改其中一个,两条就会互相矛盾,而那时才发现有两条。
      ? (/<meta\s+name="robots"/i.test(tpl) ? "" : `<meta name="robots" content="noindex, follow" />`)
      : `<!-- hreflang alternates (derived from locales.json + page existence) -->\n` +
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
  // {{cfg.KEY}} = language-agnostic standalone config (data/contact-info.json), resolved
  // OUTSIDE the i18n catalog so real values (email/phone/…) never trip catalog-dupe.
  // Missing key throws (same discipline as {{t.}}). Pages without cfg tokens pass config={}.
  out = out.replace(/\{\{cfg\.([a-z0-9_]+)\}\}/g, (m, key) => {
    const v = config[key];
    if (v === undefined || v === null || v === "") throw new Error(`renderPage: config 缺 cfg.${key}(data/contact-info.json)`);
    return v;
  });
  // L3(审计):FAQPage 结构化数据 —— 从【已渲染】的 .faq-item Q&A 派生(token 已解析),
  // JSON.stringify 负责转义(catalog 文本里的引号/换行不会破坏 JSON-LD)。任何含 faq-item 的
  // 页自动获得,没有就跳过。答案去 HTML 标签取纯文本(schema.org acceptedAnswer.text)。
  if (out.includes('class="faq-item"')) {
    const qs = [...out.matchAll(/<div class="faq-question"[^>]*>\s*<span>([\s\S]*?)<\/span>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    const as = [...out.matchAll(/<div class="faq-answer">([\s\S]*?)<\/div>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const n = Math.min(qs.length, as.length);
    const mainEntity = [];
    for (let i = 0; i < n; i++) if (qs[i] && as[i]) mainEntity.push({ "@type": "Question", name: qs[i], acceptedAnswer: { "@type": "Answer", text: as[i] } });
    if (mainEntity.length) {
      const schema = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity };
      out = out.replace("</head>", `<script type="application/ld+json">${JSON.stringify(schema)}</script>\n</head>`);
    }
  }
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
export function setListLabels(html, { locale, catalog, model, formKey }) {
  const t = (key) => {
    const e = catalog[key];
    if (!e) throw new Error(`setListLabels: catalog 缺 key ${key}`);
    const v = e[locale] ?? e.en;
    if (v === undefined || v === null || v === "") throw new Error(`setListLabels: ${key} 在 ${locale} 下没有值`);
    return v;
  };
  let out = html;
  // ⑬:banner 副标题接回 catalog。此前它【只存在于已构建的 HTML 里】—— 43 个列表页显示着这句话,
  // 而模板、regenListPage、本函数都不写它,catalog 里那个 body.banner.subtitle 键没有任何消费者。
  // 后果不是显示错(各语种烘进去的值都是对的),而是**这行字冻住了**:改 catalog 不生效,
  // 又找不到别处可改 —— i18n-check 文件头称之为"一根没接线的杆"。这里把线接上。
  // ⚠️ 只在【列表页】生效(本函数只被列表页管线调用);solutions/guides/about 的同名类由
  //    renderPage 各自的 catalog 驱动,不受影响。
  out = out.replace(/(<p class="page-header__subtitle">)[^<]*(<\/p>)/,
    (m, a, b) => a + t("body.banner.subtitle") + b);
  if (model) {
    const h1 = t("list.banner.model").replace("{model}", model);
    out = out.replace(/(<h1 class="page-header__title">)[^<]*(<\/h1>)/, `$1${h1}$2`);
  } else if (formKey) {
    // 形态页(/type/X)。**与机型页是两个模式,不是一个键两种填法**:
    //   机型页「Starlink {model} Accessories」· 形态页「Starlink {形态}」——【没有】Accessories。
    // 复用 list.banner.model 会凭空给形态页加上 Accessories,改变现有 en 文案,所以是两个键。
    // {form} 取 header.* 的现成类目译文(与 nav、首页类目卡、筛选 chip 同一套键)——
    // **不新造类目名**,全站类目口径仍然单一。
    // 修的是:此前只有 <title> 走了 catalog、H1 没走,于是 es/pt/zh 的形态页顶着英文 H1
    // (2026-07-28 实测:四语的 /type/cables/ 全是 "Starlink Cables")。
    const h1 = t("list.banner.form").replace("{form}", t(formKey));
    out = out.replace(/(<h1 class="page-header__title">)[^<]*(<\/h1>)/, `$1${h1}$2`);
  }
  // 筛选栏两个标签:第一个是机型轴、第二个是形态轴 —— 顺序由页面结构固定,不是我猜的。
  let n = 0;
  out = out.replace(/(<span class="product-chiprow__label">)[^<]*(<\/span>)/g,
    (m, a, b) => a + t(n++ === 0 ? "list.filter.model" : "list.filter.type") + b);
  // 形态轴类目名(Mounts&Brackets…)+ 两轴的 "All" 一起本地化,全走 catalog 且与 nav/首页类目卡
  // 【同一套 chrome 键】—— 保证全站 es/pt/zh 类目名单一口径。此前 setListLabels 假设"形态 chip 在
  // chrome 里已经有主了"、根本不碰它们 —— 但 chip 标签是【就地烘进 list 页 body 的】,该假设不成立:
  // /es/products/ 的 Tipo chip 全留了英文(审计 M-a),/zh/ 同样留英文;pt 恰好持久化对了、掩盖了根。
  // 机型 chip(Mini/Standard…)是 model_display 型号名,不在下表 → 不翻。
  // chip 有两种载体:<button>(就地筛选,data-filter) 与 <a>(机型导航跳转,href,无 data-filter)。
  const ALL = t("list.chip.all");
  const FORM_LABEL_KEY = {
    // ⚠️ mounts 指 header.mounts(不是 header.mounts_brackets):Joe 把品类显示名改成了 "Mounts",
    //    而这张表决定 chip 上印哪个词。**这是权宜之计** —— 键仍然是从英文名派生的,下一次改名
    //    还得再来一遍。根治在"模板直接读 forms.json 的 name"那一刀。
    mounts: "header.mounts", power: "header.power_charging", cables: "header.cables",
    networking: "header.networking", cases: "header.cases_protection",
  };
  // (1) <button> 筛选 chip:两轴 All → 本地化;形态类目 → 本地化;机型名(不在表)原样。
  out = out.replace(
    /(<button\b[^>]*\bdata-filter="([a-z-]+)"[^>]*>)([^<]*?)( <span class="product-chip__n">)/g,
    (m, open, filter, label, tail) => {
      if (filter === "all") return open + ALL + tail;
      const key = FORM_LABEL_KEY[filter];
      return key ? open + t(key) + tail : m;
    });
  // (2) 机型导航行里的 <a> "All" 锚(href 指向全集):只认 "All"/已本地化值,型号名锚不动。
  out = out.replace(/(<a class="product-chip[^"]*" href="[^"]*"(?: data-filter="all")?>)([^<]*?)( <span class="product-chip__n">)/g,
    (m, a, label, b) => (label === "All" || label === ALL ? a + ALL + b : m));

  return out;
}

/* 机型导航 <a> 的 href → 新址。**放在 regenListPage 里**,因为它需要 `entries` 才知道
   哪些 slug 是真机型 —— 我第一版写进了 setListLabels,那里没有 entries,regen 当场
   `ReferenceError` 停在第 1 步。⚠️ 那次失败留下的是中间态产出:**别拿它验收、别提交。**

   这一行是【导航】,不是筛选:`<button>` 那一种就地筛选、根本没有 href。
   > **"chip"不是单一形态,规则要分开写** —— 和 blog-one__single 那次同一条:
   > **类名不是语义**,它可以横跨两种东西。

   🔴 合法 slug 取自 entries 的 category 集合,不另立清单 —— 另立就是第二份会漂的真源。
      (聚合页 performance-gen-2 自己没有产品,不在集合里,页面上也确实没有它的 chip。)
   🔴 幂等 + 时间维度:模式【同时接受】旧形态 `/{slug}/` 与新形态 `/products/{slug}/`,
      一律产出新形态。**没有"先试新的、失败再试旧的"这种分支** ——
      收尾那一刀之后旧形态不再出现,若靠失败回退实现,那条回退路径从此再没被验证过。 */
export function switchChipHrefs(html, entries) {
  const slugs = new Set((entries || []).map((e) => e.category).filter(Boolean));
  if (!slugs.size) throw new Error("switchChipHrefs: entries 里一个 category 都没有 —— 空集合会让替换静默为 0");
  return html.replace(/(<a class="product-chip[^"]*" href=")([^"]*)(")/g, (m, a, href, b) => {
    const mm = /^(\/(?:es|pt|zh))?\/(?:products\/)?([a-z0-9-]+)\/$/.exec(href);
    if (!mm || !slugs.has(mm[2])) return m;            // All 锚(/products/)与任何非机型链接原样
    return `${a}${mm[1] || ""}/products/${mm[2]}/${b}`;
  });
}

/* 列表页的标题。**三处同一个值**:`<title>` 是给搜索结果看的,`og:title` / `twitter:title`
   是给社媒卡片、聊天软件预览、以及 AI 抓取看的那一份。

   🔴 此前只写 `<title>`,另外两处从【页面被建出来那一刻】起就没人碰过。后果不是"少改一处":
      24 个列表页里 18 个 og:title ≠ title,**而且西语页和葡语页对外露出的是整个英文**:
          es/type/power/       <title> Energía y carga…    og:title Power &amp; Charging…
          es/type/networking/  <title> Redes…              og:title Networking…
      拉美和巴西是主力市场,分享到 WhatsApp、贴进聊天、被 AI 抓 —— 拿到的都是英文标题。
   > **对外露出的那一份和站内看到的不是一个语言,比两边都旧更糟:那不是没更新,是自相矛盾。**

   ⚠️ 刻意放在这个函数里,不另写一处:标题只有一个来源,三个出口。**另写一处 = 两条会各自漂的规则**,
      而它们漂开的表现恰恰是最难发现的那种 —— 站内一切正常,只有分享出去的卡片是错的。
   ⚠️ 不碰 JSON-LD 面包屑:它要的是【裸品类名】而不是完整标题,是另一个值;而且那个块的
      `"item"` 还错着(指向站根而非本页)。半修一个结构化数据块比不修更难查 —— 单独一刀。 */
export function setListTitle(html, name, locale, catalog) {
  const t = listTitleOf(name, locale, catalog);
  if (!t) return html;
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);
  out = out.replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/, `$1${t}$2`);
  out = out.replace(/(<meta\s+name="twitter:title"\s+content=")[^"]*(")/, `$1${t}$2`);
  return out;
}

// Rebuild #productGrid cards + the model/form chip counts. catFilter=null for /products/,
// or a category slug for /{category}/. Returns updated html (unchanged if no #productGrid).
// catFilter accepts a category slug (as before), null for /products/, an ARRAY of slugs (the
// Gen 2 page aggregates the Performance family — it has 0 products of its own and must not be a
// dead click), or {form} for the /type/ pages. One predicate covers all four so no caller needs a
// special case, and adding a fifth kind of list page later costs nothing.
/* ⚠️ selfUrl 是【可选】参数:官网侧显式传本页 URL(见 regen.mjs 的说明 —— 这一页可能是从新址
   文件读、往旧址写,那一刻 html 里的 canonical 不是本页的最终身份)。admin 的三处调用不传,
   回落成"读 html 里的 canonical",行为与本次改动前一致 ⇒ 镜像不破。
   🔴 但"镜像不破"只证明文件对得上,证明不了行为对 —— 回落那条链的产出必须单独验(已验,见交付报告)。 */
export function regenListPage(html, entries, catFilter, { locale = "en", catalog, urlOf, formKey = {}, sizes, selfUrl } = {}) {
  const inScope = (e) => {
    if (!catFilter) return true;
    if (Array.isArray(catFilter)) return catFilter.includes(e.category);
    if (typeof catFilter === "object") {
      // 🔴 两边都归一化,但【必须带兜底】。写成 `formKey[e.form] === formKey[catFilter.form]`
      //    在 formKey 为 {} 时是 `undefined === undefined` —— 恒真式,每个产品进每一页。
      //    而 /type/ 页本来就该有几十张卡,**这个失败肉眼看不出来**。
      return catFilter.form
        ? (formKey[e.form] || e.form) === (formKey[catFilter.form] || catFilter.form)
        : true;
    }
    return e.category === catFilter;
  };
  const scope = entries.filter(inScope)
    .sort((a, b) => a.category.localeCompare(b.category) || a.id - b.id);
  // NB: must be an arrow, not `scope.map(cardHtml)` — map passes (el, index, array), so the bare
  // reference would feed the INDEX in as `locale`. It would even look fine in en (an unknown
  // locale falls back to English), which is the worst kind of wrong: right by accident.
  const cards = scope.map((e) => cardHtml(e, locale, catalog, urlOf, formKey, sizes)).join("") + "\n            ";
  html = html.replace(
    /(<div class="row" id="productGrid"[^>]*>)(?:\s*<div class="col-xl-3[^"]*"[^>]*data-cat="[^"]*"[^>]*>[\s\S]*?<\/a>\s*<\/div>\s*<\/div>)*\s*(<\/div>)/,
    (m, open, close) => open + cards + close
  );
  // Both chip rows count WITHIN scope — a chip's number has to describe the grid under it, or it
  // lies. Provably a no-op today: on /products/ scope IS entries (catFilter null), and that is the
  // only page carrying modelChips. It's what makes the /type/ pages, whose scope is one form,
  // count 33 cables per model instead of reporting all 64 products over a 33-card grid.
  const countModel = (f) => (f === "all" ? scope.length : scope.filter((e) => e.category === f).length);
  const countForm = (f) => (f === "all" ? scope.length : scope.filter((e) => formKey[e.form] === f).length);
  /* ⭐ 面包屑 —— 派生,不再用烘在页面里的那一份(总工 2026-08-01)。
     实测六条:只有 /pt/products/ 是对的,其余五条三个毛病叠着 ——
       ① 第 2 级 item 指【首页】(和产品页刚修掉的一模一样) ② es 页整页挂英文名 ③ 标签没本地化。
     🔴 但"对的写法已经在代码里、只是别的路径没走它"这个推断【不成立】:
        列表页面包屑根本【没有生产者】—— 它烘死在产出 HTML 里,/pt/products/ 只是当年那份恰好烘对。
        ⇒ 所以不是"让其余路径汇过去",是【第一次给它一个生产者】。

     ⚠️ 两个取值都不新造:
        本页 URL = 页面自己的 <link rel="canonical">。页面已经声明过自己是谁 ⇒ 不必给
                   regenListPage 加参数、也不动 vendor 签名(admin 那三处调用照旧)。
        首页 URL = 照 renderPage 的 HOME_URL 同一条规则:默认语种不带尾斜杠。
     ⚠️ 第 2 级的【名字】:catalog 里有 header.<slug> 就用它(products→Produtos/Productos、
        mounts→Suportes/Soportes);没有就保留页面原有那个名字 ——
        机型名(Mini / Standard / Enterprise)是 Starlink 的型号,全站刻意不译,
        pt/es 页自己的 h1 也写着 "Acessórios para Starlink Enterprise"。**把 Enterprise 译掉才是错的。**
     ⚠️ 找那一块要【按解析结果判 @type】,不靠正则猜 JSON 的边界:
        我第一版用 …"BreadcrumbList"[\s\S]*?\} ,惰性的 \} 停在第一个【内层】右括号上,
        截出的片段 parse 失败、老名字丢了,第 2 级掉成小写 slug。**又是"猜一套等价规则"。** */
  const canonBc = selfUrl || (/<link rel="canonical" href="([^"]+)"/.exec(html) || [])[1];
  let bcRaw = null, bcOld = null;
  for (const b of String(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(b[1].trim()); } catch { continue; }
    if (j && j["@type"] === "BreadcrumbList") { bcRaw = b[0]; bcOld = j; break; }
  }
  if (canonBc && bcRaw) {
    const pickBc = (key, fb) => {
      const v = catalog && catalog[key];
      return (v && (v[locale] ?? v.en)) || fb;
    };
    const homeRel = urlOf ? urlOf("/", locale) : "/";
    const slug = String(canonBc).replace(/\/+$/, "").split("/").pop() || "";
    const list = (bcOld && bcOld.itemListElement) || [];
    const oldLast = list.length ? list[list.length - 1].name : slug;
    const derivedBc = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: pickBc("header.home", "Home"), item: `https://wanew.com${homeRel === "/" ? "" : homeRel}` },
        { "@type": "ListItem", position: 2, name: pickBc(`header.${slug}`, oldLast), item: canonBc },
      ],
    });
    html = html.split(bcRaw).join(`<script type="application/ld+json">${derivedBc}</script>`);
  }
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
