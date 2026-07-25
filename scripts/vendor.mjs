#!/usr/bin/env node
// vendor 漂移守卫（A 方案·单真源保障，2026-07-24）
// ─────────────────────────────────────────────────────────────────────────
// vendor/ 是官网仓 zq8345/Wanew(main) 4 个共享库的**只读镜像**：
//   vendor/render.js  ← functions/_lib/render.js   （产品页渲染 + 列表 regen）
//   vendor/chrome.js  ← functions/_lib/chrome.js   （三语站壳 makeChrome）
//   vendor/github.js  ← functions/_lib/github.js   （GitHub API 原子提交/读文件）
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
// vendor 本地文件 ↔ 官网仓权威路径（1:1）
const MAP = [
  ["vendor/render.js", "functions/_lib/render.js"],
  ["vendor/chrome.js", "functions/_lib/chrome.js"],
  ["vendor/github.js", "functions/_lib/github.js"],
  ["vendor/locale-dirs.mjs", "scripts/locale-dirs.mjs"],
];

async function fetchUpstream(upstream) {
  const res = await fetch(`${BASE}/${upstream}`, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const mode = process.argv[2] || "check";

if (mode === "sync") {
  let ok = 0;
  for (const [local, upstream] of MAP) {
    const buf = await fetchUpstream(upstream); // 失败即抛，整体非 0 退出
    writeFileSync(path.join(ROOT, local), buf); // 字节精确写入，不做任何编码转换
    console.log(`↓ ${local}  ←  Wanew:main:${upstream}  (${buf.length}B)`);
    ok++;
  }
  console.log(`\n✅ 已同步 ${ok} 个 vendor 镜像。请跑 \`npm run guard:vendor\` 确认逐字节一致，并 commit。`);
  process.exit(0);
}

// mode === "check"
let drift = 0, err = 0;
for (const [local, upstream] of MAP) {
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
    upstreamBuf = await fetchUpstream(upstream);
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
