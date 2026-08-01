/* 产品列表页的量尺。**贴进 devtools 控制台跑**（或用浏览器工具执行），返回一个对象 + 打印两张表。
 *
 * 🔴 它存在的理由不是"省事"，是**两个窗口量出同一个数**。
 *    2026-07-31：我报"首屏 12 行"，总工自己起本地量出 11 行。两边都没量错 ——
 *    我数"露出一部分就算可见"，他数"整行都在视口内"。**差的不是测量，是没人写下'可见'是什么意思。**
 *    ⇒ 定义写成可执行的代码放在这里，谁跑都一样。改定义 = 改这个文件 = 留痕。
 *
 * 用法：
 *    npm run ui-lab                   # 起测量台（127.0.0.1:8792，喂生产真数据）
 *    浏览器开 1440×900，控制台贴本文件内容
 */
(function () {
  "use strict";

  /* ── 冻结的判据。改这里之前先想清楚：旧读数会因此全部作废。 ── */
  const DEF = {
    /* 🔴「可见」= 整行都在视口内。露出一半不算。 */
    visible: (el, vh) => { const b = el.getBoundingClientRect(); return b.bottom <= vh && b.top >= 0; },
    /* 🔴「行距」= 节距，**含 1px 分隔线** —— 因为决定"塞得下几行"的是它，不是格子内容高。
          ⚠️ 规格 §4 那个 56 是 40+8+8 = 格子内容高，没算分隔线。同一件事两种量法：
             一个数字判据必须连着"量的是什么"一起写，否则它只是个数字。 */
    pitch: (el) => el.getBoundingClientRect().height,
    viewport: { w: 1440, h: 900 },
    maxPitch: 57,      // 节距上限（含分隔线）
    minRows: 12,       // 规格 §10① 首屏完整可见行数下限
    themes: ["light", "dark"],
  };

  const vw = innerWidth, vh = innerHeight;
  const rows = [].slice.call(document.querySelectorAll("#rows tr"));
  const setTheme = (t) => { document.documentElement.setAttribute("data-theme", t); document.body.getBoundingClientRect(); };
  const was = document.documentElement.getAttribute("data-theme");

  /* ⚠️ 先证材料有效再报数。未 settle 的帧会给出"缩略图 0px / 11 行"这种**全错但自洽**的读数，
        而它和真读数长得一模一样。样本不够就直接说无效，不给一个能被当成结论的数字。 */
  const invalid = [];
  if (vw !== DEF.viewport.w || vh !== DEF.viewport.h) invalid.push(`视口 ${vw}×${vh} ≠ 判据的 ${DEF.viewport.w}×${DEF.viewport.h}`);
  if (rows.length < 60) invalid.push(`只有 ${rows.length} 行，列表还没加载完（真数据 68 条）`);
  const t0 = document.querySelector("#rows .thumb");
  if (!t0 || !t0.getBoundingClientRect().width) invalid.push("缩略图渲染尺寸为 0 —— 这一帧还没排完版");
  if (invalid.length) { console.error("🔴 本次测量无效，下面的数一个都别用：\n  " + invalid.join("\n  ")); return { valid: false, why: invalid }; }

  /* 横向溢出：任何有宽度的元素右边界越过视口。0.5px 容差挡住亚像素噪声。 */
  const overflowOf = () => {
    const out = [];
    document.querySelectorAll("body *").forEach((e) => {
      const b = e.getBoundingClientRect();
      if (b.width > 0 && b.right > vw + 0.5) out.push((e.id ? "#" + e.id : e.tagName) + " right=" + b.right.toFixed(0));
    });
    return out;
  };
  /* 空轨道：auto-fill 的格子在项少时会留出空列。⚠️ 只查当前可见视图，隐藏视图的 rect 全是 0。 */
  const emptyTracksOf = () => {
    const out = [];
    document.querySelectorAll("#v-list *").forEach((e) => {
      const cs = getComputedStyle(e);
      if (cs.display.indexOf("grid") < 0 || !e.getBoundingClientRect().height) return;
      const tracks = cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length;
      if (tracks > e.children.length) out.push((e.className || e.tagName) + ` 轨道${tracks}>子${e.children.length}`);
    });
    return out;
  };

  /* 🔴 两个主题都量。版式判据总是在**某一个主题下**量的 —— 另一个主题不合格，量的人不会知道。
        2026-07-31 就是这么漏的：`width:44px` 只写在浅色里，于是深色 13 行、浅色 12 行，
        而"一屏能看几个产品跟着配色变"这件事，两边各自量各自的主题时都看不见。 */
  const per = {};
  for (const t of DEF.themes) {
    setTheme(t);
    const thumb = document.querySelector("#rows .thumb");
    const r0 = rows[0], pitch = DEF.pitch(r0), top = r0.getBoundingClientRect().top;
    const n = rows.filter((r) => DEF.visible(r, vh)).length;
    per[t] = {
      缩略图: getComputedStyle(thumb).width,
      表格上方: +top.toFixed(1),
      节距: +pitch.toFixed(1),
      完整可见: n,
      /* 🔴 余量当读数报，不当形容词 —— 但要分清是**哪一个**的余量：
            「第 N 行余量」小到 1px 只说明最后那行贴边；真正该看的是**判据余量**：
            上方还能再长多少才会跌破 minRows。上次我把前者写成"脆弱"就放过去了。 */
      第N行余量: +(vh - top - n * pitch).toFixed(1),
      判据余量: +(vh - DEF.minRows * pitch - top).toFixed(1),
      横向溢出: overflowOf().length,
      空轨道: emptyTracksOf().length,
    };
  }
  if (was) setTheme(was); else document.documentElement.removeAttribute("data-theme");

  const counts = DEF.themes.map((t) => per[t].完整可见);
  const R = {
    viewport: vw + "×" + vh,
    产品行数: rows.length,
    左栏徽标: (document.querySelector("#nav-todo-badge") || {}).textContent,
    "①两主题行数一致": counts.every((c) => c === counts[0]),
    "②完整可见 ≥ 12": counts.every((c) => c >= DEF.minRows),
    "③节距 ≤ 57": DEF.themes.every((t) => per[t].节距 <= DEF.maxPitch),
    "④无横向溢出": DEF.themes.every((t) => !per[t].横向溢出),
    "⑤无空轨道": DEF.themes.every((t) => !per[t].空轨道),
  };
  console.table(per);
  console.table(R);
  console.log("定义：可见 = bottom ≤ 视口底 且 top ≥ 0 · 节距含 1px 分隔线 · 节距 = max(缩略图, 标题两行 40) + 8 + 8 + 1");
  return { valid: true, 判据: R, 逐主题: per };
})();
