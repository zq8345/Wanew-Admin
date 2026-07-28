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

console.log("\n③ 跑三闸");
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
