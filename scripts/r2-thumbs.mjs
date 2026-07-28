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

// ── `--check <清单路径>`：清单漂移闸 ──────────────────────────────────────────
// 回答的是"**谁在什么时候更新那份清单**"里最危险的那一半：**没更新的时候，谁会告诉我。**
//
// 上传时会生成缩略图对象，但**上传路径不写清单** —— 清单必须由**枚举真实存在的对象**产生，
// 而"我刚 PUT 了所以它存在"是**意图**，不是事实（PUT 成功而清单提交失败，两边就永远对不上）。
// 代价是有个真实缺口：**新图有缩略图文件、清单里没有 → regen 回落原图 → 新图享受不到优化，且无症状。**
// 这个闸就是把那个缺口**变成会出声的**。它不修，只吼。
const CHECK = args.includes("--check") ? (args[args.indexOf("--check") + 1] || "") : "";
if (CHECK) {
  const idxUrl = "https://wanew.com/data/products-index.json";
  const res = await fetch(idxUrl);
  const body = await res.text();
  // ⚠️ 先断言材料有效：空响应/308 被吃掉，喂给下面的 diff 会得到"零漂移"——和真的零漂移一模一样
  if (!res.ok || body.length < 1000) { console.error(`🔴 products-index 取不到（${res.status} / ${body.length}B）——不出结论`); process.exit(1); }
  const idx = JSON.parse(body);
  if (!Array.isArray(idx) || idx.length < 10) { console.error(`🔴 products-index 条数异常：${idx.length}`); process.exit(1); }

  const mRaw = readFileSync(CHECK, "utf8");
  const manifest = JSON.parse(mRaw);
  // ⚠️ 用**消费方 regen 的读法**读清单（`new Set(m.keys)` 然后 has），不是我以为的形状
  const inManifest = new Set(manifest.keys || []);
  if (!inManifest.size) { console.error(`🔴 清单按消费方读法读出 0 条（${CHECK}）——形状可能又变了，不出结论`); process.exit(1); }

  // 只看 R2 那一半：`/static/…` 归官网侧管
  const r2 = idx.map((e) => e.thumb).filter((t) => t && /^https?:\/\/img\.wanew\.com\//.test(t));
  console.log(`清单漂移闸：products-index ${idx.length} 条 · 其中 R2 图 ${r2.length} 张 · 清单 ${inManifest.size} 条\n`);

  const alive = async (k) => { try { return (await fetch(`https://img.wanew.com/${k}`, { method: "HEAD" })).ok; } catch { return false; } };

  // ⚠️ products-index 的 thumb **是 regen 的产出，不是原图** —— 接管上线后它已经指向 `.thumb.webp`。
  //    上一版这里假设 thumb 永远是原图、再去派生 `.thumb.webp`，结果对已接管的图派生出
  //    `xxx.thumb.thumb.webp` —— 一个永远不存在、也永远不在清单里的 key，**两个判据同时落空 → 闸全绿**。
  //    所以要按 thumb 的**实际形态**分流，别假设它是哪一种。
  const missing = [], stale = [], broken = [];
  for (const url of r2) {
    const k = url.replace(/^https?:\/\/img\.wanew\.com\//, "");
    if (/\.thumb\.webp$/i.test(k)) {
      // regen 已选用缩略图：它必须真的存在（否则页面上就是 404），且必须在清单里（清单就是它的依据）
      if (!(await alive(k))) broken.push(k);
      else if (!inManifest.has(k)) missing.push(k + "（页面已在用、清单却没有）");
    } else {
      // regen 回落了原图：如果其实已有缩略图文件，就是白生成 —— 正是"上传了但清单没更新"的形态
      const tk = k.replace(/\.[a-z0-9]+$/i, "") + ".thumb.webp";
      if (await alive(tk)) missing.push(tk);
    }
  }
  // 状态③ 只能靠**遍历清单自己**抓到 —— 只遍历 products-index 派生出的 key，清单里的野条目永远碰不到
  for (const k of inManifest) if (!(await alive(k))) stale.push(k);

  const say = (n, list, why) => { console.log(`${list.length ? "🔴" : "✅"} ${n}：${list.length}${list.length ? "  ← " + why : ""}`); list.slice(0, 8).forEach((k) => console.log(`     ${k}`)); };
  say("有缩略图文件、但清单里没有", missing, "regen 会回落原图，这些图白生成了（无症状）");
  say("清单里有、但文件不存在", stale, "regen 会指向 404");
  say("页面正在用、但对象不存在", broken, "🔴 列表页图裂了");
  if (broken.length) process.exit(1);
  if (missing.length || stale.length) { console.error(`\n🔴 清单已漂移 —— 重跑一次生成（不带 --check）并把 data/r2-thumbs.json 提交到官网仓。`); process.exit(1); }
  console.log("\n✅ 清单与 R2 实际内容一致。");
  process.exit(0);
}

// 目标清单：外部传入（由 img-audit 产出），避免脚本自己猜该处理哪些
if (!LIST) { console.error("🔴 必须 --list <r2-targets.json> 或 --check <清单路径>"); process.exit(1); }
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
    // ⚠️ 形状由消费方定：regen 读的是 **`.keys` 数组**（`new Set(m.keys)` 然后 `has(thumbKey)`）。
    //    这段描述必须跟着真实形状走 —— 上一版这里写的是 `{原图key: 缩略图key}`，文件已经改成 .keys 了、
    //    描述没跟着改，重跑一次就把错描述又写回文件里。**读的人会信描述而不是去数结构。**
    _note: "R2 缩略图存在性清单。keys = **缩略图 key 的数组**（长边 960 webp）——形状由消费方 regen 定（它读 .keys）。" +
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

  // ── 尺寸元数据（同一次测量产出，不另跑一遍）─────────────────────────────
  // 官网 regen 只扫 `static/` 生成 media-sizes.json 且**全量覆写**，R2 的尺寸它量不到，
  // 我也不能写进那个文件（会被下次 regen 冲掉 = 又一个"两个写入方"）。所以单出一份、由 regen 合并。
  //
  // ⚠️ **两个 key 都要，且各配各自的真实尺寸** —— 消费方 `dimAttr(src, sizes)` 用 **src 原样**查：
  //    · 卡片 `dimAttr(e.thumb, …)` → regen 接管后 e.thumb 是**缩略图 URL** → 配**缩略图尺寸**
  //    · 详情页 `dimAttr(resolveImg(im), …)` → **原图 URL** → 配**原图尺寸**
  //    只给原图那一组，卡片就查不到 → 不写 width/height → **这 28 张的防 CLS 白做**（且无症状）。
  //    ⚠️ 绝不能把缩略图尺寸配到原图 key 上：`fit:inside` 下两者比例几乎相同，
  //       **写错了在今天不会有任何症状，直到有人换一张比例不同的图** —— 所以两组分开算、分开写。
  const IMGBASE = "https://img.wanew.com/";
  const sizes = {};
  const inManifest = new Set(out);
  for (const r of report) {
    if (r.err) continue;
    const [sw, sh] = r.srcDim.split("×").map(Number);
    const [tw, th] = r.outDim.split("×").map(Number);
    sizes[IMGBASE + r.key] = [sw, sh];                                   // 原图 URL → **原图**尺寸
    if (inManifest.has(r.thumbKey)) sizes[IMGBASE + r.thumbKey] = [tw, th];  // 缩略图 URL → **缩略图**尺寸
  }
  const sizesDoc = {
    _note: "R2(img.wanew.com) 图片的真实宽高，供 render.js 的 dimAttr 注 width/height 防 CLS。" +
      "官网 regen 只扫 static/ 且【全量覆写】data/media-sizes.json，所以 R2 这部分单出一份、由 regen 合并进 sizes（别写进那个文件，会被冲掉）。" +
      "⚠️ 键是 dimAttr 查询时用的**完整 URL 原样**：原图 URL 配【原图】尺寸（详情页图库用），缩略图 URL 配【缩略图】尺寸（列表卡用）。" +
      "两者比例几乎相同，配错了今天不会有任何症状，直到换一张比例不同的图——所以两组分开量、分开写。" +
      "只收真读出来的（sharp 解析成功），量不到的不进表：错的宽高比比没有更糟。",
    _generated_by: "wanew-admin/scripts/r2-thumbs.mjs（与缩略图同一次运行产出，不分两步跑）",
    sizes,
  };
  const sp = `${TMP}/r2-media-sizes.json`;
  writeFileSync(sp, JSON.stringify(sizesDoc, null, 2) + "\n");
  console.log(`   尺寸元数据：${Object.keys(sizes).length} 条（原图 ${report.filter((r) => !r.err).length} + 缩略图 ${inManifest.size}）→ ${sp}`);
}
