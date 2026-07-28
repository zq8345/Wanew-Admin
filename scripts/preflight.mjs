#!/usr/bin/env node
// 起飞前检查 —— **报"待 deploy"之前必跑**。
// ─────────────────────────────────────────────────────────────────────────
// 为什么要有：官网在正常推进，镜像过期是必然而不是缺陷。但**让它在我手上被发现，
// 比在总工发版时被发现便宜一整个来回**（已经因此挡了三次发版）。
//
//   npm run preflight
//     ① 先 check：有漂移就把"漂了什么"打出来（**不闷头 sync** —— 要知道官网改了什么，
//        否则退化成"绿灯但不知道为什么绿"）
//     ② 有漂移则 sync，并提示必须复核导出签名 + 跑行为自查
//     ③ 真跑三闸（tsc / vendor 守卫 / 令牌纪律），全绿才 exit 0
import { execFileSync } from "child_process";
import { readFileSync } from "fs";

const run = (args, cwdOk = true) => {
  try { return { code: 0, out: execFileSync(process.execPath, args, { encoding: "utf8" }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") }; }
};
const runNpx = (args) => {
  try { return { code: 0, out: execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", args, { encoding: "utf8", shell: process.platform === "win32" }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") }; }
};
const show = (r) => console.log(r.out.trim().split("\n").map((l) => "   " + l).join("\n"));

console.log("① 先看漂移（不先 sync —— 要知道官网改了什么）");
const chk = run(["scripts/vendor.mjs", "check"]);
show(chk);
const drifted = chk.code !== 0;

if (drifted) {
  console.log("\n② 有漂移 → 同步");
  const sync = run(["scripts/vendor.mjs", "sync"]);
  show(sync);
  if (sync.code !== 0) { console.error("\n🔴 同步失败，停。"); process.exit(1); }
  console.log("   ⚠️ 镜像已更新 —— 提交前必须：");
  console.log("      (a) 复核我依赖的导出签名有没有变；");
  console.log("      (b) 跑「真模板 + 真产品 → grep 未解析 token」行为自查");
  console.log("          （判据看行为，不看签名：签名没变但模板依赖了新行为，一样会产坏页）。");
} else {
  console.log("\n② 无漂移，跳过同步");
}

// ③ ⭐ 输入一致性：闸跑在【工作区】，发版跑在【提交】——**两个不同的输入**。
// 只验工作区的话，"同步了但没提交"会让我这边全绿、总工 checkout 提交后闸红（真踩过一次）。
// 这不是"闸不干活"，是**闸干了活但验的不是将被发布的那份东西**——更隐蔽。
// 所以逐个比对：镜像文件的【工作区字节】必须等于【HEAD 里的字节】。
console.log("\n③ 输入一致性：我验的这份 = 总工要发的那份？");
const MIRRORS = ["vendor/render.js", "vendor/chrome.js", "vendor/github.js", "vendor/locale-dirs.mjs", "public/w3-tokens.css"];
let mismatch = 0;
for (const f of MIRRORS) {
  let wt, head;
  try { wt = readFileSync(f); } catch { console.error(`   🔴 ${f} 工作区缺失`); mismatch++; continue; }
  try { head = execFileSync("git", ["show", `HEAD:${f}`], { encoding: "buffer", maxBuffer: 1 << 26 }); }
  catch { console.error(`   🔴 ${f} 不在 HEAD 里（新文件未提交？）`); mismatch++; continue; }
  if (Buffer.compare(wt, head) === 0) console.log(`   ✓ ${f}  工作区 == HEAD  (${wt.length}B)`);
  else { console.error(`   🔴 ${f}  工作区 ${wt.length}B ≠ HEAD ${head.length}B —— **同步了但没提交**`); mismatch++; }
}
if (mismatch) {
  console.error(`\n🔴 ${mismatch} 个镜像的工作区与 HEAD 不一致。`);
  console.error(`   闸绿的是工作区，总工发的是提交 —— 现在报 deploy 会在他那边红。`);
  console.error(`   → git add ${MIRRORS.join(" ")} && commit`);
  process.exit(1);
}

console.log("\n④ 跑三闸");
let bad = 0;
const tsc = runNpx(["tsc", "--noEmit"]);
console.log(`   tsc            exit=${tsc.code}`); if (tsc.code) { show(tsc); bad++; }
const ven = run(["scripts/vendor.mjs", "check"]);
console.log(`   vendor 守卫     exit=${ven.code}`); if (ven.code) { show(ven); bad++; } else console.log("   " + ven.out.trim().split("\n").pop());
const tok = run(["scripts/token-lint.mjs"]);
console.log(`   令牌纪律        exit=${tok.code}`); if (tok.code) { show(tok); bad++; } else console.log("   " + tok.out.trim().split("\n").pop());

if (bad) { console.error(`\n🔴 ${bad} 道闸没过 —— 别报 deploy。`); process.exit(1); }
console.log(drifted
  ? "\n✅ 三闸全绿。镜像**本轮被同步过** —— 复核完签名与行为自查再报 deploy。"
  : "\n✅ 三闸全绿，镜像本来就是新的 —— 可以报 deploy。");
process.exit(0);
