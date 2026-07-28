// ── 子请求预算 ──────────────────────────────────────────────────────────────
// 起因（2026-07-28）：改品类显示名连着两天失败，真实原因是
//   `Too many subrequests by single Worker invocation.`
// 一次改名要 108 次子请求（loadCtx 10 + forms.json 1 + 列目录 1 + **逐个读 68 个产品** + 写 28），
// 而 Workers **免费版上限 50**。它在第 39 个产品那里被掐断 —— **中途炸**。
//
// 这次没留下半残数据（写入还没开始就断了，且 commitFiles 只有最后一次 PATCH 会动分支），
// **但那是运气**：只要断点再往后 40 次，就落在建 blob 的阶段。真正的保障不能靠断点位置。
//
// ⭐ 为什么包 fetch 而不是各处数数：
//    真正花掉配额的是**每一次 fetch**，包括 vendor/github.js 里的（那是官网镜像，逐字节守卫，我不能改）。
//    在各个端点手写"我大概要花多少次"，第一天就会和真实调用对不上，而且新增一处调用不会有人记得改。
//    包住 fetch = **计数和花费是同一件事**，不可能对不上。
//
// ⚠️ 已知不覆盖：R2/KV 这类 **binding 调用**也计入平台配额，但它们不走 fetch，这里数不到。
//    发布链路（本模块的用处所在）不碰 binding；媒体/上传那些路径碰，**那边的数字会偏低**。
//    宁可把这条写在这里，也不要让人以为它是全量的。
import { AsyncLocalStorage } from "node:async_hooks";

/** Workers 免费版：每次调用 50 次子请求（付费 1000）。 */
export const SUBREQ_LIMIT = 50;
/** 留给收尾、错误处理、以及数不到的 binding 调用。安全线 = 50 - 10 = 40。 */
export const HEADROOM = 10;

const als = new AsyncLocalStorage<{ n: number }>();
const realFetch = globalThis.fetch;
// 每次调用各算各的：AsyncLocalStorage 保证并发请求不会互相污染计数
// （模块级计数器在同一个 isolate 里会被并发请求共享 —— 那种"安全装置"本身就是错的）。
globalThis.fetch = ((input: any, init?: any) => {
  const s = als.getStore();
  if (s) s.n++;
  return realFetch(input, init);
}) as typeof fetch;

/** 把一次请求的处理过程包进独立计数域。 */
export const withBudget = <T>(fn: () => T): T => als.run({ n: 0 }, fn);

/** 本次调用**已经**花掉多少次子请求（实测，非估算）。 */
export const spent = (): number => als.getStore()?.n ?? 0;

/** 还能花多少次而不越安全线。 */
export const remaining = (): number => SUBREQ_LIMIT - HEADROOM - spent();

/**
 * 在**花掉之前**问一句：这一步还需要 `need` 次，负担得起吗？
 * 负担不起就返回一句人能照着做的话 —— 不是 "failed"，而是具体数字和下一步。
 */
export function afford(need: number, what: string): string | null {
  const used = spent(), limit = SUBREQ_LIMIT - HEADROOM;
  if (used + need <= limit) return null;
  return `这一步需要约 ${need} 次 GitHub 调用，本次已用 ${used} 次，` +
    `而 Cloudflare Workers 免费版每次请求最多 ${SUBREQ_LIMIT} 次（安全线 ${limit}）。` +
    `\n已在**写入开始前**拒绝，官网仓一个字节都没动。\n（${what}）`;
}
