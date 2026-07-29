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
        **Workers 免费版单请求子请求上限 = 50。**
     ⚠️ 下面这组数字被订正过一次,订正的过程本身要留着:最初报的是"改品类要写 ~103 个文件",
        那个 103 是从 `108 = 5 + N` **反推**出来的,不是实测 —— 而 108 里 **80 次是读**
        (发生在 commitFiles 之外),真正写的只有 **23 个文件**。
        我拿那个反推值去建了 103 文件的 e2e、量出 10.8MB,**一个编出来的数一路当实测流下去**。
        > **权威文件里的错数字,会被下一个人当实测引用。** 所以这里只写实测过的:
        Admin 实测(本改动之后):保存产品 读22+写5=**27** ✅ · 改品类显示名 读80+写5=**85** 🔴 仍超 ·
        改品类排序 读11+写5=**16** ✅。**写入侧已经与文件数无关;仍超的那 80 次读不在这个函数里。**
        表现是"后台保存成功但网站永远不变",而且从 2026-07-26 起就是这样,没人看得出为什么。
        Git Trees API 接受用 `content` 代替 `sha`:**blob 由服务端在建 tree 时一并创建**。
        于是子请求数变成常数 6,**与文件数无关** —— 不是"够用了",是把这个上限从结构上摘掉。
     ⚠️ 是 6 不是 5:SHA 自证要多花一次 `GET /git/trees/{sha}?recursive=1` 才拿得到嵌套路径
        (POST 的响应只有顶层)。**这一行的数字随实现变,改实现就要改它** ——
        权威文件里的错数字会被下一个人当实测引用,那事在这个文件上已经发生过一次。
        ⇒ Admin 侧实测:保存产品 27→28 · 改品类排序 16→17 · 改品类显示名 17→18。
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
     四个出口,任何一个都在 POST commit 之前中止:
       · 任何一条不匹配        → 中止
       · **一条都没验到        → 也中止**(自证根本没生效,而"没生效"和"验过了"
         在只看有没有抛错的眼里长得一模一样)
       · 只验到一部分          → 中止,并报出没覆盖到的路径
       · **响应被截断(truncated) → 中止,而且措辞必须说清"这是截断,不是不匹配"** ——
         两种失败混成一句话,下一个人会去查错的方向

     ⚠️ **这段的第二个出口在生产上真触发过,而它拦对了。** 当初我写"没有凭据实测,所以不假设",
     并把"admin 第一次跑会被拦住"标成代价。2026-07-28 Joe 改品类名时它触发,分支零改动。
     **如果当初选了"匹配到才算",这次会静默放行,而 Joe 会以为保存成功。**

     🔴 原因(已实测,不是推断):`POST /git/trees` 的响应**只返回那一层的条目**。
     实测 root tree:41 条,**含斜杠的路径 0 条**;`data/products/650.json` 找不到,
     只有 `data`(type: tree)。所以嵌套路径一条都匹配不上。
     ⇒ 多花 1 次 `GET /git/trees/{sha}?recursive=1` 拿完整路径(实测 2129 条、2088 条带斜杠)。
     ⚠️ 而"tree 条目的 sha 就是 git blob SHA"这条地基也实测过,不靠理解:
        取 origin/main 上 5 个已知文件(含中文 JSON、含 NUL 的脚本、嵌套路径),
        `git rev-parse <ref>:<path>` 与 API 返回的 sha **逐条相同**。 */
  const full = await gh(env, `/repos/${cfg.owner}/${cfg.name}/git/trees/${newTree.sha}?recursive=1`);
  if (full.truncated) {
    throw new Error("SHA 自证无法进行,已中止:递归 tree 响应被截断(truncated=true),拿到的路径不完整。" +
      "**这是截断,不是不匹配** —— 字节可能完全正确,只是这次没能全部看到。别按'内容不符'去查。");
  }
  const byPath = new Map((full.tree || []).filter((t) => t.type === "blob").map((t) => [t.path, t.sha]));
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
