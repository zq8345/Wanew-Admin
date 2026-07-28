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
  const tree = files.map((f) => (f.delete
    ? { path: f.path, mode: "100644", type: "blob", sha: null }
    : { path: f.path, mode: "100644", type: "blob", content: f.content }));

  // 3. tree -> commit -> move ref
  const newTree = await gh(env, `/repos/${cfg.owner}/${cfg.name}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree }),
  });
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
