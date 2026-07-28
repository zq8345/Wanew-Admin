/**
 * products-index.json 里【一条 manifest 条目长什么样】的唯一实现,以及缩略图的派生规则。
 * 双运行时:官网 regen(Node)与 Admin 的 Worker 都用这一份。纯模块,不碰文件系统。
 *
 * 🔴 为什么形状要收进一个函数,而不是两边"写得一样":
 *    admin 的条目形状比 `/products/` 迁移更早,于是它缺 `path` —— 而路由层正是靠那个字段
 *    做规范 URL 归一化。Joe 保存产品 650 之后,那个产品的旧链接**不是 301,是 404**。
 *    > **「逐字段相同」是个需要被检查的约定;「用同一份代码」是个不需要检查的事实。**
 *    连派生的【输入】也收进来:regen 用 `card_title || title`,admin 用 `title` ——
 *    今天恰好同结果,不是必然同结果。**能选就会选错,而选错的那天不会有人通知你。**
 *
 * 🔴 IO 不镜像,规则才镜像。存在性判断两边本来就不同(Node 查磁盘 / Worker 查 tree 与 R2 清单),
 *    硬统一才是错的 —— 所以存在性以函数注入,和 `dimAttr(src, sizes)` 同一个形状。
 *
 * 🔴🔴 **三态:true / false / null,而 null 不许被当成 false。**
 *    Admin 那边量到:`pages-list.json` 里一张图片都没有(611 条,含图片扩展名 0 条)。
 *    如果它拿那份清单当"文件存不存在"的回落,GitHub 抖一下拿不到 tree 时,
 *    每一张缩略图都会被回答"不存在" → 每保存一个产品 thumb 退回原图 → **650 的批量版**,
 *    而且触发条件是网络抖动:**随机发生、无法复现、保存成功、页面正常,只是悄悄变慢。**
 *    所以注入的判断函数返回 `null` 表示"查不到",而这里遇到 null **不回落、不猜,原样上报"我不知道"**。
 *    > **「查不到」和「不存在」必须能被区分 —— 把无知编码成一个具体答案,下游就再也发现不了。**
 */
import { productPath } from "./page-paths.js";

/** 缩略图文件名的派生规则(唯一实现):`x.jpg` → `x.thumb.webp`。 */
export function thumbName(src) {
  return String(src).replace(/\.[^.\/]+$/, ".thumb.webp");
}

/**
 * 卡片缩略图:存在就用,不存在回落原图,**查不到则返回 null(不是回落)**。
 * @param {{key?:string, src?:string}} im   图片条目
 * @param {string} imgBase                  R2 前缀
 * @param {{hasR2Thumb:(key:string)=>boolean|null, hasRepoFile:(path:string)=>boolean|null}} exists
 *        两个注入的存在性判断,各自可返回 true / false / null(= 查不到)
 * @returns {string|null} 图片地址;`null` = 无法判定,调用方必须保留原值而不是写一个默认值
 */
export function thumbFor(im, imgBase, exists) {
  if (!exists || typeof exists.hasR2Thumb !== "function" || typeof exists.hasRepoFile !== "function") {
    throw new Error("thumbFor: 需要注入 { hasR2Thumb, hasRepoFile } 两个判断函数(各返回 true/false/null)。" +
      "存在性两个运行时本来就不同,规则共享、IO 注入。");
  }
  const orig = im && im.key !== undefined ? imgBase + im.key : (im ? im.src : "");
  if (!orig) return "";
  if (im && im.key !== undefined) {                       // R2:查清单
    const tk = thumbName(im.key);
    const has = exists.hasR2Thumb(tk);
    if (has === null || has === undefined) return null;   // 🔴 查不到 ≠ 不存在
    return has ? imgBase + tk : orig;
  }
  const t = thumbName(orig);                              // 本仓静态文件
  if (t === orig) return orig;
  const has = exists.hasRepoFile(t.replace(/^\//, ""));
  if (has === null || has === undefined) return null;     // 🔴 同上
  return has ? t : orig;
}

/**
 * 一条 manifest 条目。**形状与 path 的派生输入都由这里决定**,调用方不再自己拼。
 * @param {object} prod              产品 JSON
 * @param {{thumb?:string|null, excerpt:string, i18n?:object, previous?:object}} parts
 *        thumb 传 `null` 或不传 = "算不出来" → 沿用 previous.thumb;两者都没有则抛。
 * @returns {object}
 */
export function manifestEntry(prod, parts) {
  const en = (prod.i18n && prod.i18n.en) || {};
  const { thumb, excerpt, i18n, previous } = parts || {};

  /* 🔴 thumb 算不出来时【沿用旧值】,而不是写原图。
     写原图看起来"安全",实际是把一次失败的查询变成一次真实的退化 —— 而退化后的值
     长得完全正常,没有任何检查会红。沿用旧值则是"这次我没有新信息",语义准确。
     ⚠️ 新产品既没有新值也没有旧值时**抛** —— 那种情况下任何默认都是编造。 */
  let finalThumb = thumb;
  if (finalThumb === null || finalThumb === undefined) {
    if (previous && previous.thumb !== undefined) finalThumb = previous.thumb;
    else {
      throw new Error(`manifestEntry: 产品 ${prod.id} 的 thumb 无法判定,且没有可沿用的旧值。` +
        "存在性查询返回了 null(查不到,不等于不存在)—— 请重试或修复存在性来源,不要写一个默认值。");
    }
  }

  const e = {
    id: prod.id,
    category: prod.category,
    form: prod.form,
    title: en.title,
    // 🔴 派生输入固定为 card_title || title —— 调用方没有机会选用哪个标题
    path: productPath(en.card_title || en.title, prod.id),
    ...(en.card_title ? { card_title: en.card_title } : {}),
    thumb: finalThumb,
    excerpt,
  };
  if (i18n && Object.keys(i18n).length) e.i18n = i18n;
  return e;
}
