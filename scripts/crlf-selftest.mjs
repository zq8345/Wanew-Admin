#!/usr/bin/env node
// ── 闸的 CRLF 自检 ──────────────────────────────────────────────────────────
// 为什么在钉死行尾之后**还要**有它：
//   `.gitattributes` 让我这棵树永远是 LF —— 问题不再发生，**但我也再也测不到它了**。
//   而 `-text` 的镜像、别人的机器、CI、以及任何绕过 attributes 的取文件方式，仍可能是 CRLF。
//   **把一个变量钉死，和证明代码对那个变量不敏感，是两件事。** 前者防今天，后者防以后。
//
// 做法：把闸要读的文件复制成一棵**强制 CRLF** 的临时树，在那里跑同一个闸，
//       判据是**两边判定必须一致** —— 不是"CRLF 下也绿"，而是"和 LF 下给出同一个答案"。
//
// ⚠️ 判据选"一致"而不是"绿"：如果哪天闸本来就该红，这个自检不该因此失败。
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, execFileSync as run } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATES = ["scripts/token-lint.mjs"];   // 只列**按行读源码**的闸；逐字节比对的守卫不受行尾影响
const COPY = [
  "scripts/token-lint.mjs", "public/shell.css", "public/index.html", "public/w3-tokens.css",
  "vendor/github.js", "src/publish.ts", "src/index.ts", "src/gitsha.ts", "src/subreq.ts", "src/bytes.ts",
];

const exec = (file, args, cwd) => {
  try { return { code: 0, out: run(file, args, { encoding: "utf8", cwd }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") }; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crlf-selftest-"));
for (const f of COPY) {
  const src = path.join(ROOT, f), dst = path.join(tmp, f);
  if (!fs.existsSync(src)) { console.error(`🔴 自检材料缺失：${f}`); process.exit(1); }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const text = fs.readFileSync(src, "utf8");
  fs.writeFileSync(dst, text.split("\r\n").join("\n").split("\n").join("\r\n"));
}
// 材料校验：临时树必须真的是 CRLF，否则这次自检等于没跑
const probe = fs.readFileSync(path.join(tmp, "src/gitsha.ts"));
if (!probe.includes(Buffer.from("\r\n"))) { console.error("🔴 临时树没转成 CRLF —— 自检无效，不放行"); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); }

let bad = 0;
for (const g of GATES) {
  const lf = exec(process.execPath, [path.join(ROOT, g)], ROOT);
  const cr = exec(process.execPath, [path.join(tmp, g)], tmp);
  const same = lf.code === cr.code;
  if (!same) bad++;
  console.log(`   ${same ? "✓" : "🔴"} ${g}  LF exit=${lf.code} · CRLF exit=${cr.code}${same ? "" : "  ← 判定随行尾反转"}`);
  if (!same) console.log(cr.out.split("\n").filter((l) => /🔴/.test(l)).map((l) => "      " + l).join("\n"));
}
fs.rmSync(tmp, { recursive: true, force: true });
if (bad) { console.error(`\n🔴 ${bad} 道闸的判定依赖行尾 —— 它在你的树上和在别人的树上会给出不同答案。`); process.exit(1); }
console.log(`✅ CRLF 自检 PASS：${GATES.length} 道按行读源码的闸，LF 与 CRLF 下判定一致。`);
