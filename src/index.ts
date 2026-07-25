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
import { ghConfig, readFile } from "../vendor/github.js";

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
  const items: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await c.env.IMAGES.list({ limit: 1000, cursor });
    for (const o of res.objects) {
      if (o.key === MEDIA_META) continue;
      items.push({ key: o.key, size: o.size, uploaded: o.uploaded, url: c.env.IMG_BASE + o.key, tag: tags[o.key] || "" });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor && items.length < 5000);
  items.sort((a, b) => ((b.uploaded && b.uploaded.getTime ? b.uploaded.getTime() : 0) - (a.uploaded && a.uploaded.getTime ? a.uploaded.getTime() : 0)));
  return c.json({ media: items, count: items.length });
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
  return c.json({ ok: true, deleted: key });
});

// run_worker_first=true 时 Worker 先跑：未匹配的路由必须**显式**回落静态资源
// （骨架首 boot 实测 / 404 抓出来的——Hono 不会自动帮你转 ASSETS）。auth 中间件在前=静态页同样在门后。
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
