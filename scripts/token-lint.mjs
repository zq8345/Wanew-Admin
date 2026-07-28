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

if (bad) {
  console.error(`\n🔴 ${bad} 处在 admin 自有样式里定义了 --w3-* 品牌令牌。`);
  process.exit(1);
}
console.log(`✅ 令牌纪律 PASS：admin 自有样式 0 处定义 --w3-*；镜像 ${MIRROR} 提供 ${mirrorVars} 个品牌令牌。`);
