// ── Cloudflare Access JWT 验签（阶段①：只观察，不拦人）──────────────────────
//
// 为什么要有这一层：现在的鉴权问的是「`cf-access-authenticated-user-email` 这个头在不在」，
// 而 **HTTP 头是可以伪造的**。白名单只把"能伪造成谁"从任何人收窄成名单上的那几个，
// 它回答的是"这个人是谁"，回答不了"这个头是真的吗"。
// 真正的证明是 `CF_Authorization` 这枚 JWT 的**签名**：它由 Cloudflare 团队租户的私钥签发。
//
// 🔴 而验签落地之后，白名单本身就是多余的 —— Access 策略成为唯一权威，
//    加人删人在 Cloudflare 控制台点一下就行，**不需要任何人改代码，也不需要我们还在**。
//    这正是 Joe 提这件事的原因，不是一个顺带的安全加固。
//
// ⚠️ 本文件在阶段①**不做任何拦截**：它只是把真相记下来。
//    分两步走是因为一次上强制的代价是"把 Joe 锁在他自己的后台外面"，
//    而观察一轮的代价只是一次发版。
import { spent } from "./subreq";

/** wanew-admin 这个 Access 应用的 AUD（总工从控制台取的）。 */
export const ACCESS_AUD = "9198c82bff0877ab614c0e4c4cda2d1ad1e4707185239e95bbb8b56056d19759";

/* 🔴 团队域**没有确定**，所以这里是候选而不是常量。
   实测：tejoy.cloudflareaccess.com → 404（README 里写的是它，说明团队改过名）
        wanewgroup.cloudflareaccess.com → 200，kids 91dca4c6… / 0da27153…
        wanew.cloudflareaccess.com      → 200，kids 985618b5… / 8dafed59…
   **后两个公钥指纹不同 ⇒ 是两个不同的租户，不是别名。选错 = 拿别人账号的公钥验票。**
   ⚠️ token 里的 `iss` 字段【是 token 自称的】，签名没验之前它不构成证据。
      所以阶段①的做法是：按 iss 猜一个先试（命中就停，正常只花 1 次），
      不中再试另一个，然后记下**谁的钥匙真的签了它** —— 那才叫实测出团队域。 */
export const TENANTS = ["wanewgroup", "wanew"] as const;
const certsUrl = (t: string) => `https://${t}.cloudflareaccess.com/cdn-cgi/access/certs`;

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlToJson = (s: string): any => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

/* JWKS 取回 + 缓存。
   ⚠️ 缓存是**必须能刷新**的：Cloudflare 会轮换密钥，钉死一份缓存＝密钥轮换那天全员被挡。
      刷新的触发是"这个 kid 我没见过"，而不是定时 —— 定时刷新在轮换当天仍有一个窗口。
   ⚠️ 但"没见过就回源"必须节流，否则**随便伪造一个 kid 就能让每个请求都回源**（放大攻击）。
   ⚠️ 这次 fetch 会计进本次请求的子请求预算（鉴权中间件跑在 withBudget 里面）——
      **不绕开计数器**：subreq.ts 自己写着"计数和花费是同一件事，不可能对不上"，绕过去就是让那句话变成假话。 */
const memJwks = new Map<string, { keys: any[]; at: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000;
let lastForcedRefresh = 0;
const FORCE_REFRESH_COOLDOWN_MS = 60 * 1000;

async function getJwks(tenant: string, wantKid: string | null): Promise<any[] | null> {
  const url = certsUrl(tenant);
  const hit = memJwks.get(url);
  const fresh = hit && Date.now() - hit.at < JWKS_TTL_MS;
  const kidMissing = wantKid && hit && !hit.keys.some((k: any) => k.kid === wantKid);
  const mayForce = kidMissing && Date.now() - lastForcedRefresh > FORCE_REFRESH_COOLDOWN_MS;
  if (fresh && !mayForce) return hit!.keys;
  if (mayForce) lastForcedRefresh = Date.now();
  try {
    const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } } as any);
    if (!res.ok) return hit ? hit.keys : null;
    const j: any = await res.json();
    const keys = Array.isArray(j?.keys) ? j.keys : [];
    if (!keys.length) return hit ? hit.keys : null;
    memJwks.set(url, { keys, at: Date.now() });
    return keys;
  } catch { return hit ? hit.keys : null; }
}

export interface JwtProbe {
  hasJwtHeader: boolean; hasCfAuthCookie: boolean; hasEmailHeader: boolean;
  present: boolean;                 // 到底有没有拿到一枚 token
  alg?: string; kid?: string;
  iss?: string; aud?: string[]; audMatch?: boolean;
  expOk?: boolean; verified?: boolean;
  tenantVerified?: string;          // 🔴 谁的钥匙**真的**签了它
  tenantsTried?: string[];
  email?: string; emailHeader?: string; emailAgrees?: boolean;
  authSubreq?: number;
  err?: string;                     // 失败时记**原话**，不归纳成 "failed"
}

/**
 * 阶段①：解析并尝试验签，把结果如实返回。**绝不抛、绝不拦。**
 * ⚠️ 返回值里**永远不含 token / cookie / 签名本身** —— 日志会进 Workers Logs，
 *    而那是一个能拿去换身份的东西。只记形态、结论、和身份 claim。
 */
export async function probeAccessJwt(req: Request): Promise<JwtProbe> {
  const before = spent();
  const jwtHeader = req.headers.get("cf-access-jwt-assertion");
  const cookie = req.headers.get("cookie") || "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  const emailHeader = req.headers.get("cf-access-authenticated-user-email") || undefined;
  const p: JwtProbe = {
    hasJwtHeader: !!jwtHeader,
    hasCfAuthCookie: !!m,
    hasEmailHeader: !!emailHeader,
    present: false,
    emailHeader,
  };
  const token = jwtHeader || (m ? m[1] : null);
  if (!token) { p.authSubreq = spent() - before; return p; }
  p.present = true;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) { p.err = `token 不是三段式，实得 ${parts.length} 段`; p.authSubreq = spent() - before; return p; }
    const head = b64urlToJson(parts[0]);
    const body = b64urlToJson(parts[1]);
    p.alg = head?.alg; p.kid = head?.kid;
    p.iss = body?.iss;
    p.aud = ([] as string[]).concat(body?.aud || []);
    p.audMatch = p.aud.includes(ACCESS_AUD);
    p.expOk = typeof body?.exp === "number" ? body.exp * 1000 > Date.now() : false;
    p.email = body?.email;
    p.emailAgrees = !!p.email && !!emailHeader && String(p.email).toLowerCase() === emailHeader.toLowerCase();

    // 按 iss 猜中的那个租户先试；不中再试另一个。
    const guess = TENANTS.find((t) => String(p.iss || "").includes(`//${t}.cloudflareaccess.com`));
    const order = guess ? [guess, ...TENANTS.filter((t) => t !== guess)] : [...TENANTS];
    p.tenantsTried = [];
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    for (const t of order) {
      p.tenantsTried.push(t);
      const keys = await getJwks(t, p.kid || null);
      if (!keys) continue;
      const jwk = keys.find((k: any) => k.kid === p.kid);
      if (!jwk) continue;
      try {
        const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        // 🔴 verify，不是 decode。只 decode 的代码在正例上表现完全正常。
        if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig as any, signed as any)) {
          p.verified = true; p.tenantVerified = t; break;
        }
      } catch (e: any) { p.err = `importKey/verify: ${String(e).slice(0, 120)}`; }
    }
    if (p.verified === undefined) p.verified = false;
  } catch (e: any) {
    p.err = String(e).slice(0, 200);      // 原话，不归纳
  }
  p.authSubreq = spent() - before;
  return p;
}

/* 记不记日志的判据。
   ⚠️ **白名单式**（只记文档 / API），不是黑名单式（排除 .css/.js/.png…）——
      黑名单会漏掉我没想到的扩展名，而"尺子只认识它知道的那几种"正是这套系统反复栽的地方。
   ⚠️ 但**验签是全量的**：不验静态资源，那就是一个没有门的口子。记不必全量，验必须全量。 */
export function isDocOrApi(req: Request): boolean {
  const u = new URL(req.url);
  if (u.pathname === "/" || u.pathname.startsWith("/api/")) return true;
  const dest = req.headers.get("sec-fetch-dest");
  if (dest === "document") return true;
  if (!dest && (req.headers.get("accept") || "").includes("text/html")) return true;
  return false;
}

/* 非文档请求里，**形态没见过的**也记一条。
   🔴 理由：阶段②要对全量请求验签，而静态资源**可能根本不带 cookie/头** ——
      那样②一上线，页面能开但每张图 403。只记文档请求就永远看不见这件事。
   ⚠️ 用形态签名去重，所以每种形态只记一条，不会淹掉日志。 */
const seenShapes = new Set<string>();
export function shapeIsNew(p: JwtProbe): boolean {
  const sig = [p.hasJwtHeader, p.hasCfAuthCookie, p.hasEmailHeader, p.present, p.verified, p.tenantVerified || "-"].join("|");
  if (seenShapes.has(sig)) return false;
  if (seenShapes.size > 50) return false;    // 有界：不让它变成内存泄漏
  seenShapes.add(sig);
  return true;
}
