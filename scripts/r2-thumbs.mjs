#!/usr/bin/env node
// R2 缩略图回填 —— **一次性本地任务**，不在 Worker 运行时里跑。
// ─────────────────────────────────────────────────────────────────────────
// Worker 没有 sharp，但**回填根本不需要在 Worker 里发生**：本地 sharp + wrangler r2 object put。
// 运行时的限制不该约束一次性任务的实现方式。
//
//   node scripts/r2-thumbs.mjs --limit 5          先跑 5 张（默认 dry-run，不写）
//   node scripts/r2-thumbs.mjs --limit 5 --write  真写这 5 张
//   node scripts/r2-thumbs.mjs --write            全量
//
// 规格（与官网侧那半统一）：长边 960 · webp · `<base>.thumb.webp` **新增不替换** · **原图一个字节不动**。
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { createHash } from "crypto";
import sharp from "sharp";

const BUCKET = "tejoy-images";
const LONG_EDGE = 960;
const QUALITY = 82;
const TMP = "./.thumbtmp";
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const LIMIT = Number((args[args.indexOf("--limit") + 1]) || 0) || 0;
const LIST = args[args.indexOf("--list") + 1] || "";

if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const kb = (n) => (n / 1024).toFixed(0) + "KB";
const wr = (a) => execFileSync(process.platform === "win32" ? "npx.cmd" : "npx",
  ["--no-install", "wrangler", ...a], { encoding: "buffer", shell: process.platform === "win32", maxBuffer: 1 << 28 });

// 目标清单：外部传入（由 img-audit 产出），避免脚本自己猜该处理哪些
if (!LIST) { console.error("🔴 必须 --list <r2-targets.json>"); process.exit(1); }
const raw = readFileSync(LIST, "utf8");
if (raw.length < 50) { console.error("🔴 清单材料无效：" + raw.length + "B"); process.exit(1); }
let targets = JSON.parse(raw);
if (!Array.isArray(targets) || !targets.length) { console.error("🔴 清单为空"); process.exit(1); }
if (LIMIT) targets = targets.slice(0, LIMIT);

console.log(`模式：${WRITE ? "🔴 真写" : "dry-run（不写）"} · 目标 ${targets.length} 张 · 长边 ${LONG_EDGE} webp q${QUALITY}\n`);

const report = [];
for (const [i, t] of targets.entries()) {
  const key = t.key;
  const thumbKey = key.replace(/\.[a-z0-9]+$/i, "") + ".thumb.webp";
  const local = `${TMP}/src_${i}`;
  try {
    // 1) 取原图
    wr(["r2", "object", "get", `${BUCKET}/${key}`, "--file", local, "--remote"]);
    const src = readFileSync(local);
    if (!src.length) throw new Error("取到 0 字节");
    const srcSha = sha(src);
    const meta = await sharp(src).metadata();

    // 2) 生成缩略图（长边 960，不放大）
    const out = await sharp(src)
      .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: QUALITY }).toBuffer();
    const outMeta = await sharp(out).metadata();

    // 3) 写回（**新 key**，原图不碰）
    if (WRITE) {
      const outFile = `${TMP}/out_${i}.webp`;
      writeFileSync(outFile, out);
      wr(["r2", "object", "put", `${BUCKET}/${thumbKey}`, "--file", outFile, "--content-type", "image/webp", "--remote"]);
    }

    // 4) 原图未变（重新取一次比 sha —— 只有真写过才值得验）
    let srcUnchanged = "未验(dry-run)";
    if (WRITE) {
      const local2 = `${TMP}/verify_${i}`;
      wr(["r2", "object", "get", `${BUCKET}/${key}`, "--file", local2, "--remote"]);
      srcUnchanged = sha(readFileSync(local2)) === srcSha ? "✅ 未变" : "🔴 变了!";
    }

    report.push({ key, thumbKey, srcBytes: src.length, srcDim: `${meta.width}×${meta.height}`, srcFmt: meta.format,
      outBytes: out.length, outDim: `${outMeta.width}×${outMeta.height}`, saved: src.length - out.length, srcUnchanged });
    console.log(`  ${String(i + 1).padStart(2)}. ${kb(src.length).padStart(7)} ${String(meta.width + "×" + meta.height).padStart(10)} ${meta.format.padEnd(5)}` +
      ` → ${kb(out.length).padStart(7)} ${String(outMeta.width + "×" + outMeta.height).padStart(9)} webp` +
      `  省 ${kb(src.length - out.length).padStart(7)}  原图${srcUnchanged}`);
  } catch (e) {
    report.push({ key, err: String(e).slice(0, 140) });
    console.error(`  ${String(i + 1).padStart(2)}. 🔴 ${key.slice(-40)} → ${String(e).slice(0, 90)}`);
  }
}

const ok = report.filter((r) => !r.err);
const srcTotal = ok.reduce((a, r) => a + r.srcBytes, 0);
const outTotal = ok.reduce((a, r) => a + r.outBytes, 0);
console.log(`\n成功 ${ok.length}/${report.length}`);
console.log(`原图合计 ${(srcTotal / 1048576).toFixed(2)}MB → 缩略图合计 ${(outTotal / 1048576).toFixed(2)}MB` +
  `  省 ${(1 - outTotal / srcTotal ? ((srcTotal - outTotal) / 1048576).toFixed(2) : 0)}MB（${((1 - outTotal / srcTotal) * 100).toFixed(0)}%）`);
if (WRITE) {
  const bad = ok.filter((r) => r.srcUnchanged !== "✅ 未变");
  console.log(bad.length ? `🔴 ${bad.length} 张原图 sha 变了 —— 立即停手排查` : `✅ 全部原图 sha 未变（${ok.length} 张逐个复取比对）`);
}
writeFileSync(`${TMP}/report.json`, JSON.stringify(report, null, 1));
console.log(`明细：${TMP}/report.json`);
