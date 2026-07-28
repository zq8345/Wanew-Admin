// 只为 subreq.ts 声明用到的那一点点 —— 不引 @types/node：
// 它会把 Node 的 fetch/Response/Request 类型和 @cloudflare/workers-types 混在一起，
// 换来的是一堆似是而非的类型（运行时是 workerd，不是 Node）。要的是 AsyncLocalStorage 一个类。
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, fn: () => R): R;
  }
}
