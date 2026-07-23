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

// run_worker_first=true 时 Worker 先跑：未匹配的路由必须**显式**回落静态资源
// （骨架首 boot 实测 / 404 抓出来的——Hono 不会自动帮你转 ASSETS）。auth 中间件在前=静态页同样在门后。
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
