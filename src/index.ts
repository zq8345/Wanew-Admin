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
  GSC_SA_KEY?: string;        // secret（GSC 服务账号 JSON，Joe 已存；只读、绝不回显）
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
import { loadCtx, validateProduct, publishProduct, unpublishProduct, publishBulk, validateCategories, validateForms, formRenameFiles, rebakeCategory, publishHomepage, publishContact, CONTACT_KEYS, publishService, SERVICE_META_KEYS, SERVICE_CARDS, publishPageMeta, SEO_PAGES, parseAuditMessage } from "./publish";
import type { HomeEdit, ContactEdit, ServiceEdit, SeoEdit } from "./publish";
// @ts-ignore js 模块
import { ghConfig, readFile } from "../vendor/github.js";
// @ts-ignore js 模块（守卫盯字节；本仓只读镜像）。⚠️ 形态/品类轴 slug 真源已从 render.js 的
// FORM_KEY 常量迁到 data/forms.json（#52 block2，官网删了该 export、改 formKey 穿参）。
import { resolveImg } from "../vendor/render.js";
import { gscQuery } from "./gsc";

const operator = (c: any) => c.req.header("cf-access-authenticated-user-email") || "dev-bypass";

app.get("/api/admin/products", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const raw = await readFile(c.env, cfg, "data/products-index.json");
  const list = raw ? JSON.parse(raw) : [];
  return c.json({ products: list, count: list.length, admin: operator(c) });
});

// ⚠️ 必须在 /products/:id 之前定义（否则 "bulk"/"drafts" 被 :id 捕获，Hono 按序匹配）。
// P0-3 批量编辑：一次 commit 改多产品的 status/category/form（publishBulk 累积 files）。
app.put("/api/admin/products/bulk", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
  const op = body?.op, value = body?.value;
  if (!ids.length) return c.json({ error: "ids 不能为空" }, 400);
  if (!["status", "category", "form"].includes(op)) return c.json({ error: "op must be status|category|form" }, 400);
  if (ids.length > 200) return c.json({ error: "单次批量上限 200" }, 400);
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  try {
    const r: any = await publishBulk(c.env, cfg, ctx, ids, op, value ?? "", { email: operator(c) });
    if (r.error) return c.json(r, 502);
    return c.json({ ok: true, ...r, note: `bulk ${op} ${r.count} products; Pages deploys in ~1 min` });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// 非发布产品列表（draft/archived）：Contents API 列 data/products/ → 不在 index 的 → 读 status/标题。
app.get("/api/admin/products/drafts", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  const published = new Set<number>(ctx.manifest.map((e: any) => e.id));
  let ids: number[] = [];
  try {
    const res = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/contents/data/products`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, "User-Agent": "wanew-admin", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return c.json({ error: "github contents failed", status: res.status }, 502);
    const arr: any = await res.json();
    if (Array.isArray(arr)) ids = arr.filter((f: any) => /^\d+\.json$/.test(f.name)).map((f: any) => Number(f.name.replace(".json", "")));
  } catch (e: any) { return c.json({ error: "github fetch error", detail: String(e).slice(0, 200) }, 502); }
  const nonPub = ids.filter((id) => !published.has(id)).slice(0, 300);
  const drafts = (await Promise.all(nonPub.map(async (id) => {
    const raw = await readFile(c.env, cfg, `data/products/${id}.json`);
    if (!raw) return null;
    let p: any; try { p = JSON.parse(raw); } catch { return null; }
    return { id, status: p.status || "draft", category: p.category, form: p.form || null, title: (p.i18n?.en?.title) || `#${id}`, thumb: p.images?.[0] ? resolveImg(p.images[0], ctx.site.img_base) : "" };
  }))).filter(Boolean);
  return c.json({ drafts, count: drafts.length });
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
  // 可选强制 key：仅允许"视频封面"命名(<视频base>.poster.webp)，用于视频库上传时把封面钉到视频同 base
  // → 封面 = 命名约定派生(videoKey.replace .mp4→.poster.webp)、无需元数据表；图片库按此后缀过滤掉封面。
  const forced = c.req.query("key");
  // 派生资产的强制 key：封面 `<base>.poster.webp` / 列表卡缩略图 `<base>.thumb.webp`。
  // ⚠️ 正则窄到只认 `u_file/uploads/` 下的这两种命名 —— 这个参数让调用方指定写入位置，
  //    放宽一个字符就等于把"往任意 key 写对象"开放出去。要加第三种派生物就再加一条，别改成通配。
  const isDerivedKey = !!forced && /^u_file\/uploads\/[a-z0-9]+\.(poster|thumb)\.webp$/.test(forced);
  const name = c.req.query("name") || "image";
  const ext = isDerivedKey ? "webp" : (name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");   // 派生 key 隐含 webp，不看 name
  if (!["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return c.json({ error: "unsupported image type" }, 400);
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ error: "empty body" }, 400);
  if (buf.byteLength > 8 * 1024 * 1024) return c.json({ error: "image exceeds 8MB" }, 413);
  const key = isDerivedKey ? forced! : `u_file/uploads/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await c.env.IMAGES.put(key, buf, { httpMetadata: { contentType: c.req.header("content-type") || "application/octet-stream" }, customMetadata: { name: (c.req.query("orig") || c.req.query("name") || "").slice(0, 200) } });
  return c.json({ ok: true, key, url: c.env.IMG_BASE + key });
});

// 视频上传（v1）：仅 mp4 · 流式直灌 R2(不 buffer arrayBuffer→避免几十 MB 撑爆 Worker 128MB 内存) · ≤50MB。
// 大小闸走 Content-Length 头，超限先 413 拒再不流。>100MB 直传 R2 通道=v2、暂不做。
app.post("/api/admin/upload-video", async (c) => {
  const name = c.req.query("name") || "video";
  const ext = (name.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (ext !== "mp4") return c.json({ error: "only mp4 supported (v1)" }, 400);
  const len = Number(c.req.header("content-length") || "0");
  if (!len) return c.json({ error: "content-length required" }, 411);
  if (len > 50 * 1024 * 1024) return c.json({ error: "video exceeds 50MB" }, 413);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "empty body" }, 400);
  const key = `u_file/uploads/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.mp4`;
  await c.env.IMAGES.put(key, body, { httpMetadata: { contentType: "video/mp4" }, customMetadata: { name: (c.req.query("orig") || c.req.query("name") || "").slice(0, 200) } });
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
  if (!body.status) body.status = "draft";   // 状态机决策①：新建默认草稿（先编辑完再上线，避免半成品泄漏生产）
  const v = validateProduct(body, newId, ctx.categories, null, ctx.forms);
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
  const v = validateProduct(body, id, ctx.categories, existing, ctx.forms);
  if (v.error) return c.json({ error: v.error }, 400);
  try {
    const r = await publishProduct(c.env, cfg, ctx, v.prod, { isNew: false, oldCategory: existing.category, email: operator(c) });
    if ((r as any).error) return c.json(r as any, 502);
    return c.json({ ok: true, ...r, note: "updated; Pages deploys in ~1 min" });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// 状态流转（draft/published/archived）：读现有 prod→改 status→publishProduct（进/出 index+渲染/删页）。
// 归档=软下架(保留 {id}.json、可恢复)；区别于 DELETE=硬删除(彻底删数据)。
app.put("/api/admin/products/:id/status", async (c) => {
  const id = Number(c.req.param("id").replace(/\D/g, ""));
  if (!id) return c.json({ error: "bad id" }, 400);
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const status = body?.status;
  if (!["draft", "published", "archived"].includes(status)) return c.json({ error: "status must be draft|published|archived" }, 400);
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  const oldRaw = await readFile(c.env, cfg, `data/products/${id}.json`);
  const existing = oldRaw ? JSON.parse(oldRaw) : null;
  if (!existing) return c.json({ error: "not found" }, 404);
  const prod = { ...existing, status };   // existing 已是合法结构（存时校验过）；只翻 status
  try {
    const r = await publishProduct(c.env, cfg, ctx, prod, { isNew: false, oldCategory: existing.category, email: operator(c) });
    if ((r as any).error) return c.json(r as any, 502);
    return c.json({ ok: true, id, status, ...r, note: `status→${status}; Pages deploys in ~1 min` });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// 删除（硬删除·彻底：三语详情+json 一并删 + 列表 regen）
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
  // ⭐ 删机型守卫（URL 安全·零破坏）：机型 slug 就是产品 URL /{slug}/{id}——该机型还有产品则拒删，逼先迁移。
  const removed = v.removed || [];
  for (const r of removed) {
    const n = (ctx.manifest as any[]).filter((m: any) => m.category === r).length;
    if (n > 0) return c.json({ error: `机型「${r}」下还有 ${n} 个产品，删了会断它们的 URL。请先用「批量改机型」把这些产品迁到别的机型，再删。` }, 400);
  }
  // ⭐ 加机型（契约 §2）：model_display 对新 slug **必填**——缺了 listTitleOf 返 null，
  // 新机型页会沿用被播种参考页的标题（如误显示 Mini-Wanew…）。不是崩、是静默错标题，所以在此拦住。
  const added = v.added || [];
  const mdIn: Record<string, string> = (body?.model_display && typeof body.model_display === "object" && !Array.isArray(body.model_display)) ? body.model_display : {};
  const lackMd = added.filter((s) => typeof mdIn[s] !== "string" || !mdIn[s].trim());
  if (lackMd.length) return c.json({ error: `新机型必须给机型显示名（model_display）：${lackMd.join(",")}` }, 400);
  // display 变更的类目 → 重烘焙；纯顺序变更只落 json（首页瓦片顺序随下次本地管线——诚实边界）
  // 新加的 slug 不进 changed：它的页面还不存在（要官网 build 从零生成），重烘焙无从下手。
  const oldMap: Record<string,string> = {}; for (const cc of ctx.categories.categories) oldMap[cc.slug] = cc.display;
  const addedSet = new Set(added);
  const changed = v.cats.categories.filter((cc: any) => !addedSet.has(cc.slug) && oldMap[cc.slug] !== cc.display).map((cc: any) => cc.slug);
  const files: any[] = [{ path: "data/categories.json", content: JSON.stringify(v.cats, null, 2) + "\n" }];
  // 新机型的 model_display 与 categories.json 同一次 commit（原子：避免"有机型没标题"的中间态）
  if (added.length) {
    const rawLoc = await readFile(c.env, cfg, "data/locales.json");
    const locJson = JSON.parse(rawLoc!);
    locJson.model_display = { ...(locJson.model_display || {}) };
    for (const s of added) locJson.model_display[s] = mdIn[s].trim();
    files.push({ path: "data/locales.json", content: JSON.stringify(locJson, null, 2) + "\n" });
  }
  try {
    const ctx2 = { ...ctx, categories: v.cats, catmap: Object.fromEntries(v.cats.categories.map((cc: any) => [cc.slug, cc.display])) };
    for (const slug of changed) files.push(...await rebakeCategory(c.env, cfg, ctx2 as any, slug));
    // 删机型（产品数已=0）：删各语该机型空列表页 /{slug}/index.html + 刷总列表(products/index.html)把它从 nav/分区抹掉
    for (const r of removed) for (const locale of ctx.locales.enabled) {
      const dir = ctx.locDir[locale]; const rel = dir ? `${dir}/${r}/index.html` : `${r}/index.html`;
      if (ctx.pagesList.has(rel)) files.push({ path: rel, delete: true });
    }
    if (removed.length && !changed.length) {   // 没有 display 变更触发过 total 重烘焙 → 用剩余机型触发一次刷 total
      const anyRemain = v.cats.categories[0]?.slug;
      if (anyRemain) files.push(...await rebakeCategory(c.env, cfg, ctx2 as any, anyRemain));
    }
    const tag = [added.length ? `加机型 ${added.join(",")}` : "", removed.length ? `删机型 ${removed.join(",")}` : ""].filter(Boolean).join(" / ");
    const r = await (await import("../vendor/github.js") as any).commitFiles(c.env, cfg, files, `admin: categories update${tag ? ` (${tag})` : ""} (${operator(c)})`);
    // ⚠️ 诚实边界（契约 §1）：官网没有 CI，新机型的页面由 regen.mjs（需 fs）生成 —— edge 跑不了。
    // 数据已提交，但 /{slug}/ 页面要等官网跑一次 build 才出现。别让用户以为立刻可见。
    const note = added.length
      ? `已提交新机型 ${added.join(",")}（数据已入库）。⚠️ 机型页面需官网构建后才生效——请知会官网跑一次 build，届时 /${added[0]}/ 及三语页会出现。`
      : (removed.length ? `已删机型 ${removed.join(",")}（空列表页删除 + 总列表刷新）` : (changed.length ? "display 变更类目已重烘焙" : "仅顺序/无实质变更——首页瓦片顺序随下次本地管线"));
    return c.json({ ok: true, rebaked: changed, removed, added, needsSiteBuild: added.length > 0, filesWritten: files.length, note, ...r });
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
  // 键集规则（放开加机型后）：① 旧键一个都不许丢——含 performance-gen-2 这类"机型已删、键留孤儿"的，
  // 丢了会让曾用该键的页面标题失源；② 新增键必须是**现存机型 slug**，防打错字凭空造键。
  const dropped = Object.keys(oldMd).filter((k) => !(k in md));
  if (dropped.length) return c.json({ error: `model_display 不许丢键（旧键需原样带上，含已删机型的孤儿键）：${dropped.join(",")}` }, 400);
  const catSlugs = new Set((ctx.categories?.categories || []).map((cc: any) => cc.slug));
  const strayNew = Object.keys(md).filter((k) => !(k in oldMd) && !catSlugs.has(k));
  if (strayNew.length) return c.json({ error: `model_display 新键必须是现存机型 slug：${strayNew.join(",")}` }, 400);
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
  const v = validateProduct(body, id, ctx.categories, existing, ctx.forms);
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

// ================= 阶段B：联系方式（data/contact-info.json 语言无关值）=================
// GET 读现值(表单回填)；PUT 保存 → publishContact(renderPage 重烘焙 /contact/ 页×locales + 双步 applyChrome)。
// body.dryRun=true → 预览(返 previewHtml + 将写文件、不提交)。标签(contact.json i18n)官网维护、本编辑器不碰。
app.get("/api/admin/contact", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const raw = await readFile(c.env, cfg, "data/contact-info.json");
  if (!raw) return c.json({ error: "contact-info.json missing（官网上线联系页后可用）" }, 404);
  const j = JSON.parse(raw);
  const contact: Record<string, string> = {};
  for (const k of CONTACT_KEYS) contact[k] = typeof j[k] === "string" ? j[k] : "";   // 只回填 11 个白名单字段
  return c.json({ contact, keys: CONTACT_KEYS });
});

app.put("/api/admin/contact", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  if (!Array.isArray(body?.edits)) return c.json({ error: "edits must be an array" }, 400);
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  try {
    const r: any = await publishContact(c.env, cfg, ctx, body.edits as ContactEdit[], { email: operator(c), dryRun: !!body.dryRun });
    if (r.error) return c.json(r, 502);
    return c.json({ ok: true, ...r, note: r.dry ? "dry preview" : "contact updated; Pages deploys in ~1 min" });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// ================= Guides A：/service/ 落地页文案编辑器（硬白名单）=================
// GET 回填页头/meta + 10 卡片(标题/摘要)四语；PUT publishService(白名单 merge→renderPage /service/→commit)。
// 安全红线:只写 service.json 页头/meta + shared.json 那 20 卡片键,非白名单一律拒(publish.ts mergeService)。
app.get("/api/admin/guides", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  // /service/ 已随官网 G1 迁移下线（commit 5d9ca924 git rm service.json+page-service.html）。
  // 攻略内容迁往统一 /guides/ 库 → 此处指向新 guides-manifest.json 做【只读清单展示】(Joe 能看
  // Guides 里有哪些文章)。完整内容管理编辑器待 Guides②③结构定稿后一次做对(见 roadmap 内容运营)。
  const manRaw = await readFile(c.env, cfg, "data/pages/guides-manifest.json");
  if (!manRaw) return c.json({ retired: true, articles: [], note: "官网仓里还没有 data/pages/guides-manifest.json，所以列不出文章。/service/ 已下线、内容迁往 /guides/——清单文件由官网侧生成，生成后这里自动出现。" });
  let articles: any[] = [];
  try { articles = (JSON.parse(manRaw).articles || []).map((a: any) => ({ id: a.id, topic: a.topic || "其它", slug: a.slug, title: a.title || a.slug, old: a.old || "" })); } catch {}
  return c.json({ retired: true, readonly: true, articles, count: articles.length, note: "攻略已迁到统一 /guides/ 库（内容层重构中）。此处只读展示文章清单；完整内容管理编辑器待 Guides 结构定稿后对齐。" });
});

app.put("/api/admin/guides", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  if (!Array.isArray(body?.edits)) return c.json({ error: "edits must be an array" }, 400);
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  try {
    const r: any = await publishService(c.env, cfg, ctx, body.edits as ServiceEdit[], { email: operator(c), dryRun: !!body.dryRun });
    if (r.error) return c.json(r, 502);
    return c.json({ ok: true, ...r, note: r.dry ? "dry preview" : "guides updated; Pages deploys in ~1 min" });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// ================= SEO A：信息页 meta title/desc 四语编辑器（收窄安全页，硬白名单）=================
// GET 回填各安全页 meta；PUT /seo/:slug → publishPageMeta(白名单 merge {slug}.meta.*→renderPage /{slug}/→commit)。
// service 归攻略编辑器、about 系等官网重排——不在此。canonical/OG/hreflang 派生、不暴露编辑。
app.get("/api/admin/seo", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const raws = await Promise.all(SEO_PAGES.map((p) => readFile(c.env, cfg, `data/pages/${p.slug}.json`)));
  const pages = SEO_PAGES.map((p, i) => {
    const j = raws[i] ? JSON.parse(raws[i] as string) : {};
    const meta: Record<string, any> = {};
    for (const f of p.fields) meta[f] = j[`${p.slug}.meta.${f}`] || {};
    // hasFile：官网仓里到底有没有这页的数据文件（实测 data/pages/marine.json 就不存在）。
    // 没有 ≠ 填了空——完成度视图要如实区分，不然"全空"会被当成没写过而反复重填。
    return { slug: p.slug, label: p.label, fields: p.fields, meta, hasFile: !!raws[i] };
  });
  const first = pages.map((p) => p.meta[p.fields[0]]).find((v) => v && typeof v === "object");
  const locales = first ? Object.keys(first).filter((l) => !l.startsWith("reason")) : [];
  return c.json({ pages, locales });
});

app.put("/api/admin/seo/:slug", async (c) => {
  const slug = c.req.param("slug");
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  if (!Array.isArray(body?.edits)) return c.json({ error: "edits must be an array" }, 400);
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  try {
    const r: any = await publishPageMeta(c.env, cfg, ctx, slug, body.edits as SeoEdit[], { email: operator(c), dryRun: !!body.dryRun });
    if (r.error) return c.json(r, 502);
    return c.json({ ok: true, ...r, note: r.dry ? "dry preview" : `SEO ${slug} updated; Pages deploys in ~1 min` });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// ================= P2 GSC 看板（只读；服务账号 JWT→token→searchAnalytics.query）=================
// 密钥=Secret GSC_SA_KEY(Joe 已存);缺失/失败优雅降级"未接入"、绝不白屏、绝不回显 key。
app.get("/api/admin/gsc", async (c) => {
  if (!c.env.GSC_SA_KEY) return c.json({ notConfigured: true, note: "GSC 未接入（GSC_SA_KEY 未配置）" });   // 优雅降级(200)
  const dim = c.req.query("dim") || "query";
  if (!["query", "page", "country", "device"].includes(dim)) return c.json({ error: "dim must be query|page|country|device" }, 400);
  const days = Math.min(180, Math.max(1, parseInt(c.req.query("days") || "28", 10) || 28));
  try {
    const r: any = await gscQuery(c.env.GSC_SA_KEY, dim, days);
    if (r.error) return c.json({ error: r.error }, 502);
    return c.json({ ok: true, ...r });
  } catch (e: any) { return c.json({ error: "GSC 查询失败", detail: String(e.message || e).slice(0, 200) }, 502); }
});

// ================= P0-1 审计日志：官网仓 commit 历史里 admin: 那些（只读，零写路径）=================
// 数据源=GitHub Commits API（已在仪表盘活动用过）；过滤 admin: 前缀+解析 operator/操作类型；筛选/分页。
// 本期精简：列表(时间·操作人·类型·message)+→GitHub 链接；变更文件详情/回滚=二期。
app.get("/api/admin/audit", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const params = new URLSearchParams({ per_page: "100", page: String(page) });
  const since = c.req.query("since"), until = c.req.query("until");
  if (since) params.set("since", since);
  if (until) params.set("until", until);
  let arr: any[] = [];
  try {
    const res = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/commits?${params.toString()}`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, "User-Agent": "wanew-admin", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return c.json({ error: "github commits failed", status: res.status }, 502);
    const j: any = await res.json();
    if (Array.isArray(j)) arr = j;
  } catch (e: any) { return c.json({ error: "github fetch error", detail: String(e).slice(0, 200) }, 502); }
  const all = arr.map((x: any) => {
    const p = parseAuditMessage(x.commit?.message || "");
    if (!p) return null;   // 非 admin commit 跳过
    return { sha: String(x.sha).slice(0, 7), date: x.commit?.committer?.date || null, url: x.html_url || null, operator: p.operator, operation: p.operation, opType: p.opType };
  }).filter(Boolean) as any[];
  // 服务端筛选 operator/type
  const fOp = c.req.query("operator") || "", fType = c.req.query("type") || "";
  const entries = all.filter((e) => (!fOp || e.operator === fOp) && (!fType || e.opType === fType));
  return c.json({ entries, page, hasMore: arr.length === 100, operators: [...new Set(all.map((e) => e.operator))], scanned: arr.length, adminCount: all.length });
});

// 审计二期：单 commit 变更详情（改了哪些文件 + diff 摘要）——GitHub Commits API。只读。
app.get("/api/admin/audit/:sha", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const sha = (c.req.param("sha") || "").replace(/[^a-f0-9]/gi, "").slice(0, 40);
  if (!sha) return c.json({ error: "bad sha" }, 400);
  try {
    const res = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/commits/${sha}`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, "User-Agent": "wanew-admin", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return c.json({ error: "github commit failed", status: res.status }, 502);
    const j: any = await res.json();
    const files = (j.files || []).slice(0, 60).map((f: any) => ({
      filename: f.filename, status: f.status,
      additions: f.additions || 0, deletions: f.deletions || 0,
      patch: (f.patch || "").slice(0, 4000),   // 每文件 diff 截断防超大
    }));
    return c.json({ sha: String(j.sha).slice(0, 7), stats: j.stats || { additions: 0, deletions: 0 }, fileCount: (j.files || []).length, files });
  } catch (e: any) { return c.json({ error: "github fetch error", detail: String(e).slice(0, 200) }, 502); }
});

// ================= Team A：访问状态（只读；权限真源=Cloudflare Access，此处只展示不控制）=================
// ⚠️ 名册不控制登录权限——加/删成员去 CF Access（wanew-admin 应用）。此端点纯读 env+header，无 GitHub、无写。
app.get("/api/admin/team", (c) => c.json({
  operator: c.req.header("cf-access-authenticated-user-email") || "dev-bypass",
  repo: c.env.GITHUB_REPO,
  imgBase: c.env.IMG_BASE,
  ghTokenConfigured: !!c.env.GITHUB_TOKEN,   // 只报有无，绝不报值
  accessApp: "wanew-admin",
}));

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
// 显示名覆盖（库内改名·#5）：覆盖 customMetadata.name/随机 key；给旧批随机名文件补好认的名。
const MEDIA_NAMES = "_meta/media-names.json";
async function loadNames(env: Env): Promise<Record<string, string>> {
  const obj = await env.IMAGES.get(MEDIA_NAMES);
  if (!obj) return {};
  try { return JSON.parse(await obj.text()); } catch { return {}; }
}
async function saveNames(env: Env, names: Record<string, string>) {
  await env.IMAGES.put(MEDIA_NAMES, JSON.stringify(names), { httpMetadata: { contentType: "application/json" } });
}

// 列 R2 对象(分页抽干、上限保护) + 合并标签 + 对外 URL(img.wanew.com)
app.get("/api/admin/media", async (c) => {
  const tags = await loadMediaTags(c.env);
  const fm = await loadFolders(c.env);
  const names = await loadNames(c.env);
  const items: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await c.env.IMAGES.list({ limit: 1000, cursor, include: ["customMetadata"] });
    for (const o of res.objects) {
      if (o.key === MEDIA_META || o.key === MEDIA_FOLDERS || o.key === MEDIA_NAMES) continue;
      items.push({ key: o.key, size: o.size, uploaded: o.uploaded, url: c.env.IMG_BASE + o.key, tag: tags[o.key] || "", folder: fm.assign[o.key] || "", name: names[o.key] || (o.customMetadata && o.customMetadata.name) || "" });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor && items.length < 5000);
  items.sort((a, b) => ((b.uploaded && b.uploaded.getTime ? b.uploaded.getTime() : 0) - (a.uploaded && a.uploaded.getTime ? a.uploaded.getTime() : 0)));
  return c.json({ media: items, count: items.length, folders: fm.folders, folderKinds: fm.kinds });
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

// #5 库内改显示名：覆盖名存 _meta（不改 R2 对象/key）；空=清覆盖、回退 customMetadata/basename。给旧批随机名文件补好认的名。
app.put("/api/admin/media/name", async (c) => {
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const key = String(body?.key || ""), name = String(body?.name || "").trim().slice(0, 200);
  if (!key || key === MEDIA_META || key === MEDIA_NAMES) return c.json({ error: "bad key" }, 400);
  const names = await loadNames(c.env);
  if (name) names[key] = name; else delete names[key];
  await saveNames(c.env, names);
  return c.json({ ok: true, key, name });
});

// 删除 R2 对象(前端强 confirm；⚠️ 删被产品引用的图会裂详情页——前端提示，Joe 定)
app.delete("/api/admin/media", async (c) => {
  const key = c.req.query("key") || "";
  if (!key || key === MEDIA_META) return c.json({ error: "bad key" }, 400);
  await c.env.IMAGES.delete(key);
  // 删原始资产顺带删其派生物(命名约定)——防孤儿死重：mp4→封面、图片→列表卡缩略图。
  // ⚠️ 只在删**原始**资产时连带；派生 key 自己被删时不再递归（`a.thumb.webp` 去扩展名 + `.thumb.webp`
  //    就是它自己，会变成删两次同一个对象——无害但没意义，也会掩盖"到底删了什么"）。
  if (/\.mp4$/i.test(key)) await c.env.IMAGES.delete(key.replace(/\.mp4$/i, ".poster.webp"));
  else if (!/\.(poster|thumb)\.webp$/i.test(key)) await c.env.IMAGES.delete(key.replace(/\.[a-z0-9]+$/i, "") + ".thumb.webp");
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
type FoldersMeta = { folders: string[]; assign: Record<string, string>; kinds: Record<string, string> };
async function loadFolders(env: Env): Promise<FoldersMeta> {
  const obj = await env.IMAGES.get(MEDIA_FOLDERS);
  if (!obj) return { folders: [], assign: {}, kinds: {} };
  try { const j: any = JSON.parse(await obj.text()); return { folders: Array.isArray(j.folders) ? j.folders : [], assign: (j.assign && typeof j.assign === "object") ? j.assign : {}, kinds: (j.kinds && typeof j.kinds === "object") ? j.kinds : {} }; }
  catch { return { folders: [], assign: {}, kinds: {} }; }
}
async function saveFolders(env: Env, m: FoldersMeta) {
  await env.IMAGES.put(MEDIA_FOLDERS, JSON.stringify(m), { httpMetadata: { contentType: "application/json" } });
}

// 新建文件夹
app.post("/api/admin/media/folders", async (c) => {
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const name = String(body?.name || "").trim();
  const kind = body?.kind === "video" ? "video" : "image";   // 文件夹按 kind 归属（视频夹只在视频库、图片夹只在图片库）
  if (!name) return c.json({ error: "文件夹名不能为空" }, 400);
  if (name.length > 40) return c.json({ error: "文件夹名过长（≤40）" }, 400);
  if (/[\/\\]/.test(name)) return c.json({ error: "文件夹名不能含斜杠" }, 400);
  const m = await loadFolders(c.env);
  if (m.folders.includes(name)) return c.json({ error: "同名文件夹已存在" }, 400);
  m.folders.push(name); m.kinds[name] = kind; await saveFolders(c.env, m);
  return c.json({ ok: true, folders: m.folders, kinds: m.kinds });
});

// 删除文件夹（只删归类元数据，图片一律保留、退回未归类）
app.delete("/api/admin/media/folders", async (c) => {
  const name = c.req.query("name") || "";
  if (!name) return c.json({ error: "bad name" }, 400);
  const m = await loadFolders(c.env);
  m.folders = m.folders.filter((f) => f !== name);
  delete m.kinds[name];
  let unassigned = 0;
  for (const k of Object.keys(m.assign)) if (m.assign[k] === name) { delete m.assign[k]; unassigned++; }
  await saveFolders(c.env, m);
  return c.json({ ok: true, folders: m.folders, kinds: m.kinds, unassigned });
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

// ================= W5 P5：仪表盘（只读概览，零写入零撞车；admin 默认落地页）=================
app.get("/api/admin/dashboard", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const [prodRaw, catRaw, featRaw, locRaw, formsRaw] = await Promise.all([
    readFile(c.env, cfg, "data/products-index.json"),
    readFile(c.env, cfg, "data/categories.json"),
    readFile(c.env, cfg, "data/pages/home-featured.json"),
    readFile(c.env, cfg, "data/locales.json"),
    readFile(c.env, cfg, "data/forms.json"),
  ]);
  const products: any[] = prodRaw ? JSON.parse(prodRaw) : [];
  const categories: any[] = catRaw ? (JSON.parse(catRaw).categories || []) : [];
  const models = locRaw ? Object.keys(JSON.parse(locRaw).model_display || {}) : [];
  const featuredIds: number[] = featRaw ? (JSON.parse(featRaw).ids || []) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const featured = featuredIds.map((id) => byId.get(id)).filter(Boolean).map((p: any) => ({ id: p.id, title: p.title, thumb: p.thumb, category: p.category }));
  const byCat: Record<string, number> = {};
  for (const p of products) byCat[p.category] = (byCat[p.category] || 0) + 1;
  // 形态分布（data/forms.json 数组顺序=/type 页序=chip 序；name=产品 form 字符串）
  const formsList: any[] = formsRaw ? (JSON.parse(formsRaw).forms || []) : [];
  const formCount: Record<string, number> = {};
  for (const p of products) { const f = p.form || ""; if (f) formCount[f] = (formCount[f] || 0) + 1; }
  const byForm = formsList.map((f: any) => ({ form: f.name, count: formCount[f.name] || 0 }));
  const formsCount = formsList.length;
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

// ================= W5 P5+：品类/形态轴（真源=data/forms.json·#52 block2）=================
// ⚠️ 机型轴=categories.json（slug=产品 URL /{slug}/）vs 形态轴=forms.json（key=/type/{key}/，
// name=产品内联 p.form 字符串 + 校验白名单）。数组顺序=/type 页序=chip 序。
app.get("/api/admin/forms", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  const [raw, formsRaw] = await Promise.all([
    readFile(c.env, cfg, "data/products-index.json"),
    readFile(c.env, cfg, "data/forms.json"),
  ]);
  if (!formsRaw) return c.json({ error: "forms.json missing（官网 #52 block2 未部署？）" }, 404);
  const products: any[] = raw ? JSON.parse(raw) : [];
  const forms: any[] = JSON.parse(formsRaw).forms || [];
  const count: Record<string, number> = {};
  for (const p of products) { const f = p.form || ""; count[f] = (count[f] || 0) + 1; }
  // forms.json 数组顺序=真源顺序（name=显示名 / key=/type slug）
  const known = forms.map((f: any) => ({ form: f.name, slug: f.key, count: count[f.name] || 0 }));
  // 孤儿：产品有 form 值但不在 forms.json（未映射=列表页筛不出、build integrity 闸会 FAIL）——吼出来
  const knownForms = new Set(forms.map((f: any) => f.name));
  const orphans = Object.keys(count).filter((f) => f && !knownForms.has(f)).map((f) => ({ form: f, slug: "", count: count[f] }));
  return c.json({ forms: known, orphans, editable: true, note: "形态轴真源=data/forms.json（key=/type/{key}/ URL，name=产品 form 值）。可加/排序/改显示名/带守卫删；改 key 一期不做（动 URL）。新品类页面需官网构建后生效。" });
});

// 品类增删排序改名（契约 §3/§4）。body = { forms:[{key,name}] } 全量覆写，服务端按 key diff。
// 三件事一次做对：① 删=count>0 拒删（守卫）② 改显示名=连带改所有产品 form（原子同 commit）
// ③ 加/排序=只落数据，页面等官网 build。
app.put("/api/admin/forms", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "GitHub not configured (GITHUB_TOKEN)" }, 503);
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "bad json body" }, 400); }
  const ctx = await loadCtx(c.env, cfg);
  if (!ctx) return c.json({ error: "repo ctx missing", missing: (globalThis as any).__ctxMissing }, 500);
  const v = validateForms(body, ctx.forms);
  if (v.error) return c.json({ error: v.error }, 400);
  const added = v.added || [], removed = v.removed || [], renamed = v.renamed || [];

  // ⭐ 删守卫（契约 §4）：该品类还有产品 → 拒删并报数。静默删会让那些产品从 /type/ 页消失、
  // data-form 变空，官网 build 的 forms-integrity-check 也会 FAIL。响亮拒 > 静默丢。
  const oldByKey = new Map((ctx.forms || []).map((f: any) => [f.key, f.name]));
  for (const key of removed) {
    const name = String(oldByKey.get(key));
    const n = (ctx.manifest as any[]).filter((m: any) => m.form === name).length;
    if (n > 0) return c.json({ error: `品类「${name}」下还有 ${n} 个产品，删了它们会从 /type/${key}/ 页消失。请先用「批量改形态」把这些产品迁到别的品类，再删。` }, 400);
  }

  const rawForms = await readFile(c.env, cfg, "data/forms.json");
  const formsJson = JSON.parse(rawForms!);
  formsJson.forms = v.forms;
  const formsFile = { path: "data/forms.json", content: JSON.stringify(formsJson, null, 2) + "\n" };

  try {
    let touched = 0, scanned = 0;
    let r: any;
    if (renamed.length) {
      // 改显示名 → 连带改产品 form（扫全部产品含草稿/下架），与 forms.json 同一次 commit
      const rf = await formRenameFiles(c.env, cfg, ctx, renamed);
      if (rf.error) return c.json({ error: "扫描产品失败（未提交）", detail: rf.error }, 502);
      touched = rf.touched; scanned = rf.scanned;
      r = await (await import("../vendor/github.js") as any).commitFiles(
        c.env, cfg, [...rf.files, formsFile],
        `admin: forms update (改显示名 ${renamed.map((x) => `${x.from}→${x.to}`).join(",")}${touched ? ` · 连带 ${touched} 产品` : ""}) (${operator(c)})`);
    } else {
      const tag = [added.length ? `加 ${added.join(",")}` : "", removed.length ? `删 ${removed.join(",")}` : ""].filter(Boolean).join(" / ") || "排序";
      r = await (await import("../vendor/github.js") as any).commitFiles(c.env, cfg, [formsFile], `admin: forms update (${tag}) (${operator(c)})`);
    }
    // ⚠️ 诚实边界（契约 §1）：加品类的 /type/{key}/ 页、以及排序后的 chip 顺序/计数，都由官网
    // build（regen.mjs + chrome-sync）产出 —— edge 跑不了。数据已入库 ≠ 页面已变。
    const needsSiteBuild = added.length > 0 || removed.length > 0 || (!renamed.length);
    const parts: string[] = [];
    if (added.length) parts.push(`已加品类 ${added.join(",")}`);
    if (removed.length) parts.push(`已删品类 ${removed.join(",")}`);
    if (renamed.length) parts.push(`已改显示名 ${renamed.map((x) => `${x.from}→${x.to}`).join(",")}（连带改了 ${touched} 个产品／共扫 ${scanned} 个）`);
    if (!parts.length) parts.push("已保存新顺序");
    const note = parts.join("；") + (needsSiteBuild ? "。⚠️ 数据已入库，但 /type/ 页面与导航计数需官网构建后才生效——请知会官网跑一次 build。" : "。改显示名只动数据，页面无需重建。");
    return c.json({ ok: true, added, removed, renamed, productsTouched: touched, productsScanned: scanned, needsSiteBuild, note, ...r });
  } catch (e: any) { return c.json({ error: "commit failed", detail: String(e).slice(0, 300) }, 502); }
});

// run_worker_first=true 时 Worker 先跑：未匹配的路由必须**显式**回落静态资源
// （骨架首 boot 实测 / 404 抓出来的——Hono 不会自动帮你转 ASSETS）。auth 中间件在前=静态页同样在门后。
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
