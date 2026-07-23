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
import { render, genRelated, resolveImg, regenListPage, excerptOf, catmapOf } from "../../functions/_lib/render.js";
// @ts-ignore js 模块
import { makeChrome } from "../../functions/_lib/chrome.js";
// @ts-ignore js 模块
import { ghConfig, commitFiles, readFile } from "../../functions/_lib/github.js";
// ⭐ locale→目录规则直接 import 真源（纯 ESM 零 Node 依赖）。第一版我凭注释复刻、漏了 locales.dir
//   覆盖字段——读真源当场抓包（批㉔ 列名教训：复刻必对真源；能 import 就绝不复刻）。
// @ts-ignore js 模块
import { localeDirs } from "../../scripts/locale-dirs.mjs";
import type { Env } from "./index";

export interface Ctx {
  template: string; site: any; locales: any; catalog: any; categories: any;
  manifest: any[]; partial: string; pagesList: Set<string>;
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
  return { template, site, locales, catalog, categories, manifest, partial, pagesList, locDir, catmap: catmapOf(categories), chrome };
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
    meta_title: en.meta_title || en.title, meta_description: en.meta_description || "",
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
  const files: any[] = [
    { path: `data/products/${prod.id}.json`, content: JSON.stringify(prod, null, 2) },
    { path: `data/products-index.json`, content: JSON.stringify(manifest, null, 2) },
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
  if (opts.dryRun) return {
    dry: true,
    // bytes=真字节数（TextEncoder）——.length 是 UTF-16 码元数，与磁盘字节对照会差出多字节字符数
    // （批3-1 的"361B 行尾差"定性就是这么错的：字符数 vs 字节数、单位不一致的对照）。
    files: files.map((f: any) => ({ path: f.path, bytes: f.content ? new TextEncoder().encode(f.content).length : 0,
      ...(f.path.endsWith(".html") ? { eol: f.content.includes("\r\n") ? "CRLF" : "LF",
        hasHeader: f.content.includes("main-header"), hasSwitcher: f.content.includes("lang-switch"), hasFooter: f.content.includes("site-footer") } : {}) })),
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
    { path: `data/products-index.json`, content: JSON.stringify(manifest, null, 2) },
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
