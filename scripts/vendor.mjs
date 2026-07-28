#!/usr/bin/env node
// vendor 漂移守卫（A 方案·单真源保障，2026-07-24）
// ─────────────────────────────────────────────────────────────────────────
// vendor/ 是官网仓 zq8345/Wanew(main) 4 个共享库的**只读镜像**：
//   vendor/render.js  ← functions/_lib/render.js   （产品页渲染 + 列表 regen）
//   vendor/chrome.js  ← functions/_lib/chrome.js   （三语站壳 makeChrome）
//   vendor/github.js  ← functions/_lib/github.js   （GitHub API 原子提交/读文件）
//   vendor/page-paths.js ← functions/_lib/page-paths.js（产品→页面路径/slug 派生）
//   vendor/locale-dirs.mjs ← scripts/locale-dirs.mjs（locale 目录映射）
// 权威真源永远在官网仓；本仓只持镜像，杜绝 W1b 那种 fork-drift。
//
//   node scripts/vendor.mjs check  （默认）→ 逐字节比对镜像 vs 官网 main 权威版
//        一致 → exit 0；漂移 → exit 1；拉取失败 → exit 2（fail-closed，不核对不放行）
//   node scripts/vendor.mjs sync         → 从官网 main 重新拉，覆盖 vendor/（字节精确）
//
// 何时会红：官网 main 改了这些库（如 W3 合 main 动 render.js）→ 红 = 提示 `npm run vendor:sync`。
// ⚠️ 勿手改 vendor/ 下文件；要改去改上游官网仓，再 sync。
// 比对用 Buffer.equals 逐字节（非字符串，避免 EOL 归一掩盖/伪造差异）；vendor/** 在 .gitattributes
// 标 `-text` 钉死字节（防 autocrlf 把 LF 转 CRLF 造假漂移）。
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://raw.githubusercontent.com/zq8345/Wanew/main";
// ⭐ 「哪些文件必须被镜像」的权威清单在**官网仓**：data/vendor-manifest.json。
//    原来这份名单在这里，于是它只能抓"我镜像的文件变了"，**抓不到"有一个我该镜像的文件出现了"**
//    —— 官网新增 page-paths.js 时我的守卫一声不吭，是总工口头提醒才补上的。
//    ⚠️ 这份清单**不镜像**，每次 check 实时取：镜像下来会把"官网新增了该镜像的文件"这个信号
//    延迟一轮，而那正是它要解决的问题。它不是被消费的代码，是**该消费哪些代码的元数据**。
const MANIFEST_PATH = "data/vendor-manifest.json";

// vendor 本地文件 ↔ 官网仓权威路径（1:1）。⚠️ 这里只定"上游路径 → 本地落点 + 切片器"，
// **该不该镜像由上面那份清单说了算**，两者由 check 时的对账强制一致。
const MAP = [
  ["vendor/render.js", "functions/_lib/render.js"],
  ["vendor/chrome.js", "functions/_lib/chrome.js"],
  ["vendor/github.js", "functions/_lib/github.js"],
  ["vendor/page-paths.js", "functions/_lib/page-paths.js"],
  ["vendor/manifest-entry.js", "functions/_lib/manifest-entry.js"],
  ["vendor/locale-dirs.mjs", "scripts/locale-dirs.mjs"],
  // ⭐ W4：设计令牌真源。官网 skin/css/w3.css 有 122KB，其中绝大部分是**官网的组件样式**——
  // 整份镜像进 admin 会把营销站的组件 CSS 一起拖进后台（体积 + 选择器打架）。所以这条走**切片**：
  // 只镜像它那唯一一个 `:root{…}` 令牌块，仍然是逐字节比对（切片规则确定 ⇒ 守卫强度不打折）。
  // 落在 public/ 是因为 worker 只服务 public/（页面要能 <link> 它）；仍是逐字节守卫的镜像，
  // 且已在 .gitattributes 里同 vendor/** 一样标 -text 钉死字节。
  ["public/w3-tokens.css", "skin/css/w3.css", sliceRootBlock],
];

// 切片器：取上游 CSS 的**基础** `:root{…}` 块 —— 即**花括号深度为 0** 的那个。
// 深度 >0 的 :root 是嵌在 `@media` 里的响应式覆写（上游 2026-07-28 起有两个这样的块，
// 覆写 --w3-fs-* 字号档）。admin 不消费 --w3-fs-*，且后台是固定宽度的桌面工具，不需要那套断点。
// ⚠️ 判据用真实括号深度而不是"取第一个"或正则猜：**基础块必须恰好一个**，多了照样拒绝
//    （那意味着上游把令牌拆成了多块，得有人看一眼再决定怎么合）。
function sliceRootBlock(buf, upstream) {
  const text = buf.toString("utf8");
  const base = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith(":root", i)) {
      const open = text.indexOf("{", i);
      if (open > -1 && text.slice(i + 5, open).trim() === "") {
        // 找到配对的右括号（令牌块内部不含嵌套括号）
        const close = text.indexOf("}", open);
        if (close > -1 && depth === 0) base.push(text.slice(i, close + 1));
      }
    }
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth = Math.max(0, depth - 1);
  }
  const all = base;
  if (all.length !== 1) throw new Error(`${upstream} 里**顶层** :root 块有 ${all.length} 个（期望恰好 1 个）——上游结构变了，切片规则需重定`);
  return Buffer.from(
    `/* 自动生成·勿手改 —— 官网 ${upstream} 的 :root 令牌层逐字节切片。\n` +
    `   改令牌请去官网仓改，然后 \`npm run vendor:sync\`。\n` +
    `   admin 自己的 dense 层在 public/shell.css，只允许 --dz-* 前缀（见 scripts/token-lint.mjs）。*/\n` +
    all[0] + "\n", "utf8");
}

async function fetchUpstream(upstream, transform) {
  const res = await fetch(`${BASE}/${upstream}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return transform ? transform(buf, upstream) : buf;
}

const mode = process.argv[2] || "check";

if (mode === "sync") {
  let ok = 0;
  for (const [local, upstream, transform] of MAP) {
    const buf = await fetchUpstream(upstream, transform); // 失败即抛，整体非 0 退出
    writeFileSync(path.join(ROOT, local), buf); // 字节精确写入，不做任何编码转换
    console.log(`↓ ${local}  ←  Wanew:main:${upstream}  (${buf.length}B)`);
    ok++;
  }
  console.log(`\n✅ 已同步 ${ok} 个 vendor 镜像。请跑 \`npm run guard:vendor\` 确认逐字节一致，并 commit。`);
  process.exit(0);
}

// mode === "check"
let drift = 0, err = 0;

// ── 先对账清单：官网说该镜像的，我镜像了吗 ────────────────────────────────────
// 这一步治的是**逐字节比对治不了的那一半**：比对只覆盖名单里的文件，
// 而"官网新增了一个我该镜像的文件"根本不在名单里 —— 沉默只覆盖它检查的那一维。
// ⚠️ 清单实时取，取不到就**红**（fail-closed）；但报错要说清是"取不到清单"，
//    **不是"你少镜像了文件"** —— 查不到 ≠ 不存在，这条今天刚立。
try {
  const res = await fetch(`${BASE}/${MANIFEST_PATH}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const man = JSON.parse(await res.text());
  const want = (man.files || []).filter((f) => f.mirror).map((f) => f.path);
  if (!want.length) throw new Error("清单里 mirror:true 的文件数为 0，形状可能变了");
  const have = MAP.map(([, upstream]) => upstream);
  const missing = want.filter((p) => !have.includes(p));
  const extra = have.filter((p) => !want.includes(p));
  // ⚠️ 两个方向的风险**不对称**，所以不一刀切成同一级：
  //   · 清单要求、我没有  → **红**：我在消费一份官网认为该同步的东西而我根本没同步它
  //   · 我有、清单没表态  → **黄**：多镜像一份的最坏结果是白同步，而逐字节守卫仍然盯着它
  //     （当前就有一条：`skin/css/w3.css` 是 CSS 切片，不是 _lib 模块，清单没给它表态）
  //   把"多一份"也判红，会让这道闸在**官网补一行之前一直红**，而红久了就会被绕过。
  if (missing.length) { console.error(`🔴 官网清单要求镜像但我没有：${missing.join(", ")}\n   → 加进 MAP 并 \`npm run vendor:sync\``); err += missing.length; }
  if (extra.length) console.log(`⚠️ 我镜像了但官网清单未表态：${extra.join(", ")}（不拦；请官网在 ${MANIFEST_PATH} 里补一行）`);
  if (!missing.length) console.log(`✓ 清单对账  官网要求的 ${want.length} 个应镜像文件本地全有`);
} catch (e) {
  console.error(`🔴 **取不到官网镜像清单**（${MANIFEST_PATH}）：${e.message}`);
  console.error(`   ⚠️ 这是"查不到"，不是"你少镜像了文件" —— 网络/权限问题，不要据此去改 MAP。`);
  err++;
}

for (const [local, upstream, transform] of MAP) {
  let localBuf;
  try {
    localBuf = readFileSync(path.join(ROOT, local));
  } catch (e) {
    console.error(`🔴 缺失本地镜像 ${local}: ${e.message}`);
    err++;
    continue;
  }
  let upstreamBuf;
  try {
    upstreamBuf = await fetchUpstream(upstream, transform);
  } catch (e) {
    console.error(`🔴 拉取官网权威版失败 ${upstream}: ${e.message}`);
    err++;
    continue;
  }
  if (localBuf.equals(upstreamBuf)) {
    console.log(`✓ ${local}  ==  Wanew:main:${upstream}  (${localBuf.length}B)`);
  } else {
    drift++;
    console.error(`🔴 漂移 ${local} (${localBuf.length}B) ≠ Wanew:main:${upstream} (${upstreamBuf.length}B)`);
  }
}

if (err) {
  console.error(`\n⚠️ ${err} 个文件无法核对（网络/权威源不可达）——fail-closed，不放行。`);
  process.exit(2);
}
if (drift) {
  console.error(`\n🔴 ${drift} 个 vendor 文件已与官网 Wanew:main 漂移。官网是权威源，请重新同步：`
    + `\n   npm run vendor:sync   （然后核对 + commit；勿手改 vendor/）`);
  process.exit(1);
}
console.log(`\n✅ vendor 守卫 PASS：${MAP.length} 个镜像与官网 Wanew:main 逐字节一致。`);
