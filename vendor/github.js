// Minimal GitHub client for the admin CRUD: read a file, and commit a SET of files
// atomically (Git Data API: blobs -> tree -> commit -> update ref). One commit = one
// CF Pages deploy, so an edit regenerates its pages and ships them together.
//
// Env (Joe sets in CF Pages, kept out of the repo):
//   GITHUB_TOKEN  fine-grained PAT with Contents:write on the wanew repo
//   GITHUB_REPO   "zq8345/tejoy"
//   GITHUB_BRANCH "main"   (optional, defaults to main)

const API = "https://api.github.com";

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "tejoy-admin",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function ghConfig(env) {
  const repo = env.GITHUB_REPO;
  if (!env.GITHUB_TOKEN || !repo) return null;
  const [owner, name] = repo.split("/");
  return { owner, name, branch: env.GITHUB_BRANCH || "main" };
}

/* git 的 blob SHA:sha1("blob " + 字节数 + "\0" + 内容)。零依赖,crypto.subtle 即可。
   🔴 **长度是【字节数】不是【字符数】。** `"中".length === 1` 而它是 3 个 UTF-8 字节。
      写成 `content.length` 在**纯 ASCII 下永远算对** —— 而这个仓的数据几乎全是非 ASCII,
      于是这个 bug 只会在真实数据上出现,只会在测试数据上隐身。
      这里用 `TextEncoder().encode()` 的长度,它天然就是字节数。
   ⚠️ 尺子本身是零凭据证准的:git 用的就是这个算法,**仓里每个文件现有的 SHA 就是标准答案**。
      实测 data/forms.json 与 data/products/4199.json 精确命中 `git hash-object`;
      而故意写成字符数的版本,三个非 ASCII 文件全部不匹配 —— 正反两向都验过。
   ⚠️ 验的时候踩过一次对照物的坑:直接读磁盘文件去比 `git hash-object`,
      data/locales.json 对不上 —— **不是算法错,是磁盘上是 CRLF 而库里是 LF**,
      对照物被 autocrlf 变换污染了。改用 `git show HEAD:<file>` 的字节,当场精确命中。
      **「已知该相同」的那一端,本身也要先证明它真的相同。** */
async function gitBlobSha(content) {
  const enc = new TextEncoder();
  const body = enc.encode(content);
  const head = enc.encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(head.length + body.length);
  buf.set(head); buf.set(body, head.length);
  const d = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* 内联 content 的体积上限。**这个数不是 GitHub 的上限** —— 官方 trees 文档与 rate-limit
   文档两处都没写请求体上限,所以那个数是【未知】的。
   > **不去试探一个查不到的上限,改成待在一个可解释的保守范围里,越界自动换路。**
   ⚠️ 阈值必须按【最坏场景】定,不是按当前那次操作定:改品类名只写 23 个文件(~793KB),
      但产品保存写 33 个、其中大量是 HTML —— 实测 103 个页面裸字节 3.54MB、最坏 9.08MB,
      JSON 转义后再涨 1.06~1.19 倍。按 793KB 定阈值会在产品保存那条路上失效。 */
const INLINE_LIMIT = 5 * 1024 * 1024;

async function gh(env, path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...ghHeaders(env), ...(init.headers || {}) } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub ${init.method || "GET"} ${path} -> ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// Read a text file's current content from the branch (returns string or null if 404).
export async function readFile(env, cfg, filePath) {
  const url = `/repos/${cfg.owner}/${cfg.name}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=${cfg.branch}`;
  const res = await fetch(`${API}${url}`, { headers: ghHeaders(env) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`readFile ${filePath} -> ${res.status}`);
  const j = await res.json();
  return typeof atob === "function" ? decodeURIComponent(escape(atob(j.content.replace(/\n/g, "")))) : Buffer.from(j.content, "base64").toString("utf8");
}

// Atomically commit files on top of the branch head. Each entry is either
// {path, content} to write, or {path, delete:true} to remove the file.
export async function commitFiles(env, cfg, files, message) {
  // 1. current head + base tree
  const ref = await gh(env, `/repos/${cfg.owner}/${cfg.name}/git/ref/heads/${cfg.branch}`);
  const headSha = ref.object.sha;
  const headCommit = await gh(env, `/repos/${cfg.owner}/${cfg.name}/git/commits/${headSha}`);
  const baseTree = headCommit.tree.sha;

  /* 2. tree entries (tombstones: sha:null removes the path from the new tree)
     🔴 **这个循环里【没有】网络请求,那是它最重要的性质。**
        原来每个文件先 POST 一次 /git/blobs 拿 sha,于是子请求数 = 5 + 文件数。
        **Workers 免费版单请求子请求上限 = 50** —— 保存一个产品要写 ~33 个文件(38 次,勉强过),
        改一个品类显示名要写 ~103 个文件(108 次,**必然失败**)。
        表现是"后台保存成功但网站永远不变",而且从 2026-07-26 起就是这样,没人看得出为什么。
        Git Trees API 接受用 `content` 代替 `sha`:**blob 由服务端在建 tree 时一并创建**。
        于是子请求数变成常数 5,**与文件数无关** —— 不是"够用了",是把这个上限从结构上摘掉。
     ⚠️ `sha` 与 `content` 互斥(同时给会报错),所以删除项继续走 `sha: null`,它本来也不发请求。
     ⚠️ 编码:blob API 那边显式写着 `encoding: "utf-8"`,是因为它**还支持 base64**;
        tree API 没有这个字段,因为 `content` 只有一种可能 —— 它是 JSON 请求体里的字符串,
        而 JSON 按规范就是 UTF-8。**这条是推论,不是文档明文**,所以验收必须是
        "真提交一次含中文/西语/葡语重音的多文件 commit,再读回来逐字节比对"
        (scripts/gh-commit-e2e.mjs),不是看它没报错。
     ⚠️ 这条路径**从不写二进制**:commitFiles 的入口只接文本(原来也永远是 encoding utf-8,
        没有 base64 分支);readFile 里那个 base64 是【读】的时候解码 GitHub 的返回值,与此无关。 */
  const writes = files.filter((f) => !f.delete);
  const enc = new TextEncoder();
  const payloadBytes = writes.reduce((s, f) => s + enc.encode(f.content).length, 0);

  let tree;
  if (payloadBytes < INLINE_LIMIT) {
    tree = files.map((f) => (f.delete
      ? { path: f.path, mode: "100644", type: "blob", sha: null }
      : { path: f.path, mode: "100644", type: "blob", content: f.content }));
  } else {
    /* 退回逐文件 blob。⚠️ **分批分在 blob 这一步,tree 仍然只建一次** ——
       blob 是独立对象,分多少次 POST 都不影响原子性;而在 tree/commit 那一层分批
       就变成多个 commit,**每个断点后面都是一个已生效的分支**,
       "先造后指"挣来的原子性当场丢掉。 */
    tree = [];
    for (const f of files) {
      if (f.delete) { tree.push({ path: f.path, mode: "100644", type: "blob", sha: null }); continue; }
      const blob = await gh(env, `/repos/${cfg.owner}/${cfg.name}/git/blobs`, {
        method: "POST", body: JSON.stringify({ content: f.content, encoding: "utf-8" }) });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
  }

  // 3. tree -> commit -> move ref
  const newTree = await gh(env, `/repos/${cfg.owner}/${cfg.name}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree }),
  });
  /* 🔴 SHA 自证 —— **拦在 POST /git/commits 之前,也就是不可逆那一步之前。**
     tree 响应本来就带回每个 blob 的 SHA;本地按 UTF-8 算出期望值逐个比对,
     相等即**密码学证明字节完全一致**。零额外请求、不用 token、每次保存都自证。
     不匹配就在这里抛 —— 后面的 commit / 移 ref 全不发生,**分支一个字节不动**。
     (这个流程的原子性是"先造后指"挣来的:掉在这一步只留下无人引用的游离对象,GitHub 自行回收。)

     🔴 **验不了就不放行,这是这段代码最重要的一条。**
     GitHub 创建 tree 的响应里,嵌套路径(如 data/products/650.json)会不会以完整路径出现,
     **我没有凭据实测,所以不假设**。于是:
       · 逐个比对能找到的;任何一个不匹配 → 中止
       · **一个都没验到 → 也中止**,而不是当作通过 —— 那种情况说明自证根本没生效,
         而"没生效"和"验过了"在只看有没有抛错的眼里长得一模一样
       · 部分验到 → 同样中止,并报出没覆盖到的路径
     ⚠️ 若 admin 侧第一次跑就撞到这条,拿到的是一条**说得清的错误**(而不是静默放行,
        也不是静默写坏);那时按响应实际形状调整匹配方式即可。 */
  const byPath = new Map((newTree.tree || []).filter((t) => t.type === "blob").map((t) => [t.path, t.sha]));
  const unverifiable = [];
  let verified = 0;
  for (const f of writes) {
    const got = byPath.get(f.path);
    if (!got) { unverifiable.push(f.path); continue; }
    const expect = await gitBlobSha(f.content);
    if (got !== expect) {
      throw new Error(`SHA 自证失败,已在提交前中止:${f.path} —— GitHub ${got} ≠ 本地 ${expect}`);
    }
    verified++;
  }
  if (writes.length && verified === 0) {
    throw new Error("SHA 自证未生效,已中止:tree 响应里找不到任何一条提交路径,无法确认字节。" +
      "**验不了不等于验过了** —— 请按响应实际形状调整匹配方式后重试。");
  }
  if (unverifiable.length) {
    throw new Error(`SHA 自证覆盖不全,已中止:${unverifiable.length}/${writes.length} 条路径未出现在 tree 响应里` +
      `(如 ${unverifiable[0]})。已验 ${verified} 条且全部一致,但不完整的自证不放行。`);
  }

  const commit = await gh(env, `/repos/${cfg.owner}/${cfg.name}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
  });
  await gh(env, `/repos/${cfg.owner}/${cfg.name}/git/refs/heads/${cfg.branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return { commit: commit.sha, files: files.map((f) => f.path) };
}
