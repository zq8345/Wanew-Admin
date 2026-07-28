#!/usr/bin/env node
// W4 令牌纪律闸：admin 只准**消费** `--w3-*`，不准**定义**它。
// ─────────────────────────────────────────────────────────────────────────
// 为什么要有这个：品牌令牌的真源是官网 skin/css/w3.css 的 :root（已由 vendor 守卫逐字节镜像成
// public/w3-tokens.css）。admin 若自己再定义一份同名令牌，vendor 守卫是**看不见**的——它只比对
// 镜像文件，管不到 admin 自己的 CSS。那样官网改了令牌，admin 这份会无声压过去 = 漂移复活。
// 所以这条不变量必须单独有闸：admin 自有的一律 `--dz-*` 前缀。
//
//   node scripts/token-lint.mjs   → 违规 exit 1（列出文件:行），干净 exit 0
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 被检查的是 admin 自有样式；public/w3-tokens.css 是镜像（本来就该定义 --w3-*），豁免。
const FILES = ["public/shell.css", "public/index.html"];
const MIRROR = "public/w3-tokens.css";

let bad = 0;
for (const rel of FILES) {
  const lines = readFileSync(path.join(ROOT, rel), "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    // 只找**定义**（`--w3-x: value`），不碰消费（`var(--w3-x)`）
    const defs = [...line.matchAll(/(^|[;{,\s])(--w3-[a-z0-9-]+)\s*:/g)].map((m) => m[2]);
    if (!defs.length) return;
    bad += defs.length;
    console.error(`🔴 ${rel}:${i + 1} 定义了品牌令牌 ${defs.join(", ")}`);
    console.error(`   → 品牌令牌只能来自 ${MIRROR}（官网真源镜像）。admin 自有的请用 --dz-* 前缀。`);
  });
}

// 反向自检：镜像文件必须真的定义了令牌（否则闸"通过"只是因为页面根本没加载到令牌层）
let mirrorVars = 0;
try {
  mirrorVars = (readFileSync(path.join(ROOT, MIRROR), "utf8").match(/--w3-[a-z0-9-]+\s*:/g) || []).length;
} catch { /* 缺失 → 下面报错 */ }
if (!mirrorVars) {
  console.error(`🔴 ${MIRROR} 不存在或没有任何 --w3-* 令牌——页面会拿不到品牌令牌（全站颜色失效）。`);
  console.error(`   → 跑 \`npm run vendor:sync\` 重新从官网切片。`);
  process.exit(1);
}

// ── 子请求成本模型 vs vendor 真实实现 ────────────────────────────────────────
// 预算闸拿一个常数当"提交要花多少次子请求"。那个常数**描述的是 vendor/github.js 的实现**，
// 而那个文件是官网的镜像 —— **它会在我不知情的时候变**（2026-07-28 就变了一次：
// 逐文件 blob POST 换成 tree 内联 content，写入侧从 `2+文件数+3` 变成固定 5）。
//
// 🔴 模型过时的后果不是"少了一道保护"，是**反过来挡住正常保存**：
//    按旧模型，保存产品（33 文件）会被算成需要 38 次而被自己的闸拒掉，实际只花 5 次。
//    **一个模型过时了的安全装置，就是停机器。**
// 所以这里机器核对，不靠记性：数 commitFiles 里的 `await gh(` 调用点，并确认循环里没有网络请求。
{
  const gh = readFileSync(path.join(ROOT, "vendor/github.js"), "utf8");
  const fn = (gh.match(/export async function commitFiles[\s\S]*?\n\}/) || [""])[0];
  const calls = (fn.match(/await gh\(/g) || []).length;
  const loopFetch = /for \(const f of files\)[\s\S]*?await gh\(/.test(fn);
  const model = Number((readFileSync(path.join(ROOT, "src/publish.ts"), "utf8").match(/const COMMIT_SUBREQ = (\d+)/) || [])[1]);
  if (!fn) { console.error("🔴 在 vendor/github.js 里找不到 commitFiles —— 成本模型无法核对"); process.exit(1); }
  if (loopFetch) {
    console.error(`🔴 commitFiles 的文件循环里又出现了网络请求 —— 写入开销重新变成"每文件一次"。`);
    console.error(`   → 预算模型 COMMIT_SUBREQ 不再是常数，src/publish.ts 必须跟着改。`);
    process.exit(1);
  }
  if (calls !== model) {
    console.error(`🔴 成本模型对不上：vendor/github.js 的 commitFiles 有 ${calls} 次子请求，src/publish.ts 写的是 ${model}。`);
    console.error(`   → 官网改了提交实现。模型偏大会**误拒正常保存**，偏小会重新撞上限。改 COMMIT_SUBREQ。`);
    process.exit(1);
  }
  console.log(`✅ 成本模型 PASS：commitFiles 实测 ${calls} 次子请求，与 COMMIT_SUBREQ=${model} 一致（循环内无网络请求）。`);
}

if (bad) {
  console.error(`\n🔴 ${bad} 处在 admin 自有样式里定义了 --w3-* 品牌令牌。`);
  process.exit(1);
}
console.log(`✅ 令牌纪律 PASS：admin 自有样式 0 处定义 --w3-*；镜像 ${MIRROR} 提供 ${mirrorVars} 个品牌令牌。`);
