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

// ─────────────────────────────────────────────────────────────────────────
// 存在性清单 —— **必须是事实，不是意图**
// ⚠️ 三条硬约束（总工定）：
//   ① 清单由「列举 R2 实际内容」生成，**不是记录脚本打算写什么**。
//      写失败的那张若被列进去 → regen 指过去 → **404**。所以这里**逐个回探公开 CDN**：
//      只有真的 200 + 真的是 webp（RIFF/WEBP 魔数）才进清单。这比"脚本说我写了"强，
//      也比列桶更贴近 regen 真正依赖的事实：**那个 URL 现在能不能被取到**。
//   ② 生成与写清单**在同一个脚本里**——分两步就能各自漂。
//   ③ 清单里没有的 key，regen 回落原图。
// 清单形态照 media-sizes.json 既有模式（构建期量好、作为数据穿进去），不新发明。
async function buildManifest(entries) {
  const out = [];
  let hit = 0, miss = 0;
  for (const r of entries) {
    if (r.err) { miss++; continue; }
    const url = `https://img.wanew.com/${r.thumbKey}`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) { miss++; console.warn(`   ✗ ${res.status} ${r.thumbKey}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const isWebp = buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
      if (!isWebp || !buf.length) { miss++; console.warn(`   ✗ 非 webp/空 ${r.thumbKey}`); continue; }
      out.push(r.thumbKey);   // ⚠️ 存**缩略图 key**，形状必须匹配消费方
      hit++;
    } catch (e) { miss++; console.warn(`   ✗ 探测失败 ${r.thumbKey} ${String(e).slice(0, 50)}`); }
  }
  return { out, hit, miss };
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

// 清单只在真写过之后才有意义（dry-run 时 R2 里根本没有那些对象）
if (WRITE) {
  console.log(`\n存在性清单：逐个回探公开 CDN（只有真取得到才进清单）`);
  const { out, hit, miss } = await buildManifest(report);
  const manifest = {
    _note: "R2 缩略图存在性清单。key = 原图 R2 key，value = 缩略图 key（长边 960 webp）。" +
      "由 wanew-admin 的 scripts/r2-thumbs.mjs 在生成缩略图后【逐个回探公开 CDN 确认真的取得到】才写入——" +
      "是事实不是意图，写失败的不会出现在这里。regen 用法：命中→用缩略图，未命中→回落原图（不会 404）。" +
      "⚠️ 只覆盖 R2(img.wanew.com) 那部分；/static/ 下的缩略图 regen 直接查磁盘，不在此清单。",
    _generated_by: "wanew-admin/scripts/r2-thumbs.mjs",
    long_edge: LONG_EDGE,
    // ⚠️ 字段名与形状由**消费方**定：regen 读 `JSON.parse(...).keys` 并 `has(缩略图key)`。
    //    我第一版写成 { thumbs: {原图key: 缩略图key} } —— 字段名和形状都不对，
    //    regen 会拿到 undefined → 空集合 → **28 张全部回落原图，不报错、这半永远不变快**。
    //    形状对不上不会崩，只会静默失效 —— 所以以消费方的读法为准，不以我觉得合理为准。
    keys: out,
  };
  const path = `${TMP}/r2-thumbs.json`;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`   进清单 ${hit} · 未进 ${miss}（未进的 regen 会回落原图）`);
  console.log(`   清单已生成：${path}  → 提交到官网仓 data/r2-thumbs.json`);
}
