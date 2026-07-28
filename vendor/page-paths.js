/**
 * 产品页面路径的【唯一实现】—— slug 派生 + 页面路径拼接。双运行时:官网 regen(Node)
 * 与 Admin 的 Worker 都用这一份(Admin 经 vendor 镜像,漂移守卫按字节比对)。
 * ⚠️ 纯模块:不读文件系统、不用 Node API —— Worker 里跑得起来是硬约束。
 *
 * 🔴 **写入侧算,读取侧读 —— 这条是这个文件存在的全部理由。**
 *    仓里早就定过:「派生结果写进 data/products-index.json,到处读结果。
 *    **算一次、存下来、到处读 —— 比"到处算、指望算得一样"可靠**」。
 *    那条原则没变,变的是**谁是"算"的那一次**:
 *      · 新建产品 / 改标题 → Admin 就是那一刻,它必须算出 path 并写进 manifest
 *      · 渲染任何页面     → 读 entry.path，不重算
 *    ⚠️ 所以 Admin 需要的不是"每次渲染都调派生函数",而是**保存时算一次、并且别把它弄丢**。
 *
 * 🔴 而它现在正把它弄丢:admin 的 manifest entry 是固定形状
 *    `{id, category, form, title, thumb, excerpt}` —— **比 /products/ 迁移更早,没有 path**。
 *    实测:Joe 保存产品 650 之后,manifest 里那条的 path 消失,
 *    而路由层 `CANON = MANIFEST.filter(p => p.path)` 正是靠它做归一化 ——
 *    **那个产品的规范 URL 301 静默失效,直到下一次 regen 补回来。**
 *    → 所以 productPagePath 在 path 缺失时**抛**,不静默兜底:
 *      **一个能悄悄用错路径继续跑下去的函数,会把这个 bug 再藏一遍。**
 */

// 规则(总工 2026-07-28 定,+ 我补的两端处理):
//   ① 括号内容整块剥掉("(2 Pack)" 这类包装说明不是产品名)
//   ② 剥掉【开头】的填充词与纯数字包装词
//   ③ 取前 6 词 —— 不收到 5:少一个词换来的可读性,不抵丢掉一个信息词
//   ④ 🔴 再剥掉【末尾】的填充词。**这一条是补的**:原规则只说剥开头,
//      而剥掉开头的 for 之后取 6 词,会把句中另一个 for 拉到末尾 ——
//      `for-starlink-performance-adapter-gen-3` → `starlink-…-gen-3-for`。
//      **改规则要看两端**,和"改一个刻度点要看它两侧的整片区间"是同一条。
//   ⑤ 超 50 字符按【词边界】截断,不许截半个词;截完可能又露出填充词,再剥一次
//   ⑥ `starlink` 保留 —— 买家真会搜的词,不算噪音(实测 65/68 条含它)
//
// ⚠️ `2-in-1` 这类【规格】不是填充:它在标题里是连字符连着的一个词,不会被 ② 剥掉。
//    我第一版的检查判据 `/^\d/` 把它报成了违规 —— **判据太宽会把正确行为报成错误**。

const FILLER = /^(for|the|a|an|of|to|with|and|new|hot|pack|packs)$/;
const TRAIL = /-(?:for|the|a|an|of|to|with|and)$/;
const MAX = 50;


export function productSlug(title) {
  let w = String(title || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")        // ① 括号内容
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // ② 开头
  while (w.length && (FILLER.test(w[0]) || /^\d+$/.test(w[0]) || /^\d+-?packs?$/.test(w[0]))) w.shift();
  w = w.slice(0, 6);                   // ③
  while (w.length && FILLER.test(w[w.length - 1])) w.pop();   // ④ 末尾
  let out = w.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (out.length > MAX) {              // ⑤ 按词边界截
    const kept = [];
    for (const x of out.split("-")) { if ((kept.join("-") + "-" + x).length > MAX) break; kept.push(x); }
    out = kept.join("-");
  }
  while (TRAIL.test(out)) out = out.replace(/-[a-z]+$/, "");
  return out;
}

// 规范 URL 路径段:`{slug}-{id}`。
// 🔴 **编号做主,名字只是装饰** —— 路由只认末尾 `-{digits}`,前面的字随便。
//    所以改产品名、改机型、改品类,旧链接永远能解析回同一个产品。
export function productPath(title, id) {
  const s = productSlug(title);
  return s ? `${s}-${id}` : String(id);
}

// ── 页面路径 ────────────────────────────────────────────────────────────────
// dir = 语种目录("" | "es" | "pt" | "zh")，与 locale-dirs.mjs 的产出一致。
const withDir = (dir, rest) => (dir ? `${dir}/${rest}` : rest);

/** 产品详情页。**优先用已算好的 entry.path**；缺了就抛，不猜。 */
export function productPagePath(entry, dir = "") {
  const path = typeof entry === "string" ? entry : entry && entry.path;
  if (!path) {
    throw new Error(`productPagePath: entry 缺 path 字段${entry && entry.id ? `(id=${entry.id})` : ""}` +
      " —— 写入侧必须在保存时算出 path 并写进 manifest。静默兜底会把归一化失效再藏一遍。");
  }
  return withDir(dir, `products/${path}.html`);
}

/** 产品分类页。cat 是分类 slug（mini / cables / performance-gen-1 …）。 */
export function categoryPagePath(cat, dir = "") {
  return withDir(dir, `products/${cat}/index.html`);
}

/** 全部产品列表页。 */
export function listPagePath(dir = "") {
  return withDir(dir, "products/index.html");
}
