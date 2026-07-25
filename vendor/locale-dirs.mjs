// locale → 站点目录。唯一真源。
//
// ⚠️ 为什么单独成文件:chrome-sync 已经从 locales.json 派生了(`dir` 覆盖,否则取 loc 的语言段),
//    而 regen 里同一件事写成了 `(loc) => (loc === DEFAULT ? "" : "pt")` —— 一个硬编码的 "pt"。
//    两处实现同一条规则,加第三门语言时 regen 会把 es 页写进 /pt/。总工那条「清单本身就是那个
//    bug」在这里的形态是「同一条规则的第二份实现」。合成一份。
export const localeDirs = (locales) =>
  Object.fromEntries(locales.enabled.map((loc) =>
    [loc, loc === locales.default ? "" : (locales.dir || {})[loc] || loc.split("-")[0]]));
