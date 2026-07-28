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
import { ghConfig, commitFiles as rawCommitFiles, readFile } from "../vendor/github.js";
import { afford, spent } from "./subreq";
import { byteLen } from "./bytes";

// ⭐ 提交前的子请求预检 —— **咽喉点就是这个 import**。
// 本文件有 7 处 `commitFiles(...)`，index.ts 还有 4 处；**一处都不用改**：换掉这个名字，
// 全部调用点自动过闸。（在 11 个地方各写一段预检，第 12 个加进来时必然漏。）
//
// 🔴 拒绝必须发生在**发出第一个写请求之前**。半路炸的代价不是"失败"，是**可能留下半残**：
//    commitFiles 是 blob×N → tree → commit → PATCH，只有最后一次 PATCH 动分支，
//    所以今天这次没留残留 —— **但那是断点位置的运气，不是设计的保证。**
// ⚠️ 成本模型必须跟着 vendor 的实现走：官网把逐文件 blob POST 换成 tree 内联 content 之后，
//    写入侧变成**固定 5 次**（ref + head commit + tree + commit + PATCH），**与文件数无关**。
//    旧模型是 `2 + 文件数 + 3`；若不跟着改，保存产品（33 文件）会被算成需要 38 次而**被我自己的闸拒掉**
//    —— 实际只花 5 次。**一个模型过时了的安全装置，就是停机器。**
//    这个常数与 vendor 实现的一致性由 `scripts/token-lint.mjs` 机器核对，不靠记性。
// vendor 现在有**两条**写入路径，成本不同：
//   · 内联 content（请求体 ≤ INLINE_LIMIT）→ 固定 5 次
//   · 体积超限 → 退回逐文件 blob POST  → 5 + 文件数
// 只按 5 算会在退路上撞限；只按 5+N 算会**误拒正常保存**（33 文件的产品保存实际只花 5）。
// ⚠️ INLINE_LIMIT 必须与 vendor 里那个常数一致 —— 由 token-lint 机器核对，不靠记性。
const COMMIT_SUBREQ = 5;
const INLINE_LIMIT = 5 * 1024 * 1024;

const commitCost = (files: any[]): number => {
  const writes = files.filter((f: any) => !f.delete);
  // ⚠️ 字节数不是字符长度：`"中".length === 1` 而 UTF-8 是 3 字节。
  //    用 .length 会在中文内容上把体积**低估到三分之一**，于是该走退路的判成内联。
  const bytes = writes.reduce((a: number, f: any) => a + byteLen(f.content), 0);
  return bytes <= INLINE_LIMIT ? COMMIT_SUBREQ : COMMIT_SUBREQ + writes.length;
};

export async function commitFiles(env: Env, cfg: any, files: any[], message: string) {
  const no = afford(commitCost(files), `提交 ${files.length} 个文件`);
  if (no) throw new Error(`调用次数超限（未提交，仓库未改动）\n${no}`);
  return rawCommitFiles(env, cfg, files, message);
}
// ⭐ locale→目录规则直接 import 真源（纯 ESM 零 Node 依赖）。第一版我凭注释复刻、漏了 locales.dir
//   覆盖字段——读真源当场抓包（批㉔ 列名教训：复刻必对真源；能 import 就绝不复刻）。
// @ts-ignore js 模块
import { localeDirs } from "../vendor/locale-dirs.mjs";
import type { Env } from "./index";

export interface Ctx {
  template: string; site: any; locales: any; catalog: any; categories: any;
  manifest: any[]; manifestRaw: string | null; partial: string; pagesList: Set<string>;
  locDir: Record<string, string>; catmap: Record<string, string>;
  // 形态/品类轴单源（#52 block2）：forms = data/forms.json 的 forms[]（[{key,name}]，数组顺序=/type 页序=chip 序）；
  // formKey = 官网同款派生 {name→key}（render.js cardHtml/regenListPage 穿参、chrome.js makeChrome 内部同式派生）。
  forms: { key: string; name: string }[]; formKey: Record<string, string>;
  // 图片尺寸单源 data/media-sizes.json（{src→[w,h]}）：render/cardHtml/renderHome 用它给 <img>
  // 补 width/height 治 CLS。**不传=官网刚烘进去的尺寸属性会被我的重烘焙抹掉**（不崩、静默劣化）。
  // 查不到的图什么都不写（错的宽高比比没有更糟）——所以缺文件时行为与今天一致。
  sizes: Record<string, [number, number]>;
  chrome: { applyChrome: (html: string, path: string) => { html: string; errors: string[] } ; localizeUrl: (p: string, loc: string) => string };
}

// 形态轴派生：与官网 chrome.js:50 逐字同式（Object.fromEntries(forms.map(f=>[f.name,f.key]))）——
// 旧 render.js FORM_KEY 常量正是这个形状，故迁移后行为字节等价。单源=data/forms.json。
export const formKeyOf = (forms: any[]): Record<string, string> =>
  Object.fromEntries((forms || []).map((f: any) => [f.name, f.key]));

export async function loadCtx(env: Env, cfg: any): Promise<Ctx | null> {
  const [template, siteRaw, locRaw, catRaw, categoriesRaw, manRaw, partial, pagesRaw, formsRaw, sizesRaw] = await Promise.all([
    readFile(env, cfg, "data/templates/product.html"),
    readFile(env, cfg, "data/site.json"),
    readFile(env, cfg, "data/locales.json"),
    readFile(env, cfg, "data/chrome.json"),
    readFile(env, cfg, "data/categories.json"),
    readFile(env, cfg, "data/products-index.json"),
    readFile(env, cfg, "data/templates/_chrome.html"),
    readFile(env, cfg, "data/pages-list.json"),
    readFile(env, cfg, "data/forms.json"),
    readFile(env, cfg, "data/media-sizes.json"),
  ]);
  // 精确报缺哪个（㉔ 批错误透传教训：别让"果"盖住"因"）。categories/pages-list 随本链发布——
  // 链未 push 前 GitHub 上没有它们，preview 会在此如实报缺（依赖顺序，非缺陷）。
  // forms.json 列入必需（与官网 [[path]].js loadCtx 同款 fail-closed）：缺了会让品类 nav 计数全 0、
  // 产品 form 校验全拒——那是"静默错"，不如响亮报缺（契约 §6）。
  const missing = [
    !template && "data/templates/product.html", !siteRaw && "data/site.json", !locRaw && "data/locales.json",
    !catRaw && "data/chrome.json", !categoriesRaw && "data/categories.json", !partial && "data/templates/_chrome.html",
    !pagesRaw && "data/pages-list.json", !formsRaw && "data/forms.json",
  ].filter(Boolean);
  if (missing.length) { (globalThis as any).__ctxMissing = missing; return null; }
  const site = JSON.parse(siteRaw), locales = JSON.parse(locRaw), catalog = JSON.parse(catRaw);
  const categories = JSON.parse(categoriesRaw);
  const manifest = manRaw ? JSON.parse(manRaw) : [];
  // ── 「这个页面存不存在」的真源 ────────────────────────────────────────────
  // 原来查 `data/pages-list.json` —— 那是**另一个仓维护的一份清单**，而清单会和现实分叉：
  // 实测它 611 条 / 仓里 613 个 HTML，已经差了 2 条。分叉的两个方向各对应一种病：
  //   清单多一条 → 对不存在的路径下 tombstone；清单少一条 → 该更新的页被**静默跳过**。
  //
  // ⭐ 改成问仓库本身：一次 `GET /git/trees/{branch}?recursive=1` 拿到全部路径。
  //    **1 次子请求、与文件数无关**（实测 1843 个文件，GitHub 截断阈值约 10 万条/7MB）。
  //    从此 `exists` 问的是"仓库里有没有这个文件"，**它不可能说谎**。
  //
  // ⚠️ 只做**成员判断**，不枚举 —— 已核实全仓 0 处枚举 `pagesList`。
  //    这一条很重要：`pages-list.json` 里编码着"**哪些 HTML 算站点页**"，那条规则的权威在官网；
  //    裸文件列表里 `admin/index.html` 这种也在。**枚举它就等于在 admin 里重新实现那条规则。**
  let treePaths: Set<string> | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.name}/git/trees/${cfg.branch}?recursive=1`, {
      headers: { Authorization: `Bearer ${(env as any).GITHUB_TOKEN}`, "User-Agent": "wanew-admin", Accept: "application/vnd.github+json" },
    });
    const tr: any = res.ok ? await res.json() : null;
    if (!res.ok) console.error(JSON.stringify({ evt: "tree_fetch_failed", status: res.status }));
    if (tr && Array.isArray(tr.tree)) {
      // ⚠️ 截断时**不能**当"这些就是全部"——那会把没列出来的文件判成不存在（= 复活 + 停更两种病一起来）
      if (tr.truncated) console.error(JSON.stringify({ evt: "tree_truncated", note: "递归 tree 被截断，回落 pages-list.json" }));
      else treePaths = new Set<string>(tr.tree.filter((n: any) => n.type === "blob").map((n: any) => n.path));
    }
  } catch (e: any) {
    // 拿不到就回落到旧真源（今天的行为），并留痕 —— 静默降级会让"为什么又漂了"查不出来
    console.error(JSON.stringify({ evt: "tree_fetch_failed", detail: String(e).slice(0, 200) }));
  }
  const listedPages = new Set<string>(JSON.parse(pagesRaw));
  const pagesList = treePaths || listedPages;
  const locDir = localeDirs(locales);
  const forms = JSON.parse(formsRaw).forms || [];
  const formKey = formKeyOf(forms);
  // media-sizes.json 不列必需：缺了只是不补 width/height（与今天一致），不该因此拒绝所有写操作
  let sizes: Record<string, [number, number]> = {};
  if (sizesRaw) { try { sizes = JSON.parse(sizesRaw); } catch { sizes = {}; } }
  const chrome = makeChrome({
    catalog, locales, partial, manifest,
    pageExists: (rel: string) => pagesList.has(rel),
    locDir,
    forms,   // #52 block2：品类 nav 计数吃 forms.json 单源（不传=计数全 0，不崩但错）
  });
  return { template, site, locales, catalog, categories, manifest, manifestRaw: manRaw ?? null, partial, pagesList, locDir, catmap: catmapOf(categories), forms, formKey, sizes, chrome };
}

// body h1 消毒：模板已把产品标题渲成 canonical <h1>（render.js {{TITLE}}），body 正文里再出现 <h1>
// 会与它抢 h1（652 实测 4 个）——降级为 <h2>，属性/内容原样保留，只换标签名。⚠️ 只作用于正文 html
// 字符串（description_html/summary_html），不碰模板 {{TITLE}}。每次保存都过一遍 = durable，非一次性。
export function demoteBodyH1(html: string): string {
  if (typeof html !== "string" || !html) return html;
  return html
    .replace(/<h1(?=[\s/>])/gi, "<h2")   // <h1 …> / <h1> / <h1/> → <h2…（保留属性与后续）
    .replace(/<\/h1(\s*)>/gi, "</h2$1>");
}

// 校验 + 白名单 + ⭐merge：编辑时以旧 json 为底，en 从表单、其它 locale 原样保留（防翻译擦除）。
export function validateProduct(body: any, id: number, categories: any, existing: any | null, forms: any[]): { prod?: any; error?: string } {
  const CATEGORIES: string[] = (categories?.categories || []).map((c: any) => c.slug);
  // 形态白名单=data/forms.json 单源（#52 block2；旧硬编码数组已删——两处打架=品类 split-brain）
  const FORMS: string[] = (forms || []).map((f: any) => f.name);
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
  // 适配终端（可选）：机型 slug 数组。**选项源=categories.json 的机型清单**（分类页同一份），
  // 存 slug 不存显示名——改机型显示名不该动到 68 个产品的数据（那正是双源会犯的错）。
  // 空/缺省=官网不显示徽章=现状不破。**绝不从描述散文里自动抽**（那是推断，会抽错）。
  if (body.compatible_with !== undefined && !Array.isArray(body.compatible_with)) return { error: "compatible_with must be an array" };
  const compat: string[] = [...new Set((body.compatible_with || []).map((x: any) => String(x)))] as string[];
  const badCompat = compat.filter((s) => !CATEGORIES.includes(s));
  if (badCompat.length) return { error: `适配终端必须是现有机型：${badCompat.join(",")}（可选值 ${CATEGORIES.join("/")}）` };
  // 视频（可选·v1）：每条需 key|src(R2 mp4)；poster/title/alt 可选。缺省字段=零迁移（现有产品无 videos → 渲染不变）。
  if (body.videos !== undefined && !Array.isArray(body.videos)) return { error: "videos must be an array" };
  for (const v of body.videos || []) {
    if (!v || (typeof v.key !== "string" && typeof v.src !== "string")) return { error: "each video needs key or src" };
    if (v.poster && typeof v.poster.key !== "string" && typeof v.poster.src !== "string") return { error: "video poster needs key or src" };
  }
  const i18n: any = { ...(existing?.i18n || {}) };   // ⭐ 旧翻译打底（es/pt 等原样保留）
  i18n.en = {
    title: en.title, summary_html: demoteBodyH1(en.summary_html || ""), description_html: demoteBodyH1(en.description_html),
    // meta_title 是派生字段（render.js:20 "deliberately NOT read from data — DERIVED"）——
    // 只在用户显式自定义(≠title)时落盘；否则不存（🟡终审 diff 抓出旧白名单把派生值显式化 +166B）
    ...(en.meta_title && en.meta_title !== en.title ? { meta_title: en.meta_title } : {}),
    // 短名（人话标题）：h1 与列表卡用它，长 title 留给 <title>/meta（SEO 不丢）。
    // **空就不落盘**——官网侧回落 title=现状不破（存量 68 个产品一个字节都不动）。
    ...(typeof en.card_title === "string" && en.card_title.trim() ? { card_title: en.card_title.trim() } : {}),
    meta_description: en.meta_description || "",
  };
  // 状态机：draft/published/archived。body.status 合法则用；否则沿用旧值；再否则 published
  // （新建走 POST 端点会显式置 draft；缺省 published=零迁移，现有无 status 产品视为已发布）。
  const status = (["draft", "published", "archived"].includes(body.status) ? body.status : (existing?.status ?? "published"));
  const prod = {
    id, category: body.category, form, status, robots: body.robots ?? (existing?.robots ?? null),
    // 非空才落盘=零迁移（现有 68 个产品无此字段 → 官网回落现状、渲染逐字节不变）
    ...(compat.length ? { compatible_with: compat } : {}),
    i18n,
    images: body.images.map((im: any) => (im.key !== undefined ? { key: im.key, alt: im.alt || "" } : { src: im.src, alt: im.alt || "" })),
    // 视频（非空才落盘=零迁移）：key|src + poster(可选) + title(可选单值,v1 非 i18n) + alt
    ...((body.videos && body.videos.length) ? { videos: body.videos.map((v: any) => ({
      ...(v.key !== undefined ? { key: v.key } : { src: v.src }),
      ...(v.poster ? { poster: v.poster.key !== undefined ? { key: v.poster.key } : { src: v.poster.src } } : {}),
      ...(v.title ? { title: String(v.title) } : {}),
      alt: v.alt || "",
    })) } : {}),
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
  const { template, site, locales, catalog, manifest: man0, locDir, catmap, chrome, formKey, sizes } = ctx;
  const thumb = prod.images[0] ? resolveImg(prod.images[0], site.img_base) : "";
  const entry: any = { id: prod.id, category: prod.category, form: prod.form, title: prod.i18n.en.title, ...(prod.i18n.en.card_title ? { card_title: prod.i18n.en.card_title } : {}), thumb, excerpt: excerptOf(prod) };
  // ⭐ manifest entry 的 i18n（pt/es 卡片标题/摘要）——抄 regen.mjs:47-53 同源逻辑。
  //   漏它的代价（字节对照抓出的真雷）：每次保存，该品在 pt/es 列表卡片退化英文（Δ59/44B 实测）。
  for (const loc of locales.enabled) {
    if (loc === locales.default) continue;
    const t = prod.i18n[loc] && prod.i18n[loc].title;
    const ct = prod.i18n[loc] && prod.i18n[loc].card_title;
    const x = excerptOf(prod, loc);
    if (t || ct || x !== entry.excerpt) (entry.i18n ??= {})[loc] = { ...(t ? { title: t } : {}), ...(ct ? { card_title: ct } : {}), ...(x ? { excerpt: x } : {}) };
  }
  // ⭐ 状态机：published=进 index+渲染页；draft/archived=不进 index、删已存在的线上页（保留 {id}.json）。
  //   （prod.status 缺省 published=零迁移。官网只渲 products-index.json→draft/archived 天然不渲染/不被爬。）
  const isLive = (prod.status || "published") === "published";
  const base = man0.filter((e: any) => e.id !== prod.id);
  const manifest = (isLive ? base.concat(entry) : base)
    .sort((a: any, b: any) => a.category.localeCompare(b.category) || a.id - b.id);
  const urlOf = (p: string, loc: string) => chrome.localizeUrl(p, loc);
  // 编辑时多读一次旧 json 对齐其行尾/尾换行（同页面读原文的既定代价）；新品无原文=标准 LF
  const prodRaw = opts.isNew ? null : await readFile(env, cfg, `data/products/${prod.id}.json`);
  const files: any[] = [
    { path: `data/products/${prod.id}.json`, content: matchJson(prodRaw, prod) },
    { path: `data/products-index.json`, content: matchJson(ctx.manifestRaw, manifest) },
  ];
  const chromeErrors: string[] = [];
  let previewContent: string | null = null;   // 默认 locale 详情页渲染（dryRun 预览用；draft 也能预览"若发布长啥样"）

  // 详情页 × enabled locales（默认 locale 恒渲染[供预览]；其它 locale：已存在才处理——渲染内容不决定 site map）
  for (const locale of locales.enabled) {
    const dir = locDir[locale];
    const rel = dir ? `${dir}/${prod.category}/${prod.id}.html` : `${prod.category}/${prod.id}.html`;
    const exists = ctx.pagesList.has(rel);
    const isDefault = locale === locales.default;
    if (isLive) {
      if (!isDefault && !exists) continue;
      const related = genRelated(entry, manifest, locale, catalog, urlOf);
      const raw = render(prod, { template, imgBase: site.img_base, related, locale, modelDisplay: locales.model_display, catalog, urlOf, enabled: locales.enabled, catmap, sizes });
      const { html, errors } = chrome.applyChrome(raw.replace(/\r/g, ""), rel);   // ⭐ 双步第二段
      chromeErrors.push(...errors);
      const prevRaw = exists ? await readFile(env, cfg, rel) : null;
      const out = matchEol(prevRaw, html);
      if (isDefault) previewContent = out;
      files.push({ path: rel, content: out });
    } else {
      // draft/archived：删已存在的线上页；默认 locale 仍渲染一份供 dryRun 预览（不进 files=不提交）
      if (isDefault) {
        const related = genRelated(entry, manifest, locale, catalog, urlOf);
        const raw = render(prod, { template, imgBase: site.img_base, related, locale, modelDisplay: locales.model_display, catalog, urlOf, enabled: locales.enabled, catmap, sizes });
        const { html, errors } = chrome.applyChrome(raw.replace(/\r/g, ""), rel);
        chromeErrors.push(...errors);
        previewContent = matchEol(exists ? await readFile(env, cfg, rel) : null, html);
      }
      if (exists) files.push({ path: rel, delete: true });   // 线上页存在则删（下架/存草稿）
    }
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
      if (h) files.push({ path: rel, content: matchEol(h, regenListPage(h.replace(/\r/g, ""), manifest, cat, { locale, catalog, urlOf, formKey, sizes } as any /* 真源签名含 catalog/urlOf(render.js:381)；tsc 对 js 推断不全 */)) });
    }
  }
  if (chromeErrors.length) return { error: "chrome 注入报错（未提交，防打回模板态）", detail: chromeErrors.slice(0, 5) };
  // 批3：dryRun=preview 单真源化——同一条管线跑到 commit 前一步返回摘要（消内联第二实现，字节必同源）
  // W5「存草稿箱·预览」：附带默认 locale 详情页渲染 HTML（前端注 <base href> 新标签打开=所见即所得，不提交）。
  if (opts.dryRun) return {
    dry: true,
    previewHtml: previewContent,   // 默认 locale 详情页渲染（live 及 draft 均渲染供预览；draft 不进 files 不提交）
    status: prod.status,
    // bytes=真字节数（TextEncoder）——.length 是 UTF-16 码元数，与磁盘字节对照会差出多字节字符数
    // （批3-1 的"361B 行尾差"定性就是这么错的：字符数 vs 字节数、单位不一致的对照）。
    files: files.map((f: any) => ({ path: f.path, bytes: f.content ? byteLen(f.content) : 0,
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
  const { locales, locDir, catalog, chrome, formKey, sizes } = ctx;
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
      if (h) files.push({ path: rel, content: matchEol(h, regenListPage(h.replace(/\r/g, ""), manifest, cat, { locale, catalog, urlOf, formKey, sizes } as any /* 真源签名含 catalog/urlOf(render.js:381)；tsc 对 js 推断不全 */)) });
    }
  }
  const r = await commitFiles(env, cfg, files, `admin: delete product ${id} (${opts.email})`);
  return { ...r, files: files.map((f) => f.path) };
}

// ================= P0-3 批量编辑（一次 commit 的多产品原子 publish）=================
// ⭐ 一致性核心：批量改 category 涉页面路径重算（旧 cat/id.html 删、新 cat/id.html 建）。
// bulkPagePlan=纯函数（可 node 单测）：给一个产品的路径变更，算出该删哪些旧路径页、该渲染哪些新路径页。
export function bulkPagePlan(
  id: number, oldCat: string, newCat: string, isLive: boolean,
  enabledLocales: string[], defaultLoc: string, locDir: Record<string, string>, pagesList: Set<string>,
): { deletes: string[]; renders: string[] } {
  const deletes: string[] = [], renders: string[] = [];
  const catChanged = oldCat !== newCat;
  for (const locale of enabledLocales) {
    const dir = locDir[locale] || "";
    const oldRel = dir ? `${dir}/${oldCat}/${id}.html` : `${oldCat}/${id}.html`;
    const newRel = dir ? `${dir}/${newCat}/${id}.html` : `${newCat}/${id}.html`;
    if (catChanged && pagesList.has(oldRel)) deletes.push(oldRel);   // 类目变→删旧路径页（防残留）
    if (isLive) {
      // 渲染新路径页：默认 locale 恒；其它 locale 在新路径已存在、或旧路径存在(迁移过来)才渲
      if (locale === defaultLoc || pagesList.has(newRel) || (catChanged && pagesList.has(oldRel))) renders.push(newRel);
    } else {
      if (pagesList.has(newRel)) deletes.push(newRel);   // 下架/草稿：删新路径页（若存在）
    }
  }
  return { deletes: [...new Set(deletes)], renders: [...new Set(renders)] };
}

// 批量端点：对 ids 逐个应用 op(status/category/form) → 累积所有变更进一个 files[] → 一次 commitFiles。
// opts.forms：用**将要写入**的 forms.json 覆盖本次操作的形态真源（改品类显示名时，新名还不在 ctx.forms 里）。
//   一个覆盖同时喂白名单与 formKey ⇒ 二者不可能在同一次操作内打架。
// opts.extraFiles/message：让调用方把 forms.json 等一起塞进**同一次 commit**（原子；否则中间态会让
//   官网 forms-integrity-check 看到"产品引用了 forms.json 里没有的 form"而 FAIL）。
export async function publishBulk(env: Env, cfg: any, ctx: Ctx, ids: number[], op: string, value: string, opts: { email: string; forms?: { key: string; name: string }[]; extraFiles?: any[]; message?: string }) {
  if (!["status", "category", "form"].includes(op)) return { error: `未知批量操作：${op}` };
  const { template, site, locales, catalog, manifest: man0, locDir, catmap, chrome, sizes } = ctx;
  const CATS: string[] = (ctx.categories?.categories || []).map((c: any) => c.slug);
  const formsEff = opts.forms ?? ctx.forms ?? [];
  const FORMS: string[] = formsEff.map((f: any) => f.name);   // forms.json 单源（可被 opts.forms 覆盖）
  const formKey = formKeyOf(formsEff);
  if (op === "status" && !["draft", "published", "archived"].includes(value)) return { error: "status 非法" };
  if (op === "category" && !CATS.includes(value)) return { error: `机型非法：${value}` };
  if (op === "form" && value && !FORMS.includes(value)) return { error: `形态非法：${value}` };
  const urlOf = (p: string, loc: string) => chrome.localizeUrl(p, loc);
  const idset = new Set(ids.map(Number).filter((n) => Number.isFinite(n)));
  if (!idset.size) return { error: "ids 为空" };

  let manifest: any[] = [...man0];
  const affectedCats = new Set<string | null>([null]);   // products/ 总列表恒受影响
  const files: any[] = [];
  const chromeErrors: string[] = [];
  let touched = 0;
  const skipped: any[] = [];   // ⭐ 跳过的必须被数出来并报出去

  for (const id of idset) {
    const raw = await readFile(env, cfg, `data/products/${id}.json`);
    // ⚠️ readFile 只在 **404** 时返回 null，而这个 id 刚从 manifest 里来 ——
    //    "清单里有、读回来是 null" 是一个**应该吼的矛盾**，静默 continue 会让
    //    "改了 N 个"里的 N 少一个而没人知道少了哪个。
    if (!raw) { skipped.push({ id, why: "读不到（404，但 manifest 里有）" }); continue; }
    let prod: any; try { prod = JSON.parse(raw); } catch (e: any) { skipped.push({ id, why: "JSON 解析失败：" + String(e).slice(0, 80) }); continue; }
    const oldCat = prod.category;
    if (op === "status") prod.status = value;
    else if (op === "category") prod.category = value;
    else if (op === "form") prod.form = value || null;
    const isLive = (prod.status || "published") === "published";
    files.push({ path: `data/products/${id}.json`, content: matchJson(raw, prod) });
    // manifest：移旧条目；live 则加新条目（entry 抄 publishProduct 逻辑）
    manifest = manifest.filter((e: any) => e.id !== id);
    const thumb = prod.images?.[0] ? resolveImg(prod.images[0], site.img_base) : "";
    const entry: any = { id: prod.id, category: prod.category, form: prod.form, title: prod.i18n.en.title, ...(prod.i18n.en.card_title ? { card_title: prod.i18n.en.card_title } : {}), thumb, excerpt: excerptOf(prod) };
    for (const loc of locales.enabled) {
      if (loc === locales.default) continue;
      const t = prod.i18n[loc] && prod.i18n[loc].title; const x = excerptOf(prod, loc); const ct = prod.i18n[loc] && prod.i18n[loc].card_title;
      if (t || ct || x !== entry.excerpt) (entry.i18n ??= {})[loc] = { ...(t ? { title: t } : {}), ...(ct ? { card_title: ct } : {}), ...(x ? { excerpt: x } : {}) };
    }
    if (isLive) manifest.push(entry);
    affectedCats.add(oldCat); affectedCats.add(prod.category);
    // 页面计划（一致性核心，纯函数算）
    const plan = bulkPagePlan(id, oldCat, prod.category, isLive, locales.enabled, locales.default, locDir, ctx.pagesList);
    for (const rel of plan.deletes) files.push({ path: rel, delete: true });
    for (const rel of plan.renders) {
      // 从 rel 反推 locale（dir 前缀→locale）：按 enabled 找匹配的 locale
      const loc = locales.enabled.find((L: string) => { const d = locDir[L] || ""; return (d ? `${d}/${prod.category}/${id}.html` : `${prod.category}/${id}.html`) === rel; }) || locales.default;
      const related = genRelated(entry, manifest, loc, catalog, urlOf);
      const rawHtml = render(prod, { template, imgBase: site.img_base, related, locale: loc, modelDisplay: locales.model_display, catalog, urlOf, enabled: locales.enabled, catmap, sizes });
      const { html, errors } = chrome.applyChrome(rawHtml.replace(/\r/g, ""), rel);
      chromeErrors.push(...errors);
      const prevRaw = ctx.pagesList.has(rel) ? await readFile(env, cfg, rel) : null;
      files.push({ path: rel, content: matchEol(prevRaw, html) });
    }
    touched++;
  }
  if (!touched) return { error: "无有效产品（ids 都不存在）" };
  if (chromeErrors.length) return { error: "chrome 注入报错（未提交）", detail: chromeErrors.slice(0, 5) };
  manifest.sort((a: any, b: any) => a.category.localeCompare(b.category) || a.id - b.id);
  files.push({ path: "data/products-index.json", content: matchJson(ctx.manifestRaw, manifest) });
  // 受影响列表页 × locales regen 一次（用最终 manifest）
  for (const cat of affectedCats) {
    for (const locale of locales.enabled) {
      const dir = locDir[locale] || "";
      const base = cat ? `${cat}/index.html` : "products/index.html";
      const rel = dir ? `${dir}/${base}` : base;
      if (!ctx.pagesList.has(rel)) continue;
      const h = await readFile(env, cfg, rel);
      if (h) files.push({ path: rel, content: matchEol(h, regenListPage(h.replace(/\r/g, ""), manifest, cat, { locale, catalog, urlOf, formKey, sizes } as any)) });
    }
  }
  if (opts.extraFiles?.length) files.push(...opts.extraFiles);   // 与产品改动同一次 commit=原子
  const r = await commitFiles(env, cfg, files, opts.message || `admin: bulk ${op}=${value} ${touched} products (${opts.email})`);
  return { ...r, count: touched, files: files.map((f) => f.path), ...(skipped.length ? { skipped } : {}) };
}


// ================= 批2-3：类目/机型管理 =================
// 一期边界（契约 §5）：可**加 / 改显示名 / 排序 / 带守卫删**；**改 slug 不做**（slug=URL 段 /{slug}/，
// 改=断外链+需 301 迁移）。加机型=新 slug=新 URL、不碰现有=安全。
// display/model 变更 → 重烘焙受影响页；顺序变更只落 json。
// ⚠️ 新机型的**页面**是从零生成的（regen.mjs 需 fs），edge 跑不了 → 必须过一次官网 build（契约 §1/§2）。
export function validateCategories(body: any, existing: any): { cats?: any; error?: string; removed?: string[]; added?: string[] } {
  const list = body?.categories;
  if (!Array.isArray(list) || !list.length) return { error: "categories must be a non-empty array" };
  const slugs = list.map((c: any) => c?.slug);
  if (slugs.some((x: any) => typeof x !== "string" || !/^[a-z0-9-]+$/.test(x))) return { error: "bad slug" };
  if (new Set(slugs).size !== slugs.length) return { error: "duplicate slug" };
  if (list.some((c: any) => typeof c?.display !== "string" || !c.display.trim())) return { error: "display required" };
  const oldSlugs = new Set((existing?.categories || []).map((c: any) => c.slug));
  const newSlugs = new Set(slugs);
  const added = slugs.filter((x: string) => !oldSlugs.has(x));
  const removed = [...oldSlugs].filter((x) => !newSlugs.has(x as string)) as string[];
  return { cats: { ...(existing || {}), categories: list.map((c: any) => ({ slug: c.slug, display: String(c.display) })) }, removed, added };
}

// ================= 品类/形态轴管理（契约 §3/§4）=================
// 真源=data/forms.json 的 forms[]（[{key,name}]，数组顺序=/type 页序=chip 序）。
// 一期：加 / 排序 / 改显示名 / 带守卫删；**改 key 不做**（key=/type/{key}/ URL 段，改=断外链）。
// 改 key 在本模型里天然表现为「删旧 key + 加新 key」，而删有 count>0 守卫 ⇒ 在用的 key 改不动 = 契约 §5 自动成立。
export function validateForms(body: any, existing: any[]): {
  forms?: { key: string; name: string }[]; error?: string;
  added?: string[]; removed?: string[]; renamed?: { key: string; from: string; to: string }[];
} {
  const list = body?.forms;
  if (!Array.isArray(list) || !list.length) return { error: "forms must be a non-empty array" };
  const keys = list.map((f: any) => f?.key);
  if (keys.some((k: any) => typeof k !== "string" || !/^[a-z0-9-]+$/.test(k))) return { error: "品类 key 只能小写字母/数字/连字符（key = /type/{key}/ 的 URL 段）" };
  if (new Set(keys).size !== keys.length) return { error: "品类 key 重复" };
  const names = list.map((f: any) => (typeof f?.name === "string" ? f.name.trim() : ""));
  if (names.some((n: string) => !n)) return { error: "品类显示名不能为空" };
  // 显示名=产品 form 字段值（桶标识），重名会让两个品类抢同一批产品 → 必须唯一
  if (new Set(names).size !== names.length) return { error: "品类显示名重复（显示名就是产品的形态值，重了会归错桶）" };
  const oldByKey = new Map((existing || []).map((f: any) => [f.key, f.name]));
  const newKeys = new Set(keys);
  const added = keys.filter((k: string) => !oldByKey.has(k));
  const removed = [...oldByKey.keys()].filter((k) => !newKeys.has(k as string)) as string[];
  const renamed = list
    .filter((f: any) => oldByKey.has(f.key) && oldByKey.get(f.key) !== String(f.name).trim())
    .map((f: any) => ({ key: f.key, from: String(oldByKey.get(f.key)), to: String(f.name).trim() }));
  return { forms: list.map((f: any, i: number) => ({ key: f.key, name: names[i] })), added, removed, renamed };
}

// 改品类显示名 → 连带把所有引用旧值的产品 form 改成新值（契约 §3：不连带改=孤儿，官网 build integrity 闸 FAIL）。
// ⚠️ 必须扫**全部**产品文件而非只扫 manifest——manifest 只含已发布的，草稿/下架产品同样带 form，
//    漏改它们=一发布就撞白名单校验。返回 files（不 commit），由调用方与 forms.json 一起原子提交。
// 注：品类显示名只是**数据桶值**——卡片 data-form 用的是 key、chip 标签来自 chrome.json，
//    故改显示名不改任何已 built 页面，只动 products/*.json + products-index.json。
export async function formRenameFiles(env: Env, cfg: any, ctx: Ctx, renames: { from: string; to: string }[]): Promise<{ files: any[]; touched: number; scanned: number; error?: string; skipped?: any[] }> {
  const map = new Map(renames.map((r) => [r.from, r.to]));
  const files: any[] = [];
  let ids: number[] = [];
  try {
    const res = await fetch(`https://api.github.com/repos/${(env as any).GITHUB_REPO}/contents/data/products`, {
      headers: { Authorization: `Bearer ${(env as any).GITHUB_TOKEN}`, "User-Agent": "wanew-admin", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { files: [], touched: 0, scanned: 0, error: `github contents failed: ${res.status}` };
    const arr: any = await res.json();
    if (Array.isArray(arr)) ids = arr.filter((f: any) => /^\d+\.json$/.test(f.name)).map((f: any) => Number(f.name.replace(".json", "")));
  } catch (e: any) { return { files: [], touched: 0, scanned: 0, error: `github fetch error: ${String(e).slice(0, 160)}` }; }

  // 🔴 在**读那 68 个产品之前**就把账算完 —— 这一步才是超限的来源（2026-07-28 实测：
  //    读到第 39 个时 `Too many subrequests`）。上面的目录列表只花了 1 次，是算这笔账的必要代价。
  //    最坏情况：每个产品都要改（blob = scanned + forms.json + products-index）。
  const worst = ids.length + (ids.length + 2) + 5;
  const no = afford(worst, `改显示名要逐个读 ${ids.length} 个产品（含草稿/下架），再连带重写引用它的那些`);
  if (no) return { files: [], touched: 0, scanned: ids.length, error: no, budget: true } as any;

  let touched = 0;
  const skipped: any[] = [];
  for (const id of ids) {
    const raw = await readFile(env, cfg, `data/products/${id}.json`);
    // ⚠️ 这两处原本静默 continue：一个产品文件坏了 → 改品类显示名时它被跳过 →
    //    它的 form 停在旧值 → 官网 build 的 integrity-check FAIL，而 admin 报的是"改名成功"。
    //    **不是让它不跳，是让它跳得出声。**
    if (!raw) { skipped.push({ id, why: "读不到（404，但目录列表里有）" }); continue; }
    let prod: any; try { prod = JSON.parse(raw); } catch (e: any) { skipped.push({ id, why: "JSON 解析失败：" + String(e).slice(0, 80) }); continue; }
    const to = prod.form ? map.get(prod.form) : undefined;
    if (!to) continue;
    prod.form = to;
    files.push({ path: `data/products/${id}.json`, content: matchJson(raw, prod) });
    touched++;
  }
  // manifest（已发布产品的索引）同步改名
  const manifest = ctx.manifest.map((e: any) => (e.form && map.has(e.form) ? { ...e, form: map.get(e.form) } : e));
  if (JSON.stringify(manifest) !== JSON.stringify(ctx.manifest)) files.push({ path: "data/products-index.json", content: matchJson(ctx.manifestRaw, manifest) });
  return { files, touched, scanned: ids.length, skipped };
}

// 重烘焙一个类目：详情页（三语存在性）双步 + 该类目列表 + 总列表（各语种存在的）。返回 files 数组。
export async function rebakeCategory(env: Env, cfg: any, ctx: Ctx, slug: string, sink?: any[]): Promise<any[]> {
  const { template, site, locales, catalog, manifest, locDir, catmap, chrome, formKey, sizes } = ctx;
  const urlOf = (p: string, loc: string) => chrome.localizeUrl(p, loc);
  const files: any[] = [];
  // ⚠️ 返回的是裸数组、调用点用 spread —— 改返回形状要动 3 处调用点。
  //    改成**收集器传入**：跳过的信息汇到调用方手里，spread 用法一字不动。
  const skipped: any[] = sink || [];
  for (const e of manifest.filter((m: any) => m.category === slug)) {
    const raw = await readFile(env, cfg, `data/products/${e.id}.json`);
    if (!raw) { skipped.push({ id: e.id, why: "读不到（404，但 manifest 里有）" }); continue; }
    let prod: any; try { prod = JSON.parse(raw); } catch (err: any) { skipped.push({ id: e.id, why: "JSON 解析失败：" + String(err).slice(0, 80) }); continue; }
    for (const locale of locales.enabled) {
      const dir = locDir[locale];
      const rel = dir ? `${dir}/${slug}/${e.id}.html` : `${slug}/${e.id}.html`;
      if (!ctx.pagesList.has(rel)) continue;
      const related = genRelated(e, manifest, locale, catalog, urlOf);
      const html0 = render(prod, { template, imgBase: site.img_base, related, locale, modelDisplay: locales.model_display, catalog, urlOf, enabled: locales.enabled, catmap, sizes });
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
      if (h) files.push({ path: rel, content: regenListPage(h, manifest, cat, { locale, catalog, urlOf, formKey, sizes } as any) });
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
  const { locales, catalog, manifest, locDir, chrome, sizes, forms } = ctx;
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
    const h0 = renderHome(homeTpl, { locale, catalog: cat, tiles, modelDisplay: locales.model_display, urlOf, exists: pageExists, dirOf, enabled: locales.enabled, products: manifest, featured, formOrder: forms, internal_noindex: INTERNAL, sizes } as any /* 真源签名，tsc 对 js 默认参数(internal_noindex=[])推断为 never[]，同 regenListPage 走 as any */);
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
    files: files.map((f: any) => ({ path: f.path, bytes: f.content ? byteLen(f.content) : 0, ...(f.path.endsWith(".json") ? { content: f.content } : {}) })),
    locales: RENDER_SET,
  };
  const r = await commitFiles(env, cfg, files, `admin: homepage content update (${opts.email})`);
  return { ...r, files: files.map((f) => f.path) };
}

// ================= 审计日志：从 admin commit message 抽结构（纯函数·可 node 单测）=================
// admin 所有写都以 `admin: <操作> (<operator email>)` 提交官网仓 → 审计源=commit 历史里 admin: 那些。
export function parseAuditMessage(msg: string): { operator: string; operation: string; opType: string } | null {
  const line = String(msg || "").split("\n")[0];
  const m = line.match(/^admin:\s*(.+?)\s*\(([^)]*@[^)]*)\)/);   // admin: <op> (<email>)
  if (!m) return null;   // 非 admin 前缀(官网窗 commit)不进审计
  const operation = m[1].trim(), operator = m[2].trim();
  const l = operation.toLowerCase();
  const opType = /product/.test(l) ? "产品" : /homepage/.test(l) ? "首页" : /contact/.test(l) ? "联系" : /(guides|service)/.test(l) ? "攻略" : /seo meta/.test(l) ? "SEO" : /(catalog|categor|model_display)/.test(l) ? "分类" : "其它";
  return { operator, operation, opType };
}

// ================= 阶段B：联系方式（data/contact-info.json 语言无关值）=================
// 编辑 11 个语言无关值 → renderPage(config=contact-info) 重烘焙 /contact/ 页×locales + 双步 applyChrome
// → 一个原子 commit（contact-info.json + contact/index.html×RENDER_SET）。镜像 regen.mjs 的 page 循环
// （catalog:{...chrome,...shared,...contact.json 标签}, config: contactCfg, path:"/contact/"）。
// ⚠️ 标签(contact.json)是官网维护的 i18n，本编辑器不碰；只改语言无关值。Pages 只 serve 预烘焙 HTML，
// 故必须自己 renderPage 重烘焙、不能只写 json（同首页 CMS）。
export interface ContactEdit { key: string; value: string; }
// ⚠️ 这份白名单管的是「**什么能被编辑**」，不是「什么能活下来」—— 见 publishContact 里的深拷贝：
//    不在名单里的键**照样留在文件里**，只是改不动。（产品 JSON 那份白名单语义相反，见 docs/contracts/。）
//    所以摘掉一个键 = 从此没有任何入口能改它，**包括 API** —— 这正是要的：控件摘了而端点还收，
//    就留下一条只有 API 能走的暗路，照样能往一个官网不消费的字段里写值。
// ⚠️ 没有 hours / response：官网联系页不消费（模板中 `cfg.hours` 唯一一处在 HTML 注释里）。
//    要恢复必须**先让官网模板真的消费**，再加回这里。
export const CONTACT_KEYS = ["phone_display", "phone_tel", "whatsapp", "whatsapp_link", "wechat_id", "wechat_qr", "email", "address", "map_link"];

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
    files: files.map((f: any) => ({ path: f.path, bytes: f.content ? byteLen(f.content) : 0, ...(f.path.endsWith(".json") ? { content: f.content } : {}) })),
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
    files: files.map((f: any) => ({ path: f.path, bytes: f.content ? byteLen(f.content) : 0, ...(f.path.endsWith(".json") ? { content: f.content } : {}) })),
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
  if (opts.dryRun) return { dry: true, previewHtml: enPage ? enPage.content : null, files: files.map((f: any) => ({ path: f.path, bytes: f.content ? byteLen(f.content) : 0, ...(f.path.endsWith(".json") ? { content: f.content } : {}) })), locales: RENDER_SET };
  const r = await commitFiles(env, cfg, files, `admin: SEO meta update ${slug} (${opts.email})`);
  return { ...r, files: files.map((f) => f.path) };
}
