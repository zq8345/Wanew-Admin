// #52 批2-2：发布核心 —— 继承 functions/api/admin/[[path]].js 的骨架，补齐 6 个缺口：
//   ①render 现代签名（catalog/urlOf/modelDisplay/catmap/enabled——旧调用是单语化石，会产出缺
//     hreflang/切换器的页）②⭐applyChrome 双步（render 出的是模板 chrome 态，直接 commit=把页面
//     打回原始态上生产——zero-diff 护栏抓的就是它）③三语：es/pt 详情/列表**已存在才**重渲染
//     （regen 规则：渲染内容，不决定 site map——新品只建 en）④类目从 data/categories.json（批1a
//     真源，不再硬编码）⑤⭐编辑 merge 模式：保留旧 json 的非 en locale 翻译（旧 validate 白名单
//     只留 en，编辑保存=擦掉 es/pt 翻译——静默数据丢失雷）⑥regenListPage 带 opts（旧调用缺
//     locale/urlOf → 列表卡片 URL 不本地化）。
// 单真源铁律：render/chrome/github 全部跨目录 import，零复制。
// @ts-ignore js 模块
import { render, genRelated, resolveImg, regenListPage, excerptOf, catmapOf, renderHome, renderPage } from "../vendor/render.js";
// @ts-ignore js 模块
import { makeChrome } from "../vendor/chrome.js";
// @ts-ignore js 模块
import { ghConfig, commitFiles, readFile } from "../vendor/github.js";
// ⭐ locale→目录规则直接 import 真源（纯 ESM 零 Node 依赖）。第一版我凭注释复刻、漏了 locales.dir
//   覆盖字段——读真源当场抓包（批㉔ 列名教训：复刻必对真源；能 import 就绝不复刻）。
// @ts-ignore js 模块
import { localeDirs } from "../vendor/locale-dirs.mjs";
import type { Env } from "./index";

export interface Ctx {
  template: string; site: any; locales: any; catalog: any; categories: any;
  manifest: any[]; manifestRaw: string | null; partial: string; pagesList: Set<string>;
  locDir: Record<string, string>; catmap: Record<string, string>;
  chrome: { applyChrome: (html: string, path: string) => { html: string; errors: string[] } ; localizeUrl: (p: string, loc: string) => string };
}

export async function loadCtx(env: Env, cfg: any): Promise<Ctx | null> {
  const [template, siteRaw, locRaw, catRaw, categoriesRaw, manRaw, partial, pagesRaw] = await Promise.all([
    readFile(env, cfg, "data/templates/product.html"),
    readFile(env, cfg, "data/site.json"),
    readFile(env, cfg, "data/locales.json"),
    readFile(env, cfg, "data/chrome.json"),
    readFile(env, cfg, "data/categories.json"),
    readFile(env, cfg, "data/products-index.json"),
    readFile(env, cfg, "data/templates/_chrome.html"),
    readFile(env, cfg, "data/pages-list.json"),
  ]);
  // 精确报缺哪个（㉔ 批错误透传教训：别让"果"盖住"因"）。categories/pages-list 随本链发布——
  // 链未 push 前 GitHub 上没有它们，preview 会在此如实报缺（依赖顺序，非缺陷）。
  const missing = [
    !template && "data/templates/product.html", !siteRaw && "data/site.json", !locRaw && "data/locales.json",
    !catRaw && "data/chrome.json", !categoriesRaw && "data/categories.json", !partial && "data/templates/_chrome.html",
    !pagesRaw && "data/pages-list.json",
  ].filter(Boolean);
  if (missing.length) { (globalThis as any).__ctxMissing = missing; return null; }
  const site = JSON.parse(siteRaw), locales = JSON.parse(locRaw), catalog = JSON.parse(catRaw);
  const categories = JSON.parse(categoriesRaw);
  const manifest = manRaw ? JSON.parse(manRaw) : [];
  const pagesList = new Set<string>(JSON.parse(pagesRaw));
  const locDir = localeDirs(locales);
  const chrome = makeChrome({
    catalog, locales, partial, manifest,
    pageExists: (rel: string) => pagesList.has(rel),
    locDir,
  });
  return { template, site, locales, catalog, categories, manifest, manifestRaw: manRaw ?? null, partial, pagesList, locDir, catmap: catmapOf(categories), chrome };
}

// 校验 + 白名单 + ⭐merge：编辑时以旧 json 为底，en 从表单、其它 locale 原样保留（防翻译擦除）。
export function validateProduct(body: any, id: number, categories: any, existing: any | null): { prod?: any; error?: string } {
  const CATEGORIES: string[] = (categories?.categories || []).map((c: any) => c.slug);
  const FORMS = ["Cables", "Mounts & Brackets", "Power & Charging", "Networking", "Cases & Protection"];
  if (!body || typeof body !== "object") return { error: "body must be an object" };
  if (!CATEGORIES.includes(body.category)) return { error: "invalid category" };
  const form = body.form ? String(body.form) : null;
  if (form !== null && !FORMS.includes(form)) return { error: "invalid form" };
  const en = body.i18n && body.i18n.en;
  if (!en || typeof en.title !== "string" || !en.title.trim()) return { error: "title required" };
  if (typeof en.description_html !== "string") return { error: "description_html required" };
  if (!Array.isArray(body.images)) return { error: "images must be an array" };
  for (const im of body.images) {
    if (!im || (typeof im.key !== "string" && typeof im.src !== "string")) return { error: "each image needs key or src" };
  }
  const i18n: any = { ...(existing?.i18n || {}) };   // ⭐ 旧翻译打底（es/pt 等原样保留）
  i18n.en = {
    title: en.title, summary_html: en.summary_html || "", description_html: en.description_html,
    // meta_title 是派生字段（render.js:20 "deliberately NOT read from data — DERIVED"）——
    // 只在用户显式自定义(≠title)时落盘；否则不存（🟡终审 diff 抓出旧白名单把派生值显式化 +166B）
    ...(en.meta_title && en.meta_title !== en.title ? { meta_title: en.meta_title } : {}),
    meta_description: en.meta_description || "",
  };
  const prod = {
    id, category: body.category, form, robots: body.robots ?? (existing?.robots ?? null),
    i18n,
    images: body.images.map((im: any) => (im.key !== undefined ? { key: im.key, alt: im.alt || "" } : { src: im.src, alt: im.alt || "" })),
    jsonld_product: body.jsonld_product ?? (existing?.jsonld_product ?? null),
    jsonld_breadcrumb: body.jsonld_breadcrumb ?? (existing?.jsonld_breadcrumb ?? null),
  };
  return { prod };
}

// 行尾保留（chrome-sync 同款策略）：编辑已有文件时保留其原行尾——否则 Joe 首次保存
// git diff 整页变更（吓人+污染 blame）。新文件=LF。
function matchEol(existingRaw: string | null | undefined, html: string): string {
  return existingRaw && existingRaw.includes("\r\n") ? html.replace(/\n/g, "\r\n") : html;
}

// json 落盘对齐仓库原文件（🟡终审 +108B 定性收口）：行尾+尾换行都跟随原文件——仓库 json 现状
// 本就不齐（products/*=CRLF+尾NL、products-index=LF+无尾NL），只有"跟随"能让未改数据的保存
// 字节归零，不污染 diff/blame。新文件=LF+尾NL。
function matchJson(existingRaw: string | null | undefined, obj: any): string {
  const tail = existingRaw ? (/\n$/.test(existingRaw) ? "\n" : "") : "\n";
  return matchEol(existingRaw, JSON.stringify(obj, null, 2) + tail);
}

// 发布：manifest upsert + 每个 enabled locale 的详情页（存在性规则）双步渲染 + 受影响列表页 regen
// → 一个原子 commit（= 一次 Pages 部署）。
export async function publishProduct(env: Env, cfg: any, ctx: Ctx, prod: any, opts: { isNew: boolean; oldCategory?: string; email: string; dryRun?: boolean }) {
  const { template, site, locales, catalog, manifest: man0, locDir, catmap, chrome } = ctx;
  const thumb = prod.images[0] ? resolveImg(prod.images[0], site.img_base) : "";
  const entry: any = { id: prod.id, category: prod.category, form: prod.form, title: prod.i18n.en.title, thumb, excerpt: excerptOf(prod) };
  // ⭐ manifest entry 的 i18n（pt/es 卡片标题/摘要）——抄 regen.mjs:47-53 同源逻辑。
  //   漏它的代价（字节对照抓出的真雷）：每次保存，该品在 pt/es 列表卡片退化英文（Δ59/44B 实测）。
  for (const loc of locales.enabled) {
    if (loc === locales.default) continue;
    const t = prod.i18n[loc] && prod.i18n[loc].title;
    const x = excerptOf(prod, loc);
    if (t || x !== entry.excerpt) (entry.i18n ??= {})[loc] = { ...(t ? { title: t } : {}), ...(x ? { excerpt: x } : {}) };
  }
  const manifest = man0.filter((e: any) => e.id !== prod.id).concat(entry)
    .sort((a: any, b: any) => a.category.localeCompare(b.category) || a.id - b.id);
  const urlOf = (p: string, loc: string) => chrome.localizeUrl(p, loc);
  // 编辑时多读一次旧 json 对齐其行尾/尾换行（同 133 行页面读原文的既定代价）；新品无原文=标准 LF
  const prodRaw = opts.isNew ? null : await readFile(env, cfg, `data/products/${prod.id}.json`);
  const files: any[] = [
    { path: `data/products/${prod.id}.json`, content: matchJson(prodRaw, prod) },
    { path: `data/products-index.json`, content: matchJson(ctx.manifestRaw, manifest) },
  ];
  const chromeErrors: string[] = [];

  // 详情页 × enabled locales（默认 locale 恒建；其它 locale：已存在才重渲染——渲染内容不决定 site map）
  for (const locale of locales.enabled) {
    const dir = locDir[locale];
    const rel = dir ? `${dir}/${prod.category}/${prod.id}.html` : `${prod.category}/${prod.id}.html`;
    if (locale !== locales.default && !ctx.pagesList.has(rel) ) continue;
    const related = genRelated(entry, manifest, locale, catalog, urlOf);
    const raw = render(prod, { template, imgBase: site.img_base, related, locale, modelDisplay: locales.model_display, catalog, urlOf, enabled: locales.enabled, catmap });
    const { html, errors } = chrome.applyChrome(raw.replace(/\r/g, ""), rel);   // ⭐ 双步第二段
    chromeErrors.push(...errors);
    // 行尾保留：编辑已有页读原文判行尾（多一次 read，编辑场景可接受）；新页=LF
    const prevRaw = ctx.pagesList.has(rel) ? await readFile(env, cfg, rel) : null;
    files.push({ path: rel, content: matchEol(prevRaw, html) });
  }

  // 受影响列表页 × locales（已存在才 regen；regenListPage 带 opts——修旧调用缺 locale/urlOf 的化石）
  const cats = new Set<string | null>([null, prod.category]);
  if (opts.oldCategory && opts.oldCategory !== prod.category) cats.add(opts.oldCategory);
  for (const cat of cats) {
    for (const locale of locales.enabled) {
      const dir = locDir[locale];
      const base = cat ? `${cat}/index.html` : "products/index.html";
      const rel = dir ? `${dir}/${base}` : base;
      if (!ctx.pagesList.has(rel)) continue;
      const h = await readFile(env, cfg, rel);
      if (h) files.push({ path: rel, content: matchEol(h, regenListPage(h.replace(/\r/g, ""), manifest, cat, { locale, catalog, urlOf } as any /* 真源签名含 catalog/urlOf(render.js:381)；tsc 对 js 推断不全 */)) });
    }
  }
  if (chromeErrors.length) return { error: "chrome 注入报错（未提交，防打回模板态）", detail: chromeErrors.slice(0, 5) };
  // 批3：dryRun=preview 单真源化——同一条管线跑到 commit 前一步返回摘要（消内联第二实现，字节必同源）
  // W5「存草稿箱·预览」：附带默认 locale 详情页渲染 HTML（前端注 <base href> 新标签打开=所见即所得，不提交）。
  const previewPage = files.find((f: any) => f.path === `${prod.category}/${prod.id}.html`);
  if (opts.dryRun) return {
    dry: true,
    previewHtml: previewPage ? previewPage.content : null,   // 默认 locale 详情页（新品/编辑均建默认 locale）
    // bytes=真字节数（TextEncoder）——.length 是 UTF-16 码元数，与磁盘字节对照会差出多字节字符数
    // （批3-1 的"361B 行尾差"定性就是这么错的：字符数 vs 字节数、单位不一致的对照）。
    files: files.map((f: any) => ({ path: f.path, bytes: f.content ? new TextEncoder().encode(f.content).length : 0,
      ...(f.path.endsWith(".html") ? { eol: f.content.includes("\r\n") ? "CRLF" : "LF",
        hasHeader: f.content.includes("main-header"), hasSwitcher: f.content.includes("lang-switch"), hasFooter: f.content.includes("site-footer") } : {}),
      // json 产物在 dry 时回传内容（产品+index 共两个，≤70KB）——供 diff 定性 json 序列化差异（🟡终审项），联调长期有用
      ...(f.path.endsWith(".json") ? { content: f.content } : {}) })),
  };
  const r = await commitFiles(env, cfg, files, `admin: ${opts.isNew ? "create" : "update"} product ${prod.id} (${opts.email})`);
  return { ...r, files: files.map((f) => f.path) };
}

export async function unpublishProduct(env: Env, cfg: any, ctx: Ctx, id: number, opts: { email: string }) {
  const existing = ctx.manifest.find((e: any) => e.id === id);
  if (!existing) return { notFound: true };
  const { locales, locDir, catalog, chrome } = ctx;
  const category = existing.category;
  const manifest = ctx.manifest.filter((e: any) => e.id !== id);
  const urlOf = (p: string, loc: string) => chrome.localizeUrl(p, loc);
  const files: any[] = [
    { path: `data/products/${id}.json`, delete: true },
    { path: `data/products-index.json`, content: matchJson(ctx.manifestRaw, manifest) },
  ];
  for (const locale of locales.enabled) {
    const dir = locDir[locale];
    const rel = dir ? `${dir}/${category}/${id}.html` : `${category}/${id}.html`;
    if (ctx.pagesList.has(rel)) files.push({ path: rel, delete: true });   // 三语详情一并删（存在的）
  }
  for (const cat of new Set<string | null>([null, category])) {
    for (const locale of locales.enabled) {
      const dir = locDir[locale];
      const base = cat ? `${cat}/index.html` : "products/index.html";
      const rel = dir ? `${dir}/${base}` : base;
      if (!ctx.pagesList.has(rel)) continue;
      const h = await readFile(env, cfg, rel);
      if (h) files.push({ path: rel, content: matchEol(h, regenListPage(h.replace(/\r/g, ""), manifest, cat, { locale, catalog, urlOf } as any /* 真源签名含 catalog/urlOf(render.js:381)；tsc 对 js 推断不全 */)) });
    }
  }
  const r = await commitFiles(env, cfg, files, `admin: delete product ${id} (${opts.email})`);
  return { ...r, files: files.map((f) => f.path) };
}


// ================= 批2-3：类目/机型管理 =================
// 一期边界：**slug 集合不可变**（增删类目牵动目录结构/列表页存在性=二期）；可改 display 与顺序。
// display/model 变更 → 重烘焙受影响页（该类目全部详情页三语存在性规则 + 该类目列表 + 总列表）。
// 顺序变更只落 json（首页瓦片顺序吃它——随下次本地管线；诚实边界，注明在响应里）。
export function validateCategories(body: any, existing: any): { cats?: any; error?: string } {
  const list = body?.categories;
  if (!Array.isArray(list) || !list.length) return { error: "categories must be a non-empty array" };
  const slugs = list.map((c: any) => c?.slug);
  if (slugs.some((x: any) => typeof x !== "string" || !/^[a-z0-9-]+$/.test(x))) return { error: "bad slug" };
  if (new Set(slugs).size !== slugs.length) return { error: "duplicate slug" };
  if (list.some((c: any) => typeof c?.display !== "string" || !c.display.trim())) return { error: "display required" };
  const oldSlugs = new Set((existing?.categories || []).map((c: any) => c.slug));
  const newSlugs = new Set(slugs);
  const added = slugs.filter((x: string) => !oldSlugs.has(x));
  const removed = [...oldSlugs].filter((x) => !newSlugs.has(x as string));
  if (added.length || removed.length) return { error: `一期 slug 集合不可变（增删类目=二期）。added=${added} removed=${removed}` };
  return { cats: { ...(existing || {}), categories: list.map((c: any) => ({ slug: c.slug, display: String(c.display) })) } };
}

// 重烘焙一个类目：详情页（三语存在性）双步 + 该类目列表 + 总列表（各语种存在的）。返回 files 数组。
export async function rebakeCategory(env: Env, cfg: any, ctx: Ctx, slug: string): Promise<any[]> {
  const { template, site, locales, catalog, manifest, locDir, catmap, chrome } = ctx;
  const urlOf = (p: string, loc: string) => chrome.localizeUrl(p, loc);
  const files: any[] = [];
  for (const e of manifest.filter((m: any) => m.category === slug)) {
    const raw = await readFile(env, cfg, `data/products/${e.id}.json`);
    if (!raw) continue;
    const prod = JSON.parse(raw);
    for (const locale of locales.enabled) {
      const dir = locDir[locale];
      const rel = dir ? `${dir}/${slug}/${e.id}.html` : `${slug}/${e.id}.html`;
      if (!ctx.pagesList.has(rel)) continue;
      const related = genRelated(e, manifest, locale, catalog, urlOf);
      const html0 = render(prod, { template, imgBase: site.img_base, related, locale, modelDisplay: locales.model_display, catalog, urlOf, enabled: locales.enabled, catmap });
      const { html, errors } = chrome.applyChrome(html0.replace(/\r/g, ""), rel);
      if (errors.length) throw new Error(`chrome 注入失败 ${rel}: ${errors[0]}`);
      const prevRaw = await readFile(env, cfg, rel);   // rebake 恒为已有页——保留其行尾
      files.push({ path: rel, content: matchEol(prevRaw, html) });
    }
  }
  for (const cat of [slug, null]) {
    for (const locale of locales.enabled) {
      const dir = locDir[locale];
      const base = cat ? `${cat}/index.html` : "products/index.html";
      const rel = dir ? `${dir}/${base}` : base;
      if (!ctx.pagesList.has(rel)) continue;
      const h = await readFile(env, cfg, rel);
      if (h) files.push({ path: rel, content: regenListPage(h, manifest, cat, { locale, catalog, urlOf } as any) });
    }
  }
  return files;
}

// ================= W5 P1：首页内容 CMS（镜像官网 regen.mjs 首页生成）=================
// 编辑 home.json i18n 文案 → renderHome + 双步 applyChrome 重烘焙首页（RENDER_SET=enabled∪render_extra，
// render_extra[zh] 从模板播种、internal_noindex 出 noindex）→ 一个原子 commit。
// 安全：i18n merge 只动被编辑的 (key,locale)、保留其余（防翻译擦除）；输入构造镜像 regen.mjs 的 renderHome
// 调用，renderHome 逻辑走 vendored render.js（守卫盯其签名变更，如本次 internal_noindex 增量）。
export interface HomeEdit { key: string; locale: string; value: string; }

// i18n merge：旧 home.json 打底，只覆盖被编辑的 (key,locale)，其余 locale/键原样保留。
export function mergeHome(homeJson: any, edits: HomeEdit[], allowedKeys: Set<string>, allowedLocales: string[]): { home?: any; error?: string } {
  const home = JSON.parse(JSON.stringify(homeJson || {}));
  for (const e of edits) {
    if (!e || typeof e.key !== "string" || !allowedKeys.has(e.key)) return { error: `未知首页键：${e && e.key}` };
    if (!allowedLocales.includes(e.locale)) return { error: `未知 locale：${e.locale}（允许 ${allowedLocales.join("/")}）` };
    if (typeof e.value !== "string") return { error: `值须为字符串：${e.key}/${e.locale}` };
    if (!home[e.key] || typeof home[e.key] !== "object") return { error: `键结构异常：${e.key}` };
    home[e.key][e.locale] = e.value;   // 只动这一个 (key,locale)
  }
  return { home };
}

export async function publishHomepage(env: Env, cfg: any, ctx: Ctx, payload: { edits?: HomeEdit[]; featured?: (number | string)[] | null }, opts: { email: string; dryRun?: boolean }) {
  const edits = payload.edits || [];
  const { locales, catalog, manifest, locDir, chrome } = ctx;
  // 首页专属输入（loadCtx 未加载的单独读；publish 时读最新=对官网并发改动自愈）
  const [homeRaw, homeTpl, tilesRaw, sharedRaw, featRaw] = await Promise.all([
    readFile(env, cfg, "data/pages/home.json"),
    readFile(env, cfg, "data/templates/home.html"),
    readFile(env, cfg, "data/pages/home-tiles.json"),
    readFile(env, cfg, "data/pages/shared.json"),
    readFile(env, cfg, "data/pages/home-featured.json"),
  ]);
  const miss = [!homeRaw && "data/pages/home.json", !homeTpl && "data/templates/home.html", !tilesRaw && "data/pages/home-tiles.json"].filter(Boolean);
  if (miss.length) return { error: "首页源缺失", missing: miss };
  const homeJson = JSON.parse(homeRaw as string);
  const tiles = JSON.parse(tilesRaw as string);
  const shared = sharedRaw ? JSON.parse(sharedRaw) : {};
  // 允许编辑的 locale = home.json 现有 locale 集（en/pt-BR/es-MX，从首键取）；允许键=全部现有键
  const keys = Object.keys(homeJson);
  const allowedLocales = keys.length ? Object.keys(homeJson[keys[0]]) : (locales.enabled || []);
  const mv = edits.length ? mergeHome(homeJson, edits, new Set(keys), allowedLocales) : { home: homeJson };
  if (mv.error) return { error: mv.error };
  const home = mv.home;
  // 精选产品(home-featured)：payload.featured 提供则校验(须是真产品 id、去重、cap 8)+写文件；否则读现值不动
  let featured: any = featRaw ? (JSON.parse(featRaw).ids || null) : null;
  let featuredChanged = false;
  if (payload.featured !== undefined) {
    const seen = new Set<number>();
    const ids = (payload.featured || []).map(Number).filter((n) => Number.isFinite(n) && manifest.some((e: any) => e.id === n) && !seen.has(n) && (seen.add(n), true)).slice(0, 8);
    featured = ids.length ? ids : null;
    featuredChanged = true;
  }
  if (!edits.length && !featuredChanged) return { error: "没有改动（无文案编辑、无精选产品变更）" };

  const urlOf = (p: string, loc: string) => chrome.localizeUrl(p, loc);
  const dirOf = (loc: string) => locDir[loc] ?? "";
  const pageExists = (p: string, loc: string) => { const d = dirOf(loc); return !d || ctx.pagesList.has(`${d}${p}index.html`); };
  const RENDER_SET: string[] = [...(locales.enabled || []), ...(locales.render_extra || [])];
  const INTERNAL: string[] = locales.internal_noindex || [];
  const cat = { ...catalog, ...shared, ...home };

  const files: any[] = [];
  if (edits.length) files.push({ path: "data/pages/home.json", content: matchJson(homeRaw, home) });
  if (featuredChanged) files.push({ path: "data/pages/home-featured.json", content: matchJson(featRaw, { ids: featured || [] }) });
  const chromeErrors: string[] = [];
  for (const locale of RENDER_SET) {
    const dir = dirOf(locale);
    const rel = dir ? `${dir}/index.html` : "index.html";
    const isExtra = (locales.render_extra || []).includes(locale);
    if (!ctx.pagesList.has(rel) && !isExtra) continue;   // enabled 缺页不创建；render_extra(zh)从模板播种
    const h0 = renderHome(homeTpl, { locale, catalog: cat, tiles, modelDisplay: locales.model_display, urlOf, exists: pageExists, dirOf, enabled: locales.enabled, products: manifest, featured, internal_noindex: INTERNAL } as any /* 真源签名，tsc 对 js 默认参数(internal_noindex=[])推断为 never[]，同 regenListPage 走 as any */);
    const { html, errors } = chrome.applyChrome((h0 as string).replace(/\r/g, ""), rel);   // ⭐双步第二段
    chromeErrors.push(...errors);
    const prevRaw = ctx.pagesList.has(rel) ? await readFile(env, cfg, rel) : null;
    files.push({ path: rel, content: matchEol(prevRaw, html) });
  }
  if (chromeErrors.length) return { error: "chrome 注入报错（未提交，防打回模板态）", detail: chromeErrors.slice(0, 5) };
  const enPage = files.find((f) => f.path === "index.html");
  if (opts.dryRun) return {   // dryRun=预览：返回 en 首页渲染 HTML（前端注 base 新标签）+ 将写文件
    dry: true,
    previewHtml: enPage ? enPage.content : null,
    files: files.map((f: any) => ({ path: f.path, bytes: f.content ? new TextEncoder().encode(f.content).length : 0, ...(f.path.endsWith(".json") ? { content: f.content } : {}) })),
    locales: RENDER_SET,
  };
  const r = await commitFiles(env, cfg, files, `admin: homepage content update (${opts.email})`);
  return { ...r, files: files.map((f) => f.path) };
}

// ================= 阶段B：联系方式（data/contact-info.json 语言无关值）=================
// 编辑 11 个语言无关值 → renderPage(config=contact-info) 重烘焙 /contact/ 页×locales + 双步 applyChrome
// → 一个原子 commit（contact-info.json + contact/index.html×RENDER_SET）。镜像 regen.mjs 的 page 循环
// （catalog:{...chrome,...shared,...contact.json 标签}, config: contactCfg, path:"/contact/"）。
// ⚠️ 标签(contact.json)是官网维护的 i18n，本编辑器不碰；只改语言无关值。Pages 只 serve 预烘焙 HTML，
// 故必须自己 renderPage 重烘焙、不能只写 json（同首页 CMS）。
export interface ContactEdit { key: string; value: string; }
export const CONTACT_KEYS = ["phone_display", "phone_tel", "whatsapp", "whatsapp_link", "wechat_id", "wechat_qr", "email", "address", "hours", "response", "map_link"];

export async function publishContact(env: Env, cfg: any, ctx: Ctx, edits: ContactEdit[], opts: { email: string; dryRun?: boolean }) {
  const { locales, catalog, chrome, locDir } = ctx;
  const [cfgRaw, tpl, pcatRaw, sharedRaw] = await Promise.all([
    readFile(env, cfg, "data/contact-info.json"),
    readFile(env, cfg, "data/templates/page-contact.html"),
    readFile(env, cfg, "data/pages/contact.json"),
    readFile(env, cfg, "data/pages/shared.json"),
  ]);
  const miss = [!cfgRaw && "data/contact-info.json", !tpl && "data/templates/page-contact.html", !pcatRaw && "data/pages/contact.json"].filter(Boolean);
  if (miss.length) return { error: "联系页源缺失", missing: miss };
  const contactJson = JSON.parse(cfgRaw as string);
  const pcat = JSON.parse(pcatRaw as string);
  const shared = sharedRaw ? JSON.parse(sharedRaw) : {};
  // merge：只覆盖被编辑的白名单键，其余（含 _schema 及未编辑值）原样保留。语言无关=无 locale 维度。
  const merged = JSON.parse(JSON.stringify(contactJson));
  for (const e of edits) {
    if (!e || typeof e.key !== "string" || !CONTACT_KEYS.includes(e.key)) return { error: `未知联系方式键：${e && e.key}` };
    if (typeof e.value !== "string") return { error: `值须为字符串：${e.key}` };
    merged[e.key] = e.value;
  }
  if (!edits.length) return { error: "没有改动" };

  const urlOf = (p: string, loc: string) => chrome.localizeUrl(p, loc);
  const dirOf = (loc: string) => locDir[loc] ?? "";
  const RENDER_SET: string[] = [...(locales.enabled || []), ...(locales.render_extra || [])];
  const INTERNAL: string[] = locales.internal_noindex || [];
  const catBase = { ...catalog, ...shared, ...pcat };   // 镜像 regen：{...catalog,...shared,...pcat}

  const files: any[] = [{ path: "data/contact-info.json", content: matchJson(cfgRaw, merged) }];
  const chromeErrors: string[] = [];
  for (const locale of RENDER_SET) {
    const dir = dirOf(locale);
    const rel = dir ? `${dir}/contact/index.html` : "contact/index.html";
    const isExtra = (locales.render_extra || []).includes(locale);
    if (!ctx.pagesList.has(rel) && !isExtra) continue;   // enabled 缺页不创建；render_extra(zh)从模板播种
    const h0 = renderPage(tpl, { locale, catalog: catBase, urlOf, path: "/contact/", dirOf, enabled: locales.enabled, internal_noindex: INTERNAL, config: merged } as any /* 真源签名含 config，tsc 对 js 默认参推断不全，同 renderHome 走 as any */);
    const { html, errors } = chrome.applyChrome((h0 as string).replace(/\r/g, ""), rel);   // ⭐双步第二段
    chromeErrors.push(...errors);
    const prevRaw = ctx.pagesList.has(rel) ? await readFile(env, cfg, rel) : null;
    files.push({ path: rel, content: matchEol(prevRaw, html) });
  }
  if (chromeErrors.length) return { error: "chrome 注入报错（未提交，防打回模板态）", detail: chromeErrors.slice(0, 5) };
  const enPage = files.find((f) => f.path === "contact/index.html");
  if (opts.dryRun) return {
    dry: true,
    previewHtml: enPage ? enPage.content : null,
    files: files.map((f: any) => ({ path: f.path, bytes: f.content ? new TextEncoder().encode(f.content).length : 0, ...(f.path.endsWith(".json") ? { content: f.content } : {}) })),
    locales: RENDER_SET,
  };
  const r = await commitFiles(env, cfg, files, `admin: contact info update (${opts.email})`);
  return { ...r, files: files.map((f) => f.path) };
}

// ================= Guides A：/service/ 落地页文案编辑器（service.json + shared.json 卡片键）=================
// ⚠️ 安全红线：shared.json 是全站共享 i18n，误改炸全站。写路径**只允许**下方硬白名单键
//   （service.json 的页头/meta 2 键 + shared.json 的 20 个攻略卡片键=10 卡×[标题,摘要]），
//   任何非白名单键一律拒写。白名单写死后端、前端只暴露这些。
export const SERVICE_META_KEYS = ["service.page-header-subtitle.1", "service.meta.title"];   // 在 service.json
// 10 张攻略卡片，每张 [标题键, 摘要键]（从 page-service.html 精确提取，全在 shared.json）
export const SERVICE_CARDS: [string, string][] = [
  ["shared.starlink_compatible_power_adapters_buyer", "shared.buyer_guide_for_starlink_power_adapters_"],
  ["shared.how_to_set_up_starlink_mini_for_rv_campi", "shared.complete_step_by_step_guide_to_setting_u"],
  ["shared.wanew_pipe_mount_vs_wall_mount_vs_flat_r", "shared.comprehensive_comparison_of_wanew_pipe_m"],
  ["shared.shipping_and_logistics_how_wanew_deliver", "shared.global_shipping_and_logistics_guide_for_"],
  ["shared.quality_control_standards_for_starlink_c", "shared.complete_quality_control_standards_for_t"],
  ["shared.custom_starlink_accessory_manufacturing_", "shared.oem_odm_manufacturing_guide_for_starlink"],
  ["shared.bulk_ordering_guide_moq_lead_time_and_pr", "shared.complete_bulk_ordering_guide_for_wanew_s"],
  ["shared.starlink_junction_box_installation_for_o", "shared.installation_guide_for_wanew_outdoor_jun"],
  ["shared.how_to_install_a_starlink_mount_without_", "shared.guide_to_installing_starlink_without_dri"],
  ["shared.starlink_wall_mount_vs_roof_mount_pros_a", "shared.comprehensive_comparison_of_starlink_wal"],
];
export const SERVICE_CARD_KEYS = SERVICE_CARDS.flat();
export const SERVICE_WHITELIST = new Set<string>([...SERVICE_META_KEYS, ...SERVICE_CARD_KEYS]);
export interface ServiceEdit { key: string; locale: string; value: string; }

// 纯函数：白名单校验 + merge（可 node 单测"非白名单键被拒"红线，无需 token）
export function mergeService(serviceJson: any, sharedJson: any, edits: ServiceEdit[]): { service?: any; shared?: any; touchedService?: boolean; touchedShared?: boolean; error?: string } {
  const service = JSON.parse(JSON.stringify(serviceJson || {}));
  const shared = JSON.parse(JSON.stringify(sharedJson || {}));
  let touchedService = false, touchedShared = false;
  for (const e of edits) {
    if (!e || typeof e.key !== "string") return { error: "编辑项缺 key" };
    if (!SERVICE_WHITELIST.has(e.key)) return { error: `拒写非白名单键：${e.key}（Guides 编辑器只允许 /service/ 页头+meta 与 10 张卡片文案）` };
    if (typeof e.value !== "string") return { error: `值须为字符串：${e.key}` };
    if (typeof e.locale !== "string") return { error: `locale 须为字符串：${e.key}` };
    const inService = e.key.startsWith("service.");
    const target = inService ? service : shared;
    if (!target[e.key] || typeof target[e.key] !== "object") return { error: `键不存在/结构异常：${e.key}` };
    if (!(e.locale in target[e.key])) return { error: `未知 locale：${e.locale}（${e.key} 无此语言）` };
    target[e.key][e.locale] = e.value;
    if (inService) touchedService = true; else touchedShared = true;
  }
  return { service, shared, touchedService, touchedShared };
}

export async function publishService(env: Env, cfg: any, ctx: Ctx, edits: ServiceEdit[], opts: { email: string; dryRun?: boolean }) {
  if (!edits.length) return { error: "没有改动" };
  const { locales, catalog, chrome, locDir } = ctx;
  const [svcRaw, sharedRaw, tpl] = await Promise.all([
    readFile(env, cfg, "data/pages/service.json"),
    readFile(env, cfg, "data/pages/shared.json"),
    readFile(env, cfg, "data/templates/page-service.html"),
  ]);
  const miss = [!svcRaw && "data/pages/service.json", !sharedRaw && "data/pages/shared.json", !tpl && "data/templates/page-service.html"].filter(Boolean);
  if (miss.length) return { error: "攻略页源缺失", missing: miss };
  const svcJson = JSON.parse(svcRaw as string), sharedJson = JSON.parse(sharedRaw as string);
  const mv = mergeService(svcJson, sharedJson, edits);
  if (mv.error) return { error: mv.error };

  const urlOf = (p: string, loc: string) => chrome.localizeUrl(p, loc);
  const dirOf = (loc: string) => locDir[loc] ?? "";
  const RENDER_SET: string[] = [...(locales.enabled || []), ...(locales.render_extra || [])];
  const INTERNAL: string[] = locales.internal_noindex || [];
  // catalog 镜像 regen：{...chrome, ...shared(merged), ...pcat(=service merged)}
  const catBase = { ...catalog, ...mv.shared, ...mv.service };

  const files: any[] = [];
  if (mv.touchedService) files.push({ path: "data/pages/service.json", content: matchJson(svcRaw, mv.service) });
  if (mv.touchedShared) files.push({ path: "data/pages/shared.json", content: matchJson(sharedRaw, mv.shared) });
  const chromeErrors: string[] = [];
  for (const locale of RENDER_SET) {
    const dir = dirOf(locale);
    const rel = dir ? `${dir}/service/index.html` : "service/index.html";
    const isExtra = (locales.render_extra || []).includes(locale);
    if (!ctx.pagesList.has(rel) && !isExtra) continue;
    const h0 = renderPage(tpl, { locale, catalog: catBase, urlOf, path: "/service/", dirOf, enabled: locales.enabled, internal_noindex: INTERNAL } as any);
    const { html, errors } = chrome.applyChrome((h0 as string).replace(/\r/g, ""), rel);
    chromeErrors.push(...errors);
    const prevRaw = ctx.pagesList.has(rel) ? await readFile(env, cfg, rel) : null;
    files.push({ path: rel, content: matchEol(prevRaw, html) });
  }
  if (chromeErrors.length) return { error: "chrome 注入报错（未提交，防打回模板态）", detail: chromeErrors.slice(0, 5) };
  const enPage = files.find((f) => f.path === "service/index.html");
  if (opts.dryRun) return {
    dry: true,
    previewHtml: enPage ? enPage.content : null,
    files: files.map((f: any) => ({ path: f.path, bytes: f.content ? new TextEncoder().encode(f.content).length : 0, ...(f.path.endsWith(".json") ? { content: f.content } : {}) })),
    locales: RENDER_SET,
  };
  const r = await commitFiles(env, cfg, files, `admin: guides(/service/) copy update (${opts.email})`);
  return { ...r, files: files.map((f) => f.path) };
}

// ================= SEO A：信息页 meta title/desc 四语编辑（每页 data/pages/{slug}.json 的 {slug}.meta.*）=================
// ⚠️ 收窄安全页：排除 service（Guides A 已管其 meta）+ about 系（官网重排 about.json 撞车）。
// 每页字段=模板【实际渲染】的（faq 模板只有 title slot，写 desc 不渲染=不放）。类目页(mounts/power/…)是 renderPage hub 页
// （无产品 category=mounts，故非产品列表页、无 grid 顾虑）。contact 页有 {{cfg}} token→renderPage 必须带 config(contact-info)。
export const SEO_PAGES: { slug: string; fields: ("title" | "desc")[]; label: string }[] = [
  { slug: "contact", fields: ["title", "desc"], label: "联系" },
  { slug: "faq", fields: ["title"], label: "FAQ" },
  { slug: "mounts", fields: ["title", "desc"], label: "支架 Mounts" },
  { slug: "power", fields: ["title", "desc"], label: "电源 Power" },
  { slug: "marine", fields: ["title", "desc"], label: "船用 Marine" },
  { slug: "rv-off-grid", fields: ["title", "desc"], label: "房车/离网 RV" },
  { slug: "industrial", fields: ["title", "desc"], label: "工业 Industrial" },
  { slug: "compatibility", fields: ["title", "desc"], label: "兼容 Compatibility" },
];
export interface SeoEdit { field: string; locale: string; value: string; }   // slug 由端点参数定，不在 edit 里

// 纯函数：白名单校验 + merge（可 node 单测"越界字段/非法 slug 被拒"）
export function mergePageMeta(slug: string, pcatJson: any, edits: SeoEdit[]): { merged?: any; error?: string } {
  const page = SEO_PAGES.find((p) => p.slug === slug);
  if (!page) return { error: `页不在 SEO 白名单：${slug}（只允许 ${SEO_PAGES.map((p) => p.slug).join("/")}；service 归攻略编辑器、about 系等官网重排）` };
  const merged = JSON.parse(JSON.stringify(pcatJson || {}));
  for (const e of edits) {
    if (!e || typeof e.field !== "string" || !page.fields.includes(e.field as any)) return { error: `${slug} 不允许字段：${e && e.field}（仅 ${page.fields.join("/")}）` };
    if (typeof e.value !== "string" || typeof e.locale !== "string") return { error: "编辑项类型错" };
    const key = `${slug}.meta.${e.field}`;
    if (!merged[key] || typeof merged[key] !== "object") return { error: `键不存在/结构异常：${key}` };
    if (!(e.locale in merged[key])) return { error: `未知 locale：${e.locale}（${key} 无此语言）` };
    merged[key][e.locale] = e.value;
  }
  return { merged };
}

export async function publishPageMeta(env: Env, cfg: any, ctx: Ctx, slug: string, edits: SeoEdit[], opts: { email: string; dryRun?: boolean }) {
  if (!SEO_PAGES.some((p) => p.slug === slug)) return { error: `页不在 SEO 白名单：${slug}` };
  if (!edits.length) return { error: "没有改动" };
  const { locales, catalog, chrome, locDir } = ctx;
  const [pcatRaw, tpl, sharedRaw, cfgRaw] = await Promise.all([
    readFile(env, cfg, `data/pages/${slug}.json`),
    readFile(env, cfg, `data/templates/page-${slug}.html`),
    readFile(env, cfg, "data/pages/shared.json"),
    readFile(env, cfg, "data/contact-info.json"),   // contact 页 {{cfg}} 需要；其它页忽略（镜像 regen 传给每页）
  ]);
  const miss = [!pcatRaw && `data/pages/${slug}.json`, !tpl && `data/templates/page-${slug}.html`].filter(Boolean);
  if (miss.length) return { error: "页源缺失", missing: miss };
  const pcat = JSON.parse(pcatRaw as string);
  const shared = sharedRaw ? JSON.parse(sharedRaw) : {};
  const contactCfg = cfgRaw ? JSON.parse(cfgRaw) : {};
  const mv = mergePageMeta(slug, pcat, edits);
  if (mv.error) return { error: mv.error };

  const urlOf = (p: string, loc: string) => chrome.localizeUrl(p, loc);
  const dirOf = (loc: string) => locDir[loc] ?? "";
  const RENDER_SET: string[] = [...(locales.enabled || []), ...(locales.render_extra || [])];
  const INTERNAL: string[] = locales.internal_noindex || [];
  const catBase = { ...catalog, ...shared, ...mv.merged };

  const files: any[] = [{ path: `data/pages/${slug}.json`, content: matchJson(pcatRaw, mv.merged) }];
  const chromeErrors: string[] = [];
  for (const locale of RENDER_SET) {
    const dir = dirOf(locale);
    const rel = dir ? `${dir}/${slug}/index.html` : `${slug}/index.html`;
    const isExtra = (locales.render_extra || []).includes(locale);
    if (!ctx.pagesList.has(rel) && !isExtra) continue;
    const h0 = renderPage(tpl, { locale, catalog: catBase, urlOf, path: `/${slug}/`, dirOf, enabled: locales.enabled, internal_noindex: INTERNAL, config: contactCfg } as any);
    const { html, errors } = chrome.applyChrome((h0 as string).replace(/\r/g, ""), rel);
    chromeErrors.push(...errors);
    const prevRaw = ctx.pagesList.has(rel) ? await readFile(env, cfg, rel) : null;
    files.push({ path: rel, content: matchEol(prevRaw, html) });
  }
  if (chromeErrors.length) return { error: "chrome 注入报错（未提交）", detail: chromeErrors.slice(0, 5) };
  const enPage = files.find((f) => f.path === `${slug}/index.html`);
  if (opts.dryRun) return { dry: true, previewHtml: enPage ? enPage.content : null, files: files.map((f: any) => ({ path: f.path, bytes: f.content ? new TextEncoder().encode(f.content).length : 0, ...(f.path.endsWith(".json") ? { content: f.content } : {}) })), locales: RENDER_SET };
  const r = await commitFiles(env, cfg, files, `admin: SEO meta update ${slug} (${opts.email})`);
  return { ...r, files: files.map((f) => f.path) };
}
