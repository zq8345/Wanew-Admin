/* 产品列表页的量尺。**贴进 devtools 控制台跑**（或用浏览器工具执行），返回一个对象 + 打印一张表。
 *
 * 🔴 它存在的理由不是"省事"，是**两个窗口量出同一个数**。
 *    2026-07-31：我报"首屏 12 行"，总工自己起本地量出 11 行。两边都没量错 ——
 *    我数"露出一部分就算可见"，他数"整行都在视口内"。**差的不是测量，是没人写下'可见'是什么意思。**
 *    ⇒ 定义写成可执行的代码放在这里，谁跑都一样。改定义 = 改这个文件 = 留痕。
 *
 * 用法：
 *    node tools/ui-lab.mjs            # 起测量台（127.0.0.1:8792，喂生产真数据）
 *    浏览器开 1440×900，控制台贴本文件内容
 */
(function () {
  "use strict";

  /* ── 冻结的定义。改这里之前先想清楚：旧读数会因此全部作废。 ── */
  const DEF = {
    /* 🔴「可见」= 整行都在视口内（bottom ≤ 视口底）。露出一半不算。 */
    fullyVisible: (el, vh) => el.getBoundingClientRect().bottom <= vh,
    /* 🔴「行距」= 节距，含 1px 分隔线 —— 因为决定"塞得下几行"的是它，不是格子内容高。
          ⚠️ 规格 §4 那个「带缩略图 56px」是 40+8+8，没算发丝线；按节距量最小行是 57px。 */
    pitch: (el) => el.getBoundingClientRect().height,
    viewport: { w: 1440, h: 900 },
  };

  const vw = innerWidth, vh = innerHeight;
  const rows = [].slice.call(document.querySelectorAll("#rows tr"));

  /* ⚠️ 先证材料有效再报数。未 settle 的帧会给出"缩略图 0px / 11 行"这种全错但自洽的读数，
        而它和真读数长得一模一样。样本不够就直接说无效，不给一个能被当成结论的数字。 */
  const invalid = [];
  if (vw !== DEF.viewport.w || vh !== DEF.viewport.h) invalid.push(`视口 ${vw}×${vh} ≠ 判据的 ${DEF.viewport.w}×${DEF.viewport.h}`);
  if (rows.length < 60) invalid.push(`只有 ${rows.length} 行，列表还没加载完（真数据 68 条）`);
  if (rows.length && DEF.pitch(rows[0]) < 20) invalid.push("首行高度 <20px，这一帧还没排完版");
  if (invalid.length) { console.error("🔴 本次测量无效，下面的数一个都别用：\n  " + invalid.join("\n  ")); return { valid: false, why: invalid }; }

  const r0 = rows[0];
  const pitch = DEF.pitch(r0);
  const top = r0.getBoundingClientRect().top;
  const n = rows.filter((r) => DEF.fullyVisible(r, vh)).length;
  const thumb = document.querySelector("#rows .thumb");
  const thead = document.querySelector("#v-list thead");

  /* 横向溢出：任何有宽度的元素右边界越过视口。0.5px 容差挡住亚像素噪声。 */
  const overflow = [];
  document.querySelectorAll("body *").forEach((e) => {
    const b = e.getBoundingClientRect();
    if (b.width > 0 && b.right > vw + 0.5) overflow.push((e.id ? "#" + e.id : e.tagName) + " right=" + b.right.toFixed(0));
  });

  /* 空轨道：auto-fill 的格子在项少时会留出空列。⚠️ 只查当前可见视图，隐藏视图的 rect 全是 0。 */
  const emptyTracks = [];
  document.querySelectorAll("#v-list *").forEach((e) => {
    const cs = getComputedStyle(e);
    if (cs.display.indexOf("grid") < 0 || e.getBoundingClientRect().height === 0) return;
    const tracks = cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length;
    if (tracks > e.children.length) emptyTracks.push((e.className || e.tagName) + ` 轨道${tracks}>子${e.children.length}`);
  });

  /* 徽标必须与筛选结果同源。两处各算一遍就会各自漂，这里只核对结果。 */
  const badge = document.querySelector("#nav-todo-badge");
  const badgeN = badge ? Number(badge.textContent || 0) : null;

  const R = {
    valid: true,
    viewport: vw + "×" + vh,
    theme: document.documentElement.getAttribute("data-theme"),
    产品行数: rows.length,
    表格上方: +top.toFixed(1),
    表头高: thead ? +thead.getBoundingClientRect().height.toFixed(1) : null,
    缩略图: thumb ? getComputedStyle(thumb).height : "无",
    行距_含发丝线: +pitch.toFixed(1),
    完整可见行数: n,
    /* 🔴 余量当读数报，不当形容词。"12 行余 3px"和"12 行余 10px"是两个不同的结论。 */
    余量: +(vh - top - n * pitch).toFixed(1),
    横向溢出: overflow.length ? overflow : 0,
    空轨道: emptyTracks.length ? emptyTracks : 0,
    左栏徽标: badgeN,
  };
  console.table(R);
  console.log("定义：可见 = bottom ≤ 视口底 · 行距 = 节距(含 1px 分隔线) · 行距 = max(缩略图, 标题两行 40) + 8 + 8 + 1");
  return R;
})();
