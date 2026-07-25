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

  // 2. blobs (or tombstones: sha:null removes the path from the new tree)
  const tree = [];
  for (const f of files) {
    if (f.delete) {
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await gh(env, `/repos/${cfg.owner}/${cfg.name}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: f.content, encoding: "utf-8" }),
    });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
  }

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
