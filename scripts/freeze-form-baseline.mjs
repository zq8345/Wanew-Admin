#!/usr/bin/env node
// 冻结「每个品类下有哪些产品」的基线 —— 给 `form` 存显示名 → 存 key 的迁移做验收标尺。
//
// ⚠️ 为什么要冻结、而不是迁移后现算：
//    迁移脚本自己算出来的"改前/改后"是同一套代码的产物，**自己出题又自己打分**。
//    基线要在**被测之外**：现在算好、连同真源 commit 一起提交进 git，迁移后拿它比。
//
// ⚠️ 为什么比 ID 集合、不只比计数（总工要求逐页计数相等，这里再收紧一格）：
//    21 个产品整体从 A 桶漏到 B 桶时，两桶计数**同时变**，逐页比对能抓到。
//    但若两个品类的产品数**恰好相同**，交换后每页计数都不变 —— 计数全绿，数据全错。
//    **比集合，不比基数。**
//
// 用法：node scripts/freeze-form-baseline.mjs <官网仓工作树路径> [ref]
//   产出 docs/baselines/form-membership.json（提交进 git）
import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";

const REPO = process.argv[2];
const REF = process.argv[3] || "origin/main";
if (!REPO) { console.error("🔴 用法：node scripts/freeze-form-baseline.mjs <官网仓路径> [ref]"); process.exit(1); }
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });

// 真源钉死：基线必须能说出"我是从哪一版算出来的"，否则日后对不上时无从判断是谁动了
const head = git("rev-parse", REF).trim();
const files = git("ls-tree", "-r", "--name-only", REF, "--", "data/products").trim().split("\n").filter(Boolean);
if (files.length < 10) { console.error(`🔴 产品文件只有 ${files.length} 个，材料可疑，不出基线`); process.exit(1); }

const byForm = {}, byId = {};
let noForm = 0;
for (const f of files) {
  const id = f.replace(/^.*\/(\d+)\.json$/, "$1");
  const j = JSON.parse(git("show", `${REF}:${f}`));
  const form = j.form;
  if (!form) { noForm++; continue; }
  (byForm[form] = byForm[form] || []).push(id);
  byId[id] = form;
}
for (const k of Object.keys(byForm)) byForm[k].sort((a, b) => Number(a) - Number(b));

const forms = JSON.parse(git("show", `${REF}:data/forms.json`));
const nameToKey = Object.fromEntries((forms.forms || []).map((f) => [f.name, f.key]));

const doc = {
  _note: "迁移验收基线：每个品类下的**产品 ID 集合**（不只是计数——两个品类产品数相同时，交换后计数不变而数据全错）。" +
    "迁移(form 存显示名→存 key)之后，用同一套集合逐一比对；**任何一个集合不同即失败**。" +
    "⚠️ 这份是在迁移**之前**、由与迁移脚本无关的代码算出来的：自己出题又自己打分的基线不作数。",
  _source: { repo: REPO, ref: REF, commit: head },
  _generated_by: "wanew-admin/scripts/freeze-form-baseline.mjs",
  // 迁移后 form 会变成 key，所以把当时的对照也冻进来 —— 否则日后无法判断"显示名→key"该怎么映射
  name_to_key: nameToKey,
  counts: Object.fromEntries(Object.entries(byForm).map(([k, v]) => [k, v.length])),
  membership: byForm,
};

if (!existsSync("docs/baselines")) mkdirSync("docs/baselines", { recursive: true });
writeFileSync("docs/baselines/form-membership.json", JSON.stringify(doc, null, 2) + "\n");

console.log(`基线已冻结 —— 真源 ${REF} @ ${head.slice(0, 10)}`);
console.log(`  产品文件 ${files.length}${noForm ? ` · 无 form 字段 ${noForm}（不进基线）` : ""}`);
for (const [k, v] of Object.entries(byForm)) console.log(`  ${String(v.length).padStart(3)}  ${k.padEnd(22)} → key=${nameToKey[k] || "🔴 forms.json 里没有这个显示名"}`);
const missing = Object.keys(byForm).filter((k) => !nameToKey[k]);
if (missing.length) { console.error(`\n🔴 有 ${missing.length} 个品类在 forms.json 里查不到 key —— 迁移会把它们变成 undefined，先查清再冻结`); process.exit(1); }
console.log(`\n✅ 写入 docs/baselines/form-membership.json（提交进 git）`);
