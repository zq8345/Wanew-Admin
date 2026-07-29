// 总工 §四 定死的验收判据，做成可重复跑的闸：
//   ③c 删完后，磁盘上不存在任何一条【301 映射表 from 所指向的文件】，剩余数 = 0。
//
// 🔴 oracle 是 `data/product-redirects.json`（regen 产出页面的同一次运行里生成），
//    **不是形状正则**。我和总工各用各的正则数同一批东西，两个数都错、且不一致，
//    错的还是同一个文件（video/39.html）——⇒ 正解不是收紧正则，是换 oracle。
//
// ⚠️ 用法：③c 上线【之前】跑 → 应报 227（非零）。这是这把尺子的正对照。
//         ③c 上线【之后】跑 → 应报 0。**没先见过非零的 0 不作数。**
import { execFileSync } from "child_process";
const R = "C:/开发/wanew-thumbs";
const git = (a) => execFileSync("git", a, { cwd: R, encoding: "utf8", maxBuffer: 1 << 30 });
git(["fetch", "-q", "origin", "main"]);
const head = git(["rev-parse", "--short", "origin/main"]).trim();
const has = new Set(git(["ls-tree", "-r", "--name-only", "-z", "origin/main"]).split("\0").filter(Boolean));

// 表的位置：默认 origin/main；表还没合进 main 时用 `node scripts/redirect-residue-check.mjs <ref>` 指定。
// ⚠️ 取不到就中止 —— **"取不到"和"表是空的"必须区分开**，后者会让剩余数天然为 0。
const REF = process.argv[2] || "origin/main";
let tbl;
try { tbl = JSON.parse(git(["show", `${REF}:data/product-redirects.json`])); }
catch { console.log(`🔴 取不到 ${REF}:data/product-redirects.json —— **这是取不到，不是没有**。停。`); process.exit(2); }

// 真实形状：{_note, _generated_by, _count, redirects: { "/from": "/to" }} —— redirects 是**对象**。
// ⚠️ 第一版我写了一串"形状容错"去猜，猜错了（把整个 redirects 当成 1 条），
//    然后"没有 from 可查"让剩余数天然为 0，闸打印了 **✅ 删净了**。
//    ⇒ **容错解析 + 空集合 = 免费的绿灯。** 不猜形状，认死它，认不出就中止。
if (!tbl.redirects || typeof tbl.redirects !== "object" || Array.isArray(tbl.redirects)) {
  console.log("🔴 表的形状不是 {redirects:{from:to}} —— 不猜，中止。"); process.exit(2);
}
const froms = Object.keys(tbl.redirects);
console.log(`origin/main=${head} · 映射表 ${froms.length} 条（_count 声明 ${tbl._count}）`);
// 🔴 自检失败必须【中止】。第一版我只 console.log 了一声就继续跑 —— 吼了但不拦，等于没拦。
if (Number(tbl._count) !== froms.length) {
  console.log(`🔴 _count(${tbl._count}) ≠ 实际(${froms.length}) —— 表自己不自洽，中止。`); process.exit(2);
}
if (froms.length === 0) { console.log("🔴 一条 from 都没有 —— 空集合会让剩余数天然为 0，中止。"); process.exit(2); }

// from 是 URL 路径（/mini/650/ 之类）→ 换算成磁盘文件
const toFile = (from) => {
  let p = String(from).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p) return "index.html";
  return /\.html$/.test(p) ? p : (/\/\d+$/.test(p) || !p.includes("/") ? `${p}.html` : `${p}/index.html`);
};
// ⚠️ 一条 from 可能对应 `{p}.html` 或 `{p}/index.html` 两种落法 —— 两种都算"还在"，
//    只判一种会把仍然存在的文件报成已删（假绿）。
const candidates = (from) => { const p = String(from).replace(/^\/+/, "").replace(/\/+$/, ""); return p ? [`${p}.html`, `${p}/index.html`, p] : ["index.html"]; };

const remaining = froms.filter((f) => candidates(f).some((c) => has.has(c)));
const bucket = (f) => /\/\d+\/?$/.test(f) ? "详情页" : (/\/type\//.test(f) ? "type 品类页" : "机型列表页");
const tally = {}; remaining.forEach((f) => tally[bucket(f)] = (tally[bucket(f)] || 0) + 1);
const zh = froms.filter((f) => /^\/zh\//.test(f));
const zhGone = zh.filter((f) => !candidates(f).some((c) => has.has(c)));

console.log(`\n映射表 from 所指文件，磁盘上【仍存在】的：${remaining.length}`);
for (const [k, v] of Object.entries(tally)) console.log(`   ${k.padEnd(14)} ${v}`);
console.log(`\nzh 条目 ${zh.length} 条 · 其中文件本就不在磁盘上 ${zhGone.length} 条（总工：那 4 条只需 301，无页可删）`);
console.log(`\n${remaining.length === 0
  ? "✅ 剩余 0 —— ③c 删净了。⚠️ 只有在此之前见过非零，这个 0 才作数。"
  : `⚠️ 剩余 ${remaining.length} —— ③c 尚未上线（这正是这把尺子的正对照：它会报非零）。`}`);
remaining.slice(0, 3).forEach((f) => console.log(`   例: ${f}`));

// 退出码：0=删净 · 1=还有残留 · 2=尺子本身不可信（表取不到/不自洽/为空）
// ⚠️ **③c 之前 exit 1 是正确答案，不是失败** —— 它证明这把尺子会报非零。
//    区分 1 和 2 是有意的：1 是"被测对象还没做完"，2 是"我量不了"，两者不能混成一个红。
process.exit(remaining.length === 0 ? 0 : 1);
