// ================= P2 GSC 集成（Google Search Console 只读看板）=================
// 服务账号 JWT(RS256, WebCrypto 手搓，不引 node 库) → access_token → searchAnalytics.query。
// 密钥=Cloudflare Secret GSC_SA_KEY(完整 service_account JSON，Joe 已存)；本模块只读、绝不回显 key。
// siteUrl=sc-domain:wanew.com(domain property)。GSC 数据日级、约 2-3 天延迟。

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function strB64url(str: string): string {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// 构造并签名 JWT（RS256, WebCrypto）——单独导出以便 node 单测签名路径（不含网络）
export async function buildSignedJwt(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: sa.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: sa.token_uri, exp: now + 3600, iat: now };
  const unsigned = strB64url(JSON.stringify(header)) + "." + strB64url(JSON.stringify(claim));
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return unsigned + "." + b64url(new Uint8Array(sig));
}

async function getAccessToken(sa: any): Promise<string> {
  const jwt = await buildSignedJwt(sa);
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${(await res.text()).slice(0, 140)}`);
  const j: any = await res.json();
  if (!j.access_token) throw new Error("no access_token in response");
  return j.access_token;
}

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

// 拉一次报表：totals(汇总) + 指定维度的 top 行。days=回溯天数；dim=query|page|country|device。
export async function gscQuery(saKeyJson: string, dim: string, days: number, rowLimit = 20) {
  let sa: any;
  try { sa = JSON.parse(saKeyJson); } catch { return { error: "GSC_SA_KEY 不是合法 JSON" }; }
  if (!sa.client_email || !sa.private_key || !sa.token_uri) return { error: "GSC_SA_KEY 缺 client_email/private_key/token_uri" };
  const token = await getAccessToken(sa);
  const siteUrl = encodeURIComponent("sc-domain:wanew.com");
  const end = new Date(Date.now() - 3 * 86400000);   // GSC ~2-3 天延迟
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const api = `https://searchconsole.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`;
  const call = async (dimensions: string[]) => {
    const res = await fetch(api, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ startDate: ymd(start), endDate: ymd(end), dimensions, rowLimit: dimensions.length ? rowLimit : 1 }),
    });
    if (!res.ok) throw new Error(`searchAnalytics ${res.status}: ${(await res.text()).slice(0, 140)}`);
    return (await res.json()) as any;
  };
  const [totalsResp, dimResp] = await Promise.all([call([]), call([dim])]);
  const t = (totalsResp.rows && totalsResp.rows[0]) || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const rows = (dimResp.rows || []).map((r: any) => ({ key: (r.keys && r.keys[0]) || "", clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
  return {
    range: { start: ymd(start), end: ymd(end), days },
    totals: { clicks: t.clicks || 0, impressions: t.impressions || 0, ctr: t.ctr || 0, position: t.position || 0 },
    dim, rows,
  };
}
