// ── git blob SHA：让"GitHub 存下的字节 == 我们发出去的字节"变成可证明的 ──────────
//
// 背景：`POST /git/trees` 用内联 `content` 建 blob 时**没有 `encoding` 字段**（blob API 有，显式 utf-8）。
// 产品数据里全是中文和 `ñ á ç ã`。若解释不一致，后果是**"保存成功"之后数据被静默写坏**。
//
// ⭐ 不用探针，用**确定性哈希**自证：
//    git 的 blob SHA = `sha1("blob " + 字节数 + "\0" + 字节)` —— 是**内容的函数**。
//    而 tree API 的响应里，每个 entry 都带 **GitHub 算出来的 sha**。
//    本地按 UTF-8 算出期望值，与响应比对：**相等 ⇒ 服务端存的字节与我们发的完全相同。**
//    密码学证明，不是抽样、也不用再 `GET /git/blobs` 读回来（零额外子请求）。
//
// ⭐ 它不是一次性验证，是**每次保存都在自证的永久闸**：
//    "验过一次"和"每次都对"是两回事 —— 一次性探针只证明那天那个字符集没问题，
//    以后新增语种、新增字符、GitHub 改行为，它一概不知道。
//
// ⚠️ 长度必须是**字节数**不是字符数：`"中".length === 1` 但 UTF-8 是 3 字节。
//    写成 `.length` 的话，纯 ASCII 全对、一遇中文就错 —— 正是最容易漏测的那种。

const HEX = "0123456789abcdef";
const toHex = (buf: ArrayBuffer): string => {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15];
  return s;
};

/** git 对一段内容会得到的 blob SHA-1（与 `git hash-object` 一致）。 */
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);          // UTF-8 字节
  const header = new TextEncoder().encode(`blob ${body.length}\0`);   // ⚠️ 字节数，不是 content.length
  const all = new Uint8Array(header.length + body.length);
  all.set(header, 0);
  all.set(body, header.length);
  return toHex(await crypto.subtle.digest("SHA-1", all));
}

/**
 * 比对 tree API 响应里 GitHub 算出的 sha 与本地期望值。
 * 返回不匹配的清单 —— **调用方必须在 POST commit 之前中止**：
 * 这道闸的全部价值就是拦在**不可逆那一步之前**，"警告一下继续提交"等于没有它。
 */
export async function verifyTreeShas(
  files: { path: string; content?: string; delete?: boolean }[],
  treeResp: { tree?: { path: string; sha: string }[] },
): Promise<{ path: string; expected: string; got: string }[]> {
  const got = new Map((treeResp.tree || []).map((n) => [n.path, n.sha]));
  const bad: { path: string; expected: string; got: string }[] = [];
  for (const f of files) {
    if (f.delete || f.content === undefined) continue;
    const expected = await gitBlobSha(f.content);
    const actual = got.get(f.path);
    // ⚠️ 缺失也算不匹配：`undefined !== expected` 会静默放过，必须显式当失败
    if (actual !== expected) bad.push({ path: f.path, expected, got: actual || "(响应里没有这个路径)" });
  }
  return bad;
}
