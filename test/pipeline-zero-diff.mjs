#!/usr/bin/env node
// #52 批2 常驻护栏（总工硬性要求）：「未改动数据时，双步管线(regen→chrome-sync)对产物应零差异」。
// 它抓的回归类型：render/chrome/数据任何一侧漂了 → admin 保存产品就会把漂移带上生产。
// 用法：node test/pipeline-zero-diff.mjs   （在 admin-worker/ 下跑；进发布前例行闸）
// 机制：git 工作区必须净 → 跑 regen → 跑 chrome-sync --write → git 工作区仍净 = PASS。
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

// ⚠️ 用 fileURLToPath 不用 URL.pathname——中文路径(C:\开发)会被 percent-encode(brand-swap 首版同坑)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sh = (cmd) => execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const dirty0 = sh("git status --porcelain").split("\n").filter((l) => l && !l.startsWith("??"));
if (dirty0.length) {
  console.error("🔴 前置失败：工作区不净（护栏需要干净基线）——先 commit/stash：\n" + dirty0.slice(0, 5).join("\n"));
  process.exit(2);
}
sh("node scripts/regen.mjs");
sh("node scripts/chrome-sync.mjs --write");
const dirty1 = sh("git status --porcelain").split("\n").filter((l) => l && !l.startsWith("??"));
if (dirty1.length) {
  console.error(`🔴 FAIL：未改数据跑双步管线产生 ${dirty1.length} 个文件差异 —— 管线与产物漂了，`
    + `admin 保存会把这些漂移带上生产。先对账再发：\n` + dirty1.slice(0, 10).join("\n"));
  process.exit(1);
}
console.log("✅ zero-diff 护栏 PASS：regen→chrome-sync 对产物零差异（管线==产物 不变量成立）");
