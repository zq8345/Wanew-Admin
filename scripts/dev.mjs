// `npm run dev` —— 本地起后台 UI，开箱即用。
//
// 🔴 为什么需要这个脚本，而不是直接 `wrangler dev`：
//    wrangler.jsonc 里有 `routes:[{pattern:"admin.wanew.com",custom_domain:true}]`。
//    **`wrangler dev` 会拿这条路由去合成请求 URL 的 host** —— 于是本地打开 localhost:8790，
//    Worker 里读到的 hostname 是 `admin.wanew.com`。
//    鉴权中间件的开发旁路只在本机生效，它一看 host 不是 localhost，就按"生产上出现了后门"
//    500 停服（这在生产上是对的）。结果：**本地实例从来就起不来。**
//
// ⚠️ 这一条值得单独记住：中间件的注释写着"宿主名是请求自带的事实，配不出来"。
//    那句话在**生产**上完全成立；而在 `wrangler dev` 下，host 恰恰是配置合成出来的。
//    **同一句推理在两个环境里真假相反。** 这类"只在某个环境成立的前提"是最难发现的一类。
//
// ⚠️ 代价不是"不方便"，是**三轮界面改动没有人看过界面**。所以这不是开发者体验问题，是质量问题。
//
// 做法：从 wrangler.jsonc **派生**一份本地配置（去掉 routes），每次 `npm run dev` 重新生成。
//   ⚠️ 手抄一份 wrangler.local.jsonc 也能跑，但那是**第二个真源**：以后加个绑定、改个变量，
//      本地那份不会跟着变，于是"本地看着好好的"会重新变得不可信。派生 = 不可能漂。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "wrangler.jsonc");
const OUT = path.join(ROOT, ".wrangler.dev.jsonc");   // 已在 .gitignore；每次重新生成，绝不手改

// ---- JSONC → JSON。字符串内的 `//` 不是注释（"https://img.wanew.com/" 会被naive正则切掉半个值）----
function stripJsonc(src) {
  let out = "", i = 0, inStr = false, esc = false;
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i++; continue;
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += ch; i++;
  }
  // 尾逗号（JSONC 允许，JSON.parse 不允许）—— 同样要避开字符串内部
  let res = "", j = 0; inStr = false; esc = false;
  while (j < out.length) {
    const ch = out[j];
    if (inStr) {
      res += ch;
      if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false;
      j++; continue;
    }
    if (ch === '"') { inStr = true; res += ch; j++; continue; }
    if (ch === ",") {
      let k = j + 1; while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === "}" || out[k] === "]") { j++; continue; }   // 丢掉这个尾逗号
    }
    res += ch; j++;
  }
  return res;
}

const raw = fs.readFileSync(SRC, "utf8");
let cfg;
try { cfg = JSON.parse(stripJsonc(raw)); }
catch (e) { console.error(`🔴 解析 wrangler.jsonc 失败：${e.message}\n   （不做容错兜底：解析不出来就停，绝不用一份残缺配置起服务）`); process.exit(1); }

// 🔴 解析成功 ≠ 解析对了。逐条断言拿到的是我以为的那份配置——
//    少了 assets 照样能 JSON.parse 成功，然后本地起来一个**没有界面**的 worker，而我会以为是代码坏了。
const MUST = ["name", "main", "assets", "vars", "r2_buckets"];
const missing = MUST.filter((k) => !cfg[k]);
if (missing.length) { console.error(`🔴 wrangler.jsonc 解析结果缺字段：${missing.join(", ")}——解析器可能坏了，停。`); process.exit(1); }
if (cfg.name !== "wanew-admin") { console.error(`🔴 name=${cfg.name}，不是 wanew-admin，停。`); process.exit(1); }
if (!cfg.routes) {
  // routes 没了 ⇒ 要么上游改了，要么解析漏了。两种都不该静默继续：
  // 静默继续的话，这个脚本会变成一个"什么也没修"的壳子，而症状（500）会以为是别的原因。
  console.error("🔴 wrangler.jsonc 里没有 routes —— 本脚本存在的唯一理由就是去掉它。请确认是上游真删了；若是，直接用 `wrangler dev` 即可，本脚本可删。");
  process.exit(1);
}

delete cfg.routes;                 // ← 唯一的实质改动：host 不再被合成，localhost 就是 localhost
cfg.vars = { ...cfg.vars, DEV_BYPASS_AUTH: "1" };
// ⚠️ 旁路只写进这份**派生的、gitignore 的、每次重生成的**本地配置，不写进 .dev.vars，
//    也永远不会进 wrangler.jsonc ⇒ `npm run deploy` 读的是原文件，带不上它。
//    即使有人拿这份文件去 deploy，中间件那道 host 检查仍会 500 —— 两层各自独立，不互为前提。

fs.writeFileSync(OUT, JSON.stringify({
  __generated: "由 scripts/dev.mjs 从 wrangler.jsonc 派生，请勿手改；改配置改 wrangler.jsonc",
  ...cfg,
}, null, 2) + "\n");

// ---- 令牌自检：没有令牌时，界面能开但**所有数据端点 503**。----
// ⚠️ 不预告这件事的话，开发者看到的是一个空列表，会以为是代码坏了 —— 而这正是我们要消灭的那种误判。
const devVars = path.join(ROOT, ".dev.vars");
const hasToken = fs.existsSync(devVars) && /^\s*GITHUB_TOKEN\s*=\s*\S/m.test(fs.readFileSync(devVars, "utf8"));

const port = process.env.PORT || "8790";
console.log(`本地后台 → http://localhost:${port}\n`);
if (hasToken) {
  console.log("  ✅ 界面 + 数据：读的是官网仓 main 的真内容");
  console.log("  ⚠️ 保存类操作会**真的提交到生产仓** —— 本地没有 Access 门挡着，手别抖。");
} else {
  console.log("  ✅ 界面能开（外壳、导航、样式、布局都可看可量）");
  console.log("  🔴 .dev.vars 里没有 GITHUB_TOKEN ⇒ **所有数据端点 503，列表是空的**。这不是 bug。");
  console.log("     要看真数据：在 .dev.vars 写一行 `GITHUB_TOKEN=<PAT>`（.dev.vars 已 gitignore）。");
  console.log("     ⚠️ 用一个**不勾任何权限**的 PAT 就够了 —— zq8345/Wanew 是公开仓，读不需要权限；");
  console.log("        而**不给写权限 = 本地误点一下也提交不到生产**。别图省事灌那个有写权限的正式令牌。");
}
console.log("  ⚠️ 派生配置 .wrangler.dev.jsonc 每次重新生成；要改配置请改 wrangler.jsonc。\n");

const child = spawn("npx", ["wrangler", "dev", "-c", OUT, "--port", port], { cwd: ROOT, stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
