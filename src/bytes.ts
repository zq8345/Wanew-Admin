// 长度只有一种正确含义：**字节数**。
//
// 2026-07-28 一天里同一个 bug 家族出现三次，全在处理同一批中文数据的系统里：
//   ① git blob header 的 `blob <len>\0` 用字符数 → 纯 ASCII 全对，一遇中文就错
//   ② 内联 content 的体积判断用 `.length` → 中文体积低估到三分之一，该走退路的判成内联
//   ③ 只用 ASCII 做测试 → 上面两个都完全隐形
//
// `"中".length === 1` 而 UTF-8 是 3 字节。**JS 的 `.length` 是 UTF-16 码元数，从来不是字节数。**
// 靠"记得用 TextEncoder"防第四次是不现实的 —— 给它一个名字，让写错的那一版看起来就不对。
export const byteLen = (s: string): number => new TextEncoder().encode(String(s ?? "")).length;
