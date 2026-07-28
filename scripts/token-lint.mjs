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
  const pub = readFileSync(path.join(ROOT, "src/publish.ts"), "utf8");
  const fn = (gh.match(/export async function commitFiles[\s\S]*?\n\}\n/) || [""])[0];
  if (!fn) { console.error("🔴 在 vendor/github.js 里找不到 commitFiles —— 成本模型无法核对"); process.exit(1); }

  const inline = /type: "blob", content:/.test(fn);          // 内联路径
  const blobPath = /git\/blobs`/.test(fn);                   // 逐文件 blob 退路
  const base = [...fn.matchAll(/await gh\(env, `([^`]*)`/g)].map((m) => m[1])
    .filter((u) => !/git\/blobs`?$/.test(u) && !u.includes("git/blobs")).length;   // 不含 blob 的固定开销
  const model = Number((pub.match(/const COMMIT_SUBREQ = (\d+)/) || [])[1]);
  const vLimit = (gh.match(/const INLINE_LIMIT = ([\d *]+);/) || [])[1];
  const pLimit = (pub.match(/const INLINE_LIMIT = ([\d *]+);/) || [])[1];

  if (base !== model) {
    console.error(`🔴 成本模型对不上：commitFiles 的固定开销是 ${base} 次（不含 blob），src/publish.ts 写的是 ${model}。`);
    console.error(`   → 模型偏大会**误拒正常保存**，偏小会重新撞上限。改 COMMIT_SUBREQ。`);
    process.exit(1);
  }
  // ⚠️ 两条路径必须都被模型认得：只按 5 算会在退路上撞限，只按 5+N 算会误拒正常保存
  if (blobPath && !/COMMIT_SUBREQ \+ writes\.length/.test(pub)) {
    console.error(`🔴 vendor 有"体积超限退回逐文件 blob"的路径，但成本模型没有对应分支。`);
    console.error(`   → 那条路上开销是 ${base} + 文件数，模型只算 ${base} 会重新撞上限。`);
    process.exit(1);
  }
  if (inline && vLimit && pLimit && vLimit.replace(/\s/g, "") !== pLimit.replace(/\s/g, "")) {
    console.error(`🔴 体积阈值对不上：vendor INLINE_LIMIT=${vLimit.trim()}，src/publish.ts=${pLimit.trim()}。`);
    console.error(`   → 两边判"走内联还是走退路"的分界线不同，模型会在中间那段算错。`);
    process.exit(1);
  }
  console.log(`✅ 成本模型 PASS：固定 ${base} 次${blobPath ? " + 超限退路(按 5+文件数 计)" : ""}${vLimit ? ` · 阈值两边一致(${vLimit.trim()})` : ""}。`);
}

// ── 字节 vs 字符：防第四次 ────────────────────────────────────────────────────
// 2026-07-28 同一个 bug 家族一天出现三次（blob header 长度 / 内联体积判断 / 只用 ASCII 测），
// 全在处理同一批中文数据的系统里。`"中".length === 1` 而 UTF-8 是 3 字节。
//
// ⚠️ **通用规则做不到** —— 静态分不清 `.length` 是数组还是字符串，硬做只会制造噪音。
//    所以只盯这个失败形状真正出现的位置：**内容变量**（content/html/raw/body）上的 `.length`。
//    覆盖面窄是**故意的**：一条噪音大的规则会被加豁免，最后等于没有。
{
  // ⚠️ 名单里只放**在本仓恒为字符串**的那几个。第一版把 `body` 也放了进来 ——
  //    而 gitsha.ts 里 `body` 是 `Uint8Array`，它的 `.length` **本来就是字节数、代码是对的**。
  //    正确代码被报红 = 噪音，而噪音会被加豁免，最后规则等于没有。**误报要修规则，不要加豁免。**
  const NAMES = /\b(content|html|rawHtml|prevRaw)\b\s*(?:\?\?[^.]*)?\.length\b/;
  const offenders = [];
  for (const f of ["src/publish.ts", "src/index.ts", "src/gitsha.ts", "src/subreq.ts", "src/bytes.ts"]) {
    const lines = readFileSync(path.join(ROOT, f), "utf8").split("\n");
    lines.forEach((l, i) => {
      // ⚠️ 必须剥掉**行尾**注释，不只是整行注释：`gitsha.ts` 里那行代码是对的，
      //    但它的行尾注释写着"⚠️ 字节数，不是 content.length" —— **规则把讲这个 bug 的文字当成了这个 bug。**
      //    检查器读的应该是代码，不是它旁边关于代码的说明。
      const code = l.replace(/\/\/.*$/, "");
      if (!code.trim() || code.trim().startsWith("*")) return;
      if (NAMES.test(code)) offenders.push(`${f}:${i + 1}  ${l.trim().slice(0, 90)}`);
    });
  }
  if (offenders.length) {
    console.error(`🔴 ${offenders.length} 处在内容变量上用了 .length —— 那是 UTF-16 码元数，不是字节数。`);
    console.error(`   → 中文内容会被低估到约三分之一；纯 ASCII 测不出来。改用 byteLen()（src/bytes.ts）。`);
    offenders.forEach((o) => console.error(`     ${o}`));
    process.exit(1);
  }
  console.log(`✅ 字节纪律 PASS：内容变量上 0 处 .length（体积/长度一律走 byteLen）。`);
}

if (bad) {
  console.error(`\n🔴 ${bad} 处在 admin 自有样式里定义了 --w3-* 品牌令牌。`);
  process.exit(1);
}
console.log(`✅ 令牌纪律 PASS：admin 自有样式 0 处定义 --w3-*；镜像 ${MIRROR} 提供 ${mirrorVars} 个品牌令牌。`);
