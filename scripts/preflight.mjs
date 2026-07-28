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

// ⑤ 上线就绪：**字节一致 ≠ 可以上线**
// 2026-07-28 现场：官网把逐文件 blob 换成 tree 内联 content 后，vendor 守卫立刻转绿（字节确实一致），
// 但那一版**没有任何校验** —— 内联 content 没有 `encoding` 字段，官网自己的注释都写着
// "这条是推论，不是文档明文"。此时发版 = 编码若错，**"保存成功"之后静默写坏三语数据**。
// **漂移守卫只比字节、不判对错；一道守卫的沉默，只覆盖它检查的那一维。**
// 于是"能不能发"不再靠谁记得拦一下。
//
// ⚠️ 这道闸自己的局限，写在这里而不是让它顶着一个更强的名义：
//    它检查的是"**代码在不在、位置对不对**"，**不是"它真的跑过、且判得对"**。
//    位置这一条有意义（校验必须在 `POST /git/commits` **之前** —— 拦在不可逆那一步前才叫闸），
//    但**一段永远返回"通过"的校验代码，也能让这道闸变绿。**真正的判据仍是运行时的 SHA 比对本身。
console.log("\n⑤ 上线就绪：内联 content 有没有配套校验");
{
  const gh = readFileSync("vendor/github.js", "utf8");
  const fn = (gh.match(/export async function commitFiles[\s\S]*?\n\}/) || [""])[0];
  const inline = /type: "blob", content:/.test(fn);        // 用了内联 content 吗
  // ⚠️ 算 SHA 的函数在 commitFiles **外面**（辅助函数），所以这里找的是**对它的调用**，
  //    不是 `digest(` 本身 —— 第一版在函数体里找 digest，对这份实现会误判成"没有闸"。
  const shaFn = (gh.match(/async function (\w*[Bb]lobSha\w*)\s*\(/) || [])[1];
  const iVerify = shaFn ? fn.indexOf(shaFn) : -1;
  const iCommit = fn.search(/git\/commits`/);              // 不可逆那一步
  if (!inline) {
    console.log("   ⚪ 未使用内联 content（走逐文件 blob，GitHub 显式 encoding:utf-8）—— 本闸不适用");
  } else if (iVerify < 0) {
    console.error("   🔴 用了内联 content，但 commitFiles 里没有 blob SHA 校验。");
    console.error("      → 内联 content 没有 encoding 字段，编码是推论；错了会在【保存成功之后】静默写坏数据。");
    console.error("      → 等官网带闸那一版；这是【不能上线】的红，不是漂移的红。");
    bad++;
  } else if (iCommit >= 0 && iVerify > iCommit) {
    console.error("   🔴 SHA 校验出现在 POST /git/commits 之后 —— 拦不住不可逆那一步，等于没有。");
    bad++;
  } else if (!/throw new Error\([^)]*(?:SHA|中止)/.test(fn)) {
    // 校验存在但不中止 = "警告一下继续提交"，等于没有闸
    console.error("   🔴 有 SHA 校验但不匹配时没有 throw —— 警告后继续提交，等于没有这道闸。");
    bad++;
  } else {
    console.log(`   ✅ 内联 content + SHA 校验(${shaFn})，校验在 POST /git/commits 之前，不匹配即中止`);
    console.log("      ⚠️ 本闸只看代码在不在、位置对不对、失败会不会抛，**不能证明它跑过、也不能证明它判得对**。");
  }
}

if (bad) { console.error(`\n🔴 ${bad} 道闸没过 —— 别报 deploy。`); process.exit(1); }
console.log(drifted
  ? "\n✅ 三闸全绿。镜像**本轮被同步过** —— 复核完签名与行为自查再报 deploy。"
  : "\n✅ 三闸全绿，镜像本来就是新的 —— 可以报 deploy。");
process.exit(0);
