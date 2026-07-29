#!/usr/bin/env node
// ── C 步 2：把产品的 `form` 从【显示名】迁成【key】 ─────────────────────────────
//
// 为什么要迁：`form` 现在存的是显示名（"Mounts & Brackets"），于是**改一个显示字符串
// 要重写引用它的每一个产品文件** —— 68 个产品要读 68 次、写 23 个，一次改名 108 次子请求，
// 而 Workers 免费版上限 50。存 key 之后，改显示名只动 data/forms.json 一个文件。
//
// 🔴 **本地 node 脚本，绝不在 Worker 里跑。** 这是一次性数据迁移，运行时的限制不该约束它的实现方式。
//
// 🔴 **顺序不可颠倒**：官网读取侧必须**先**上线"key 与显示名两者都认"。
//    否则数据一改，线上按显示名匹配全部落空 —— 产品会从 /type/ 页整批消失。
//    本脚本**不检查那一步是否上线**（它检查不到），所以：`--write` 前人工确认。
//
// ⚠️ 回滚 = `git revert` 这一个 commit。脚本只改 `form` 一个字段、只在一个 commit 里，
//    就是为了让回滚是一条命令而不是一次考古。
//
//   node scripts/migrate-form-to-key.mjs <官网仓工作树>            dry-run（默认，不写）
//   node scripts/migrate-form-to-key.mjs <官网仓工作树> --write     真改
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { execFileSync } from "child_process";

const REPO = process.argv[2];
const WRITE = process.argv.includes("--write");
if (!REPO || !existsSync(REPO)) { console.error("🔴 用法：node scripts/migrate-form-to-key.mjs <官网仓工作树路径> [--write]"); process.exit(1); }
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 });
const rd = (rel) => readFileSync(path.join(REPO, rel), "utf8");

// ── 0. 前置断言：树必须干净 ────────────────────────────────────────────────
// 不干净时"改了什么"和"本来就有什么"分不开，而这次改动的全部价值在于它可被逐条核对。
const dirty = git("status", "--porcelain").trim();
if (dirty) { console.error("🔴 工作树不干净，停：\n" + dirty.split("\n").slice(0, 8).join("\n")); process.exit(1); }
console.log(`仓库 ${REPO}  分支 ${git("rev-parse", "--abbrev-ref", "HEAD").trim()} @ ${git("rev-parse", "--short", "HEAD").trim()}`);
console.log(`模式：${WRITE ? "🔴 真写" : "dry-run（不写）"}\n`);

// ── 1. 映射表：显示名 → key，来自 forms.json 本身 ───────────────────────────
const forms = JSON.parse(rd("data/forms.json")).forms || [];
const nameToKey = Object.fromEntries(forms.map((f) => [f.name, f.key]));
const keys = new Set(forms.map((f) => f.key));
if (!forms.length) { console.error("🔴 forms.json 里没有 forms —— 材料无效"); process.exit(1); }
console.log(`映射 ${forms.length} 条：${forms.map((f) => `${f.name}→${f.key}`).join(" · ")}\n`);

// ── 2. 逐个产品：只改 form，字节格式原样保留 ────────────────────────────────
// ⚠️ 保留原文的行尾与尾换行：JSON.stringify 会把两者都归一，而仓里 products/*.json 有尾换行、
//    products-index.json 没有 —— 归一掉就是一次无关的全量改动，把这次迁移的 diff 淹掉。
const matchFmt = (raw, obj) => {
  const tail = /\n$/.test(raw) ? "\n" : "";
  const body = JSON.stringify(obj, null, 2) + tail;
  return raw.includes("\r\n") ? body.replace(/\n/g, "\r\n") : body;
};

const files = git("ls-files", "data/products").trim().split("\n").filter((f) => /\/\d+\.json$/.test(f));
if (files.length < 10) { console.error(`🔴 只找到 ${files.length} 个产品文件，材料可疑`); process.exit(1); }

const changes = [], already = [], unknown = [], noForm = [];
for (const f of files) {
  const raw = rd(f);
  const j = JSON.parse(raw);
  const v = j.form;
  if (!v) { noForm.push(f); continue; }
  if (keys.has(v)) { already.push(f); continue; }          // 已经是 key（重跑本脚本时）
  const k = nameToKey[v];
  if (!k) { unknown.push(`${f}  form="${v}"`); continue; }  // 🔴 认不出的值：不猜，报出来
  j.form = k;
  changes.push({ file: f, from: v, to: k, content: matchFmt(raw, j) });
}

// manifest 里也有 form。它是 regen 的产物（会被全量重写），但**留着显示名会让仓库处于半迁移态**，
// 而"半迁移"和"迁移失败"在事后看长得一样。一起改，让这次 commit 自洽。
const MAN = "data/products-index.json";
const manRaw = rd(MAN);
const man = JSON.parse(manRaw);
let manTouched = 0;
for (const e of man) { if (e.form && !keys.has(e.form) && nameToKey[e.form]) { e.form = nameToKey[e.form]; manTouched++; } }

console.log(`产品文件 ${files.length} 个：待改 ${changes.length} · 已是 key ${already.length} · 无 form ${noForm.length} · 🔴 认不出 ${unknown.length}`);
unknown.forEach((u) => console.log("   " + u));
console.log(`manifest 条目待改 ${manTouched} / ${man.length}`);
if (unknown.length) { console.error("\n🔴 有认不出的 form 值 —— 它们迁移后会变成孤儿（官网 integrity 闸会 FAIL）。先查清再跑。"); process.exit(1); }

// ── 3. 验收：逐品类的**产品 ID 集合**必须与冻结基线一致 ─────────────────────
// ⚠️ 比集合不比计数：两个品类产品数恰好相同时，交换后每页计数都不变 —— 计数全绿而数据全错。
// ⚠️ 基线在**被测之外**：它是迁移前、由与本脚本无关的代码算出、连真源 commit 一起提交进 git 的。
const BASE = path.resolve(process.argv[1], "../../docs/baselines/form-membership.json");
const base = JSON.parse(readFileSync(BASE, "utf8"));
const after = {};
for (const f of files) {
  const id = f.replace(/^.*\/(\d+)\.json$/, "$1");
  const ch = changes.find((c) => c.file === f);
  const v = ch ? ch.to : JSON.parse(rd(f)).form;
  if (!v) continue;
  (after[v] = after[v] || []).push(id);
}
for (const k of Object.keys(after)) after[k].sort((a, b) => Number(a) - Number(b));

let bad = 0;
console.log(`\n验收（基线 ${base._source.ref} @ ${base._source.commit.slice(0, 10)}，比【ID 集合】不比计数）：`);
for (const [name, ids] of Object.entries(base.membership)) {
  const key = base.name_to_key[name];
  const got = after[key] || [];
  const same = JSON.stringify(got) === JSON.stringify(ids);
  if (!same) bad++;
  console.log(`  ${same ? "✓" : "🔴"} ${name.padEnd(20)} → ${String(key).padEnd(12)} 基线 ${ids.length} 个 · 迁移后 ${got.length} 个${same ? "" : `\n      基线: ${ids.join(",")}\n      实际: ${got.join(",")}`}`);
}
const strayKeys = Object.keys(after).filter((k) => !Object.values(base.name_to_key).includes(k));
if (strayKeys.length) { bad++; console.log(`  🔴 出现基线里没有的 form 值：${strayKeys.join(", ")}`); }
if (bad) { console.error(`\n🔴 ${bad} 项与基线不符 —— 不写入。`); process.exit(1); }
console.log(`  ✅ ${Object.keys(base.membership).length} 个品类的 ID 集合与基线完全一致`);

// ── 4. 写 ────────────────────────────────────────────────────────────────
if (!WRITE) {
  console.log(`\ndry-run 结束。真改：加 --write`);
  console.log(`⚠️ 跑之前人工确认：官网读取侧「key 与显示名两者都认」**已经上线**。`);
  console.log(`   本脚本检查不到那一步 —— 它上线之前迁移，线上按显示名匹配会全部落空。`);
  process.exit(0);
}
for (const c of changes) writeFileSync(path.join(REPO, c.file), c.content);
if (manTouched) writeFileSync(path.join(REPO, MAN), matchFmt(manRaw, man));
console.log(`\n✅ 已写 ${changes.length} 个产品文件${manTouched ? ` + ${MAN}` : ""}`);
console.log(`   下一步：git diff 逐条核 → 提交成**一个** commit（回滚 = git revert 它）`);
console.log(`   ⚠️ 提交信息里写明基线 commit ${base._source.commit.slice(0, 10)}，否则日后无从判断验收依据。`);
