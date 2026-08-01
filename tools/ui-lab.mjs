// 密集模式的测量台：本地起 admin UI，**喂生产上真实的 68 条数据**，不需要任何凭据。
// 🔴 干净种子只验逻辑；超长标题、脏值、量大才决定观感 —— 规格 §10 明写"必须过生产快照关"。
//
// ⚠️ 它和 `npm run dev` 是**两件不同的东西，别混**：
//    `npm run dev` = 真 worker、真代码路径，但没有 GITHUB_TOKEN 就没有数据（列表是空的）。
//    本文件      = 假后端、真前端、真数据，**只能用来量版式，不能用来验后端行为**。
//    拿它去验后端 = 量的是另一个系统（这个坑踩过：桩返回的形状和真实现不一样，
//    本地一切正常而生产上首屏那条恒为 0）。
//
// 用法：node tools/ui-lab.mjs  → http://127.0.0.1:8792 ，再按 tools/measure.js 量。
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "public");
const PORT = Number(process.env.PORT || 8792);

// 官网仓的本地副本（只读它的 data/*.json）。⚠️ 各人路径不一样 —— 显式找，找不到就**报清楚怎么办**，
//    别静默退化成空数据：空列表看起来和"页面坏了"一模一样。
const CANDIDATES = [process.env.WANEW_REPO, "C:/开发/wanew-thumbs", "C:/开发/wanew", path.resolve(HERE, "../../wanew")].filter(Boolean);
const REPO = CANDIDATES.find((d) => { try { return fs.statSync(path.join(d, ".git")); } catch { return false; } });
if (!REPO) {
  console.error("🔴 找不到官网仓本地副本。试过：\n  " + CANDIDATES.join("\n  ") +
    "\n\n设一个环境变量指过去再跑：  set WANEW_REPO=<官网仓路径>\n（只读它的 data/*.json，不写。）");
  process.exit(1);
}
console.error(`[ui-lab] 数据源 ${REPO} @ origin/main`);
const git = (a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 30 });
git(["fetch", "-q", "origin", "main"]);
const man = JSON.parse(git(["show", "origin/main:data/products-index.json"]));
const cats = JSON.parse(git(["show", "origin/main:data/categories.json"]));
const forms = JSON.parse(git(["show", "origin/main:data/forms.json"]));
const locales = JSON.parse(git(["show", "origin/main:data/locales.json"]));

// products-index 的条目形状 ≈ 列表页要的（id/category/form/title/thumb/excerpt），status 缺省 published。
// ⚠️ 造几条**真实存在的极端**：manifest 里最长的标题、没有 excerpt 的、draft/archived 各一条。
const byLen = [...man].sort((a, b) => (b.title || "").length - (a.title || "").length);
const products = man.map((e, i) => ({
  ...e,
  status: i % 17 === 3 ? "draft" : i % 23 === 5 ? "archived" : "published",
}));
console.error(`[ui-lab] 产品 ${products.length} 条 · 最长标题 ${byLen[0].title.length} 字符：${byLen[0].title}`);
console.error(`[ui-lab] 无 excerpt ${products.filter((p) => !p.excerpt).length} 条 · draft ${products.filter((p) => p.status === "draft").length} · archived ${products.filter((p) => p.status === "archived").length}`);

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const json = (res, o) => { res.writeHead(200, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(o)); };

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  // ⚠️ `/api/_whoami` 不在 `/api/admin/` 下 —— 漏了它，init 里那个 try 会在定义 window.imgUrl
  //    **之前**抛掉，然后 catch{} 吃掉，表现是 loadList 报 "imgUrl is not defined"。
  //    ⇒ 桩漏一个端点，症状会出现在完全不相干的地方。
  if (p === "/api/_whoami") return json(res, { app: "wanew-admin", repo: "zq8345/Wanew", imgBase: "https://img.wanew.com/", operator: "joe@wanew.com", ghTokenConfigured: true });
  if (p === "/api/health") return json(res, { ok: true });
  if (p.startsWith("/api/admin/")) {
    const ep = p.slice("/api/admin/".length);
    // 🔴 生产的形状：products-index.json **只含 live 的**（publishProduct 把非 live 移出 manifest）。
    //    第一版我把草稿/下架也塞进 /products —— 于是本地一切正常，而生产上首屏那条恒为 0。
    //    **桩和真实现的数据形状不一样，量出来的就是另一个系统。**
    if (ep === "products") { const live = products.filter((p) => (p.status || "published") === "published"); return json(res, { products: live, count: live.length, admin: "joe@wanew.com" }); }
    if (ep === "products/drafts") return json(res, { drafts: products.filter((p) => (p.status || "published") !== "published") });
    if (ep === "categories") return json(res, cats);
    if (ep === "forms") return json(res, { forms: forms.forms, orphans: [], editable: true });
    if (ep === "models") return json(res, { model_display: locales.model_display });
    // ⚠️ 这里原来有一个 `dashboard` 桩。仪表盘已在 0f6dbd9e 删掉，桩跟着删 ——
    //    **留着一个已经没有对应实现的桩，等于把"它还在"这件事写进仪器里。**
    if (ep === "_whoami") return json(res, { app: "wanew-admin", operator: "joe@wanew.com" });
    return json(res, {});   // 其余端点给空对象，列表页不依赖
  }
  // ⚠️ ROOT 用正斜杠而 path.join 在 Windows 上产出反斜杠 —— 直接 startsWith 会把**每个**请求判成越界，
  //    然后统一回 404「nf」。而浏览器里那看起来就是"页面是空的、0 行"，
  //    我差点把仪器坏了当成被测对象空了。⇒ 两边都 resolve 再比。
  const base = path.resolve(ROOT);
  const f = path.resolve(base, p === "/" ? "index.html" : p.replace(/^\//, ""));
  if (!f.startsWith(base) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nf:" + f); }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  res.end(fs.readFileSync(f));
}).listen(PORT, "127.0.0.1", () => console.error(`[ui-lab] http://127.0.0.1:${PORT}  —— 开 1440×900，控制台贴 tools/measure.js`));
