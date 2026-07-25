// #52 产品后台一期 —— wanew-admin worker 骨架（批1b）。
// 批2 在此之上加：产品 CRUD（运行时 regen+原子 commit，继承 functions/api/admin/[[path]].js 骨架）、
// 类目/机型管理端点、R2 直传。批3 加电商风 UI。
import { Hono } from "hono";

export interface Env {
  ASSETS: Fetcher;
  IMAGES: R2Bucket;
  IMG_BASE: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  GITHUB_TOKEN?: string;      // secret（Joe 的 fine-grained PAT，Contents RW 限 zq8345/Wanew）
  DEV_BYPASS_AUTH?: string;   // 仅 .dev.vars：本地免 Access（生产无此变量）
}

const app = new Hono<{ Bindings: Env }>();

// ---- M4 fail-closed auth（照获客后台标准）----
// admin.wanew.com 在 Cloudflare Access（wanew-admin 应用，已预挂）背后：未登录请求边缘就被拦；
// 到达 Worker 的请求必须带 Cf-Access-Authenticated-User-Email —— 没有 = 不明来路（如误开 workers.dev
// 或 Access 配置被撤），一律 403。**没有 Basic Auth 兜底 = 故意的**：这后台能 commit 代码仓，
// 兜底口就是后门。本地开发走 DEV_BYPASS_AUTH（.dev.vars 独有）。
app.use("*", async (c, next) => {
  if (c.env.DEV_BYPASS_AUTH === "1") return next();
  const email = c.req.header("cf-access-authenticated-user-email");
  if (!email) return c.text("此后台需通过 Cloudflare Access 登录（wanew-admin 应用）。", 403);
  return next();
});

// ---- 进程身份（dev-process-identity 铁律：任何联调先证打到的是谁）----
app.get("/api/_whoami", (c) =>
  c.json({
    app: "wanew-admin",
    repo: c.env.GITHUB_REPO,
    imgBase: c.env.IMG_BASE,
    operator: c.req.header("cf-access-authenticated-user-email") || null,   // Access 邮箱=操作人标识
    ghTokenConfigured: !!c.env.GITHUB_TOKEN,   // 只报有无，绝不报值
  })
);

// 健康端点（生产快照第一查）
app.get("/api/health", (c) => c.json({ ok: true }));

// ================= 批2-2：产品 CRUD（双步三语，继承 [[path]].js 骨架） =================
// 写路径全部走 loadCtx（GitHub 读真源）→ validate(merge) → publish/unpublish（原子 commit）。
// GITHUB_TOKEN 未配时 503 fail-closed（批4 接线前 dry 联调用 /api/admin/preview）。
import { loadCtx, validateProduct, publishProduct, unpublishProduct, validateCategories, rebakeCategory, publishHomepage } from "./publish";
import type { HomeEdit } from "./publish";
// @ts-ignore js 模块
import { ghConfig, readFile, commitFiles } from "../vendor/github.js";
// @ts-ignore js 模块 —— FORM_KEY = 形态/品类轴 slug 真源（render.js，守卫盯字节；本仓只读镜像）
import { FORM_KEY } from "../vendor/render.js";

const operator = (c: any) => c.req.header("cf-access-authenticated-user-email") || "dev-bypass";

app.get("/api/admin/products", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const raw = await readFile(c.env, cfg, "data/products-index.json");
  const list = raw ? JSON.parse(raw) : [];
  return c.json({ products: list, count: list.length, admin: operator(c) });
});

app.get("/api/admin/products/:id", async (c) => {
  const id = c.req.param("id").replace(/\D/g, "");
  if (!id) return c.json({ error: "bad id" }, 400);
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const raw = await readFile(c.env, cfg, `data/products/${id}.json`);
  if (!raw) return c.json({ error: "not found" }, 404);
  return c.json(JSON.parse(raw));
});

// 上传：R2 直传，返回 key（产品 images[].key），URL = IMG_BASE(img.wanew.com)+key
app.post("/api/admin/upload", async (c) => {
  const name = c.req.query("name") || "image";
  const ext = (name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return c.json({ error: "unsupported image type" }, 400);
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "empty body" }, 400);
  if (buf.byteLength > 8 * 1024 * 1024) return c.json({ error: "image exceeds 8MB" }, 413);
  const key = `u_file/uploads/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await c.env.IMAGES.put(key, buf, { httpMetadata: { contentType: c.req.header("content-type") || "application/octet-stream" } });
  return c.json({ ok: true, key, url: c.env.IMG_BASE + key });
});

// 创建（新 id=max+1；新品只建默认 locale——渲染内容不决定 site map）
app.post("/api/admin/products", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  const newId = ctx.manifest.reduce((m: number, e: any) => Math.max(m, e.id), 0) + 1;
  const v = validateProduct(body, newId, ctx.categories, null);
  if (v.error) return c.json({ error: v.error }, 400);
  try {
    const r = await publishProduct(c.env, cfg, ctx, v.prod, { isNew: true, email: operator(c) });
    if ((r as any).error) return c.json(r as any, 502);
    return c.json({ ok: true, id: newId, ...r, note: "created; Pages deploys in ~1 min" });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// 编辑（⭐merge：旧 json 打底防翻译擦除；oldCategory 联动列表）
app.put("/api/admin/products/:id", async (c) => {
  const id = Number(c.req.param("id").replace(/\D/g, ""));
  if (!id) return c.json({ error: "bad id" }, 400);
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  const oldRaw = await readFile(c.env, cfg, `data/products/${id}.json`);
  const existing = oldRaw ? JSON.parse(oldRaw) : null;
  if (!existing) return c.json({ error: "not found" }, 404);
  const v = validateProduct(body, id, ctx.categories, existing);
  if (v.error) return c.json({ error: v.error }, 400);
  try {
    const r = await publishProduct(c.env, cfg, ctx, v.prod, { isNew: false, oldCategory: existing.category, email: operator(c) });
    if ((r as any).error) return c.json(r as any, 502);
    return c.json({ ok: true, ...r, note: "updated; Pages deploys in ~1 min" });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// 删除（三语详情一并删 + 列表 regen）
app.delete("/api/admin/products/:id", async (c) => {
  const id = Number(c.req.param("id").replace(/\D/g, ""));
  if (!id) return c.json({ error: "bad id" }, 400);
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  try {
    const r = await unpublishProduct(c.env, cfg, ctx, id, { email: operator(c) });
    if ((r as any).notFound) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, ...r, note: "deleted; Pages deploys in ~1 min" });
  } catch (e: any) { return c.json({ error: "delete failed", detail: String(e).slice(0, 300) }, 502); }
});

// ================= 批2-3：类目/机型管理（一期：slug 集合不可变，display/顺序可改） =================
app.get("/api/admin/categories", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const raw = await readFile(c.env, cfg, "data/categories.json");
  if (!raw) return c.json({ error: "categories.json missing（本链 push 后可用）" }, 404);
  return c.json(JSON.parse(raw));
});

app.put("/api/admin/categories", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  const v = validateCategories(body, ctx.categories);
  if (v.error) return c.json({ error: v.error }, 400);
  // display 变更的类目 → 重烘焙；纯顺序变更只落 json（首页瓦片顺序随下次本地管线——诚实边界）
  const oldMap: Record<string,string> = {}; for (const cc of ctx.categories.categories) oldMap[cc.slug] = cc.display;
  const changed = v.cats.categories.filter((cc: any) => oldMap[cc.slug] !== cc.display).map((cc: any) => cc.slug);
  const files: any[] = [{ path: "data/categories.json", content: JSON.stringify(v.cats, null, 2) + "\n" }];
  try {
    const ctx2 = { ...ctx, categories: v.cats, catmap: Object.fromEntries(v.cats.categories.map((cc: any) => [cc.slug, cc.display])) };
    for (const slug of changed) files.push(...await rebakeCategory(c.env, cfg, ctx2 as any, slug));
    const r = await (await import("../vendor/github.js") as any).commitFiles(c.env, cfg, files, `admin: categories update (${operator(c)})`);
    return c.json({ ok: true, rebaked: changed, filesWritten: files.length, note: changed.length ? "display 变更类目已重烘焙" : "仅顺序/无实质变更——首页瓦片顺序随下次本地管线", ...r });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

app.get("/api/admin/models", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const raw = await readFile(c.env, cfg, "data/locales.json");
  if (!raw) return c.json({ error: "locales.json missing" }, 404);
  return c.json({ model_display: JSON.parse(raw).model_display || {} });
});

app.put("/api/admin/models", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const md = body?.model_display;
  if (!md || typeof md !== "object" || Array.isArray(md)) return c.json({ error: "model_display must be an object" }, 400);
  if (Object.values(md).some((x) => typeof x !== "string" || !(x as string).trim())) return c.json({ error: "model names must be non-empty strings" }, 400);
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  // ⭐ merge 式写：只动 model_display 字段，locales.json 其余（enabled/default/dir…i18n 命脉）原样
  const rawLoc = await readFile(c.env, cfg, "data/locales.json");
  const loc = JSON.parse(rawLoc!);
  const oldMd = loc.model_display || {};
  // 键集不可变（键=类目 slug 契约；增删=二期）
  const kOld = Object.keys(oldMd).sort().join(","), kNew = Object.keys(md).sort().join(",");
  if (kOld !== kNew) return c.json({ error: `一期 model_display 键集不可变。旧=[${kOld}] 新=[${kNew}]` }, 400);
  const changed = Object.keys(md).filter((k) => oldMd[k] !== md[k]);
  loc.model_display = md;
  const files: any[] = [{ path: "data/locales.json", content: JSON.stringify(loc, null, 2) + "\n" }];
  try {
    const ctx2 = { ...ctx, locales: loc };
    for (const slug of changed) if (ctx.catmap[slug] !== undefined) files.push(...await rebakeCategory(c.env, cfg, ctx2 as any, slug));
    const r = await (await import("../vendor/github.js") as any).commitFiles(c.env, cfg, files, `admin: model_display update (${operator(c)})`);
    return c.json({ ok: true, rebaked: changed, filesWritten: files.length, ...r });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// 🧪 dry 预览（批4 接线前的联调闸）：跑完整 validate+双步渲染，**不 commit**，
// 返回将写文件清单 + 每页 chrome 注入结果摘要——本地就能端到端验双步管线。
app.post("/api/admin/preview/:id", async (c) => {
  const id = Number(c.req.param("id").replace(/\D/g, ""));
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  const oldRaw = await readFile(c.env, cfg, `data/products/${id}.json`);
  const existing = oldRaw ? JSON.parse(oldRaw) : null;
  const v = validateProduct(body, id, ctx.categories, existing);
  if (v.error) return c.json({ error: v.error }, 400);
  // 批3：单真源化——直接调 publishProduct(dryRun) 走同一条管线到 commit 前一步
  // （原内联第二实现已删：thumb 简化造成与真发布路径 361~590B/页 字节差，违单真源铁律）。
  const r: any = await publishProduct(c.env, cfg, ctx, v.prod, { isNew: !existing, oldCategory: existing?.category, email: operator(c), dryRun: true });
  if (r.error) return c.json(r, 502);
  return c.json({ ...r, merged_i18n_locales: Object.keys(v.prod.i18n) });
});

// ================= W5 P1：首页内容 CMS =================
// GET 读 home.json 现值(表单回填)；PUT 保存编辑 → publishHomepage(regen 首页 + 双步 applyChrome) → 原子 commit。
// body.dryRun=true → dryRun 预览(返回 previewHtml + 将写文件、不提交)——安全红线:提交前 diff/渲染预览。
app.get("/api/admin/homepage", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const [raw, featRaw] = await Promise.all([
    readFile(c.env, cfg, "data/pages/home.json"),
    readFile(c.env, cfg, "data/pages/home-featured.json"),
  ]);
  if (!raw) return c.json({ error: "home.json missing" }, 404);
  return c.json({ home: JSON.parse(raw), featured: featRaw ? (JSON.parse(featRaw).ids || []) : [] });
});

app.put("/api/admin/homepage", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  // edits(文案) 和/或 featured(精选产品 id 数组) —— publishHomepage 校验"至少一个"
  if (body?.edits !== undefined && !Array.isArray(body.edits)) return c.json({ error: "edits must be an array" }, 400);
  if (body?.featured !== undefined && body.featured !== null && !Array.isArray(body.featured)) return c.json({ error: "featured must be an array or null" }, 400);
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  try {
    const r: any = await publishHomepage(c.env, cfg, ctx, { edits: body.edits as HomeEdit[] | undefined, featured: body.featured }, { email: operator(c), dryRun: !!body.dryRun });
    if (r.error) return c.json(r, 502);
    return c.json({ ok: true, ...r, note: r.dry ? "dry preview" : "homepage updated; Pages deploys in ~1 min" });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// ================= W5 P4：媒体库（R2 浏览/标签/删除；走 R2 域、不碰 data/pages/=与官网信息页迁移零撞车）=================
// 标签(clean 干净产品图 / marketing 营销拼图)存 R2 内 _meta/media-index.json(键→tag)——不加 D1、不写官网仓。
const MEDIA_META = "_meta/media-index.json";
async function loadMediaTags(env: Env): Promise<Record<string, string>> {
  const obj = await env.IMAGES.get(MEDIA_META);
  if (!obj) return {};
  try { return JSON.parse(await obj.text()); } catch { return {}; }
}
async function saveMediaTags(env: Env, tags: Record<string, string>) {
  await env.IMAGES.put(MEDIA_META, JSON.stringify(tags), { httpMetadata: { contentType: "application/json" } });
}

// 列 R2 对象(分页抽干、上限保护) + 合并标签 + 对外 URL(img.wanew.com)
app.get("/api/admin/media", async (c) => {
  const tags = await loadMediaTags(c.env);
  const fm = await loadFolders(c.env);
  const items: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await c.env.IMAGES.list({ limit: 1000, cursor });
    for (const o of res.objects) {
      if (o.key === MEDIA_META || o.key === MEDIA_FOLDERS) continue;
      items.push({ key: o.key, size: o.size, uploaded: o.uploaded, url: c.env.IMG_BASE + o.key, tag: tags[o.key] || "", folder: fm.assign[o.key] || "" });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor && items.length < 5000);
  items.sort((a, b) => ((b.uploaded && b.uploaded.getTime ? b.uploaded.getTime() : 0) - (a.uploaded && a.uploaded.getTime ? a.uploaded.getTime() : 0)));
  return c.json({ media: items, count: items.length, folders: fm.folders });
});

// 打标签(clean|marketing|空=清标签)——写 _meta/media-index.json
app.put("/api/admin/media/tag", async (c) => {
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const key = String(body?.key || ""), tag = String(body?.tag || "");
  if (!key || key === MEDIA_META) return c.json({ error: "bad key" }, 400);
  if (tag && !["clean", "marketing"].includes(tag)) return c.json({ error: "tag must be clean|marketing|empty" }, 400);
  const tags = await loadMediaTags(c.env);
  if (tag) tags[key] = tag; else delete tags[key];
  await saveMediaTags(c.env, tags);
  return c.json({ ok: true, key, tag });
});

// 删除 R2 对象(前端强 confirm；⚠️ 删被产品引用的图会裂详情页——前端提示，Joe 定)
app.delete("/api/admin/media", async (c) => {
  const key = c.req.query("key") || "";
  if (!key || key === MEDIA_META) return c.json({ error: "bad key" }, 400);
  await c.env.IMAGES.delete(key);
  const tags = await loadMediaTags(c.env);
  if (tags[key] !== undefined) { delete tags[key]; await saveMediaTags(c.env, tags); }
  // 顺手清文件夹归属（图没了归属也该没）
  const fm = await loadFolders(c.env);
  if (fm.assign[key] !== undefined) { delete fm.assign[key]; await saveFolders(c.env, fm); }
  return c.json({ ok: true, deleted: key });
});

// ---- 文件夹（W5 P5+·Joe 反馈③）：纯元数据，不移动 R2 对象、不删图 ----
// _meta/media-folders.json = { folders:[名称], assign:{ key: 文件夹名 } }。key 无归属=未归类。
const MEDIA_FOLDERS = "_meta/media-folders.json";
type FoldersMeta = { folders: string[]; assign: Record<string, string> };
async function loadFolders(env: Env): Promise<FoldersMeta> {
  const obj = await env.IMAGES.get(MEDIA_FOLDERS);
  if (!obj) return { folders: [], assign: {} };
  try { const j: any = JSON.parse(await obj.text()); return { folders: Array.isArray(j.folders) ? j.folders : [], assign: (j.assign && typeof j.assign === "object") ? j.assign : {} }; }
  catch { return { folders: [], assign: {} }; }
}
async function saveFolders(env: Env, m: FoldersMeta) {
  await env.IMAGES.put(MEDIA_FOLDERS, JSON.stringify(m), { httpMetadata: { contentType: "application/json" } });
}

// 新建文件夹
app.post("/api/admin/media/folders", async (c) => {
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const name = String(body?.name || "").trim();
  if (!name) return c.json({ error: "文件夹名不能为空" }, 400);
  if (name.length > 40) return c.json({ error: "文件夹名过长（≤40）" }, 400);
  if (/[\/\\]/.test(name)) return c.json({ error: "文件夹名不能含斜杠" }, 400);
  const m = await loadFolders(c.env);
  if (m.folders.includes(name)) return c.json({ error: "同名文件夹已存在" }, 400);
  m.folders.push(name); await saveFolders(c.env, m);
  return c.json({ ok: true, folders: m.folders });
});

// 删除文件夹（只删归类元数据，图片一律保留、退回未归类）
app.delete("/api/admin/media/folders", async (c) => {
  const name = c.req.query("name") || "";
  if (!name) return c.json({ error: "bad name" }, 400);
  const m = await loadFolders(c.env);
  m.folders = m.folders.filter((f) => f !== name);
  let unassigned = 0;
  for (const k of Object.keys(m.assign)) if (m.assign[k] === name) { delete m.assign[k]; unassigned++; }
  await saveFolders(c.env, m);
  return c.json({ ok: true, folders: m.folders, unassigned });
});

// 把图片归入文件夹（folder=空=退回未归类）——纯元数据，不动 R2 对象
app.put("/api/admin/media/folder", async (c) => {
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const key = String(body?.key || ""), folder = String(body?.folder || "");
  if (!key || key === MEDIA_META) return c.json({ error: "bad key" }, 400);
  const m = await loadFolders(c.env);
  if (folder && !m.folders.includes(folder)) return c.json({ error: "文件夹不存在" }, 400);
  if (folder) m.assign[key] = folder; else delete m.assign[key];
  await saveFolders(c.env, m);
  return c.json({ ok: true, key, folder });
});

// 批量归类（Joe②：多选一次性移入/退回）——一次读写，比逐张 PUT 省往返
app.put("/api/admin/media/folder-batch", async (c) => {
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const keys: string[] = Array.isArray(body?.keys) ? body.keys.filter((k: any) => typeof k === "string" && k && k !== MEDIA_META) : [];
  const folder = String(body?.folder || "");
  if (!keys.length) return c.json({ error: "keys 不能为空" }, 400);
  const m = await loadFolders(c.env);
  if (folder && !m.folders.includes(folder)) return c.json({ error: "文件夹不存在" }, 400);
  for (const key of keys) { if (folder) m.assign[key] = folder; else delete m.assign[key]; }
  await saveFolders(c.env, m);
  return c.json({ ok: true, count: keys.length, folder });
});

// ================= Joe③：分类增删（catalog.json 统一真源 · admin 侧）=================
// ⚠️ 现阶段 INERT：官网 render.js/regen.mjs 仍硬编码，未读 catalog.json → admin 写了站上不变。
// 官网 Stage A 后按契约把 render 改成读 catalog.json，两边同 release 才生效。
// 种子=现 7 机型(categories.json+model_display) + 5 品类(FORM_KEY)逐字节等价。slug 建后不可变。
const CATALOG_FILE = "data/catalog.json";
function slugify(name: string): string {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// 从现源合成种子（catalog.json 不存在时）——models 顺序=categories.json 顺序（=CATS 页面顺序）
// aggregates=performance-gen-2 聚合页（model_display 有但非类目）：§2.4a 放 catalog 保持单一真源。
function seedCatalog(catsJson: any, locJson: any): { models: any[]; types: any[]; aggregates: any[] } {
  const md = (locJson && locJson.model_display) || {};
  const catSlugs = new Set(((catsJson && catsJson.categories) || []).map((c: any) => c.slug));
  const models = ((catsJson && catsJson.categories) || []).map((c: any, i: number) => ({ slug: c.slug, name: c.display, detailName: md[c.slug] || c.display, order: i }));
  const types = Object.entries(FORM_KEY as Record<string, string>).map(([name, slug], i) => ({ slug, name, order: i }));
  const aggregates: any[] = [];
  // 在 model_display 但不在 categories 的键=聚合页（现仅 performance-gen-2=gen-1+gen-3）
  if (md["performance-gen-2"] && !catSlugs.has("performance-gen-2")) aggregates.push({ slug: "performance-gen-2", detailName: md["performance-gen-2"], of: ["performance-gen-1", "performance-gen-3"] });
  return { models, types, aggregates };
}
app.get("/api/admin/catalog", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const [catalogRaw, prodRaw, catsRaw, locRaw] = await Promise.all([
    readFile(c.env, cfg, CATALOG_FILE),
    readFile(c.env, cfg, "data/products-index.json"),
    readFile(c.env, cfg, "data/categories.json"),
    readFile(c.env, cfg, "data/locales.json"),
  ]);
  const products: any[] = prodRaw ? JSON.parse(prodRaw) : [];
  let cat: { models: any[]; types: any[]; aggregates: any[] }; let exists = false;
  if (catalogRaw) { try { const j = JSON.parse(catalogRaw); cat = { models: j.models || [], types: j.types || [], aggregates: j.aggregates || [] }; exists = true; } catch { cat = seedCatalog(catsRaw ? JSON.parse(catsRaw) : {}, locRaw ? JSON.parse(locRaw) : {}); } }
  else cat = seedCatalog(catsRaw ? JSON.parse(catsRaw) : {}, locRaw ? JSON.parse(locRaw) : {});
  // 产品计数（删除护栏用）：model 按 p.category，type 按 p.form
  const byModel: Record<string, number> = {}, byType: Record<string, number> = {};
  for (const p of products) { byModel[p.category] = (byModel[p.category] || 0) + 1; if (p.form) byType[p.form] = (byType[p.form] || 0) + 1; }
  // exists=官网已落 catalog.json（随 render 迁移 release 一起落）→ 可保存生效；否则=预览、admin 不抢先写
  return c.json({ models: cat.models, types: cat.types, aggregates: cat.aggregates, exists, counts: { byModel, byType }, note: exists ? "catalog.json 已生效——保存经官网 render 生成。" : "预览：官网尚未落 catalog.json（Stage A 后随 render 迁移 release 落种子）。此处增删暂不可保存，admin 不抢先写以免搅浑 byte-equiv 基线。" });
});
app.put("/api/admin/catalog", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  // 🚧 gate：catalog.json 必须已由官网 release 落地才允许 admin 写——不抢先写以免搅浑 byte-equiv 基线
  const existingRaw = await readFile(c.env, cfg, CATALOG_FILE);
  if (!existingRaw) return c.json({ error: "catalog.json 尚未由官网落地。Stage A 后官网随 render 迁移 release 落种子，届时此处才可保存。admin 不抢先写。", notLanded: true }, 409);
  let existing: any = {}; try { existing = JSON.parse(existingRaw); } catch {}
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const models = Array.isArray(body?.models) ? body.models : null;
  const types = Array.isArray(body?.types) ? body.types : null;
  if (!models || !types) return c.json({ error: "models / types 必须是数组" }, 400);
  // 校验：slug 合法+唯一、name 非空
  const chk = (arr: any[], label: string, extra?: (x: any) => string | null): string | null => {
    const seen = new Set<string>();
    for (const x of arr) {
      if (!x || typeof x.slug !== "string" || !/^[a-z0-9-]+$/.test(x.slug)) return `${label} slug 非法：${JSON.stringify(x?.slug)}（仅 a-z 0-9 -）`;
      if (seen.has(x.slug)) return `${label} slug 重复：${x.slug}`;
      seen.add(x.slug);
      if (typeof x.name !== "string" || !x.name.trim()) return `${label} 显示名不能为空（slug=${x.slug}）`;
      if (extra) { const e = extra(x); if (e) return e; }
    }
    return null;
  };
  const err = chk(models, "机型", (x) => (typeof x.detailName === "string" && x.detailName.trim() ? null : `机型 detailName 不能为空（slug=${x.slug}）`)) || chk(types, "品类");
  if (err) return c.json({ error: err }, 400);
  // aggregates=聚合页（phase-1 UI 只读，不在此编辑）：保留 body 传回的、否则沿用现有，别丢
  const aggregates = Array.isArray(body?.aggregates) ? body.aggregates : (Array.isArray(existing.aggregates) ? existing.aggregates : []);
  const norm = {
    models: models.map((m: any, i: number) => ({ slug: m.slug, name: m.name.trim(), detailName: m.detailName.trim(), order: i })),
    types: types.map((t: any, i: number) => ({ slug: t.slug, name: t.name.trim(), order: i })),
    aggregates,
  };
  try {
    const r = await commitFiles(c.env, cfg, [{ path: CATALOG_FILE, content: JSON.stringify(norm, null, 2) + "\n" }], `admin: catalog.json update (${operator(c)})`);
    return c.json({ ok: true, ...r, note: "已写 data/catalog.json。经官网 render 生成后站上生效。" });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// ================= W5 P5：仪表盘（只读概览，零写入零撞车；admin 默认落地页）=================
app.get("/api/admin/dashboard", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const [prodRaw, catRaw, featRaw, locRaw] = await Promise.all([
    readFile(c.env, cfg, "data/products-index.json"),
    readFile(c.env, cfg, "data/categories.json"),
    readFile(c.env, cfg, "data/pages/home-featured.json"),
    readFile(c.env, cfg, "data/locales.json"),
  ]);
  const products: any[] = prodRaw ? JSON.parse(prodRaw) : [];
  const categories: any[] = catRaw ? (JSON.parse(catRaw).categories || []) : [];
  const models = locRaw ? Object.keys(JSON.parse(locRaw).model_display || {}) : [];
  const featuredIds: number[] = featRaw ? (JSON.parse(featRaw).ids || []) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const featured = featuredIds.map((id) => byId.get(id)).filter(Boolean).map((p: any) => ({ id: p.id, title: p.title, thumb: p.thumb, category: p.category }));
  const byCat: Record<string, number> = {};
  for (const p of products) byCat[p.category] = (byCat[p.category] || 0) + 1;
  // 形态分布（FORM_KEY 代码顺序；display=form 字符串）
  const formCount: Record<string, number> = {};
  for (const p of products) { const f = p.form || ""; if (f) formCount[f] = (formCount[f] || 0) + 1; }
  const byForm = Object.keys(FORM_KEY as Record<string, string>).map((form) => ({ form, count: formCount[form] || 0 }));
  const formsCount = Object.keys(FORM_KEY as Record<string, string>).length;
  // 媒体数（R2 count，best-effort）
  let mediaCount = 0;
  try {
    let cur: string | undefined;
    do { const res: any = await c.env.IMAGES.list({ limit: 1000, cursor: cur }); mediaCount += res.objects.filter((o: any) => o.key !== MEDIA_META).length; cur = res.truncated ? res.cursor : undefined; } while (cur && mediaCount < 20000);
  } catch {}
  // 最近活动时间线（GitHub commits API 仓库级最近 6 条，best-effort、只读）
  let activity: any[] = [];
  try {
    const res = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/commits?per_page=6`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, "User-Agent": "wanew-admin", Accept: "application/vnd.github+json" },
    });
    if (res.ok) { const arr: any = await res.json(); if (Array.isArray(arr)) activity = arr.map((x: any) => ({ sha: String(x.sha).slice(0, 7), date: x.commit?.committer?.date || null, message: (x.commit?.message || "").split("\n")[0] })); }
  } catch {}
  const lastHome = activity[0] || null;   // 兼容旧字段
  return c.json({ products: products.length, categories: categories.length, models: models.length, formsCount, mediaCount, byCat, byForm, featured, imgBase: c.env.IMG_BASE, activity, lastHome, repo: c.env.GITHUB_REPO });
});

// ================= W5 P5：设置（品牌/口径只读对齐，零写入零撞车）=================
// 纯展示当前运行口径——发布目标仓/分支、图床域、locale 集（enabled∪render_extra=RENDER_SET）、
// 操作人、GITHUB_TOKEN 有无（永不报值）。改这些口径是 i18n/部署命脉，只能改 repo 配置，不在后台开写口。
app.get("/api/admin/settings", async (c) => {
  const cfg = ghConfig(c.env);
  const locRaw = cfg ? await readFile(c.env, cfg, "data/locales.json") : null;
  const loc = locRaw ? JSON.parse(locRaw) : {};
  const enabled: string[] = Array.isArray(loc.enabled) ? loc.enabled : [];
  const renderExtra: string[] = Array.isArray(loc.render_extra) ? loc.render_extra : [];
  const renderSet = Array.from(new Set([...enabled, ...renderExtra]));
  return c.json({
    repo: c.env.GITHUB_REPO,
    branch: c.env.GITHUB_BRANCH,
    imgBase: c.env.IMG_BASE,
    operator: c.req.header("cf-access-authenticated-user-email") || "dev-bypass",
    ghTokenConfigured: !!c.env.GITHUB_TOKEN,   // 只报有无，绝不报值
    locales: { enabled, default: loc.default || null, renderExtra, renderSet },
  });
});

// ================= W5 P5+：品类/形态轴（只读；display/slug/顺序定义在 render.js 代码，非可编辑数据）=================
// ⚠️ 机型轴=categories.json(可编辑) vs 形态轴=FORM_KEY(render.js 代码真源)+产品内联 p.form 字符串。
// 无 forms.json → 改形态显示名/顺序须重构官网 render(碰官网仓)。此端点只读展示：形态显示名/slug/产品数。
app.get("/api/admin/forms", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const raw = await readFile(c.env, cfg, "data/products-index.json");
  const products: any[] = raw ? JSON.parse(raw) : [];
  const count: Record<string, number> = {};
  for (const p of products) { const f = p.form || ""; count[f] = (count[f] || 0) + 1; }
  // FORM_KEY 顺序=代码真源顺序（形态显示名 → slug）
  const known = Object.entries(FORM_KEY as Record<string, string>).map(([form, slug]) => ({ form, slug, count: count[form] || 0 }));
  // 孤儿：产品有 form 值但不在 FORM_KEY（未映射 slug=列表页筛不出）——吼出来
  const knownForms = new Set(Object.keys(FORM_KEY as Record<string, string>));
  const orphans = Object.keys(count).filter((f) => f && !knownForms.has(f)).map((f) => ({ form: f, slug: "", count: count[f] }));
  return c.json({ forms: known, orphans, editable: false, note: "形态轴 slug/顺序定义在 render.js(FORM_KEY)，显示名=产品内联 form 字段。可编辑需 forms.json 重构官网 render。" });
});

// run_worker_first=true 时 Worker 先跑：未匹配的路由必须**显式**回落静态资源
// （骨架首 boot 实测 / 404 抓出来的——Hono 不会自动帮你转 ASSETS）。auth 中间件在前=静态页同样在门后。
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
