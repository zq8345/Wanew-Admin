#!/usr/bin/env node
// tree API 内联 `content` 的**编码实证** —— 不是推理。
//
// 背景：blob API 显式传 `encoding: "utf-8"`，tree API 内联 `content` **没有这个字段**。
// 产品数据里全是中文和 `ñ á ç ã`。若 tree API 对内联内容的解释与 blob 不同，
// 后果是**"保存成功"之后数据被静默写坏** —— 比现在这个明着失败的坏一百倍。
//
// ⭐ 关键设计：**建 tree 但不建 commit、不动 ref**。
//    tree API 会在服务端建 blob 并返回 sha —— **提交路径上的同一段编码行为**，
//    但没有任何 commit 引用它们，分支一个字节不动，游离对象由 GitHub 自行回收。
//    "验证能写"和"真的写点什么"必须分开。
//
// 用法（token 需要目标仓的 contents:write）：
//   GITHUB_TOKEN=... GITHUB_REPO=owner/name [GITHUB_BRANCH=main] node scripts/verify-tree-encoding.mjs
//
// ⚠️ 建议先在**一个私有测试仓**上跑，不必是官网仓 —— 编码行为与仓库无关。
// ⚠️ 脚本不打印 token，也不写入任何文件。

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || "main";
if (!TOKEN || !REPO) { console.error("🔴 需要环境变量 GITHUB_TOKEN 与 GITHUB_REPO（owner/name）"); process.exit(1); }
const [owner, name] = REPO.split("/");
const API = `https://api.github.com/repos/${owner}/${name}`;
const H = { Authorization: `Bearer ${TOKEN}`, "User-Agent": "wanew-admin-verify", Accept: "application/vnd.github+json" };

const gh = async (path, init) => {
  const r = await fetch(API + path, { ...(init || {}), headers: H });
  const t = await r.text();
  if (!r.ok) throw new Error(`${init?.method || "GET"} ${path} -> ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
};

// 覆盖真实数据里出现的每一类字符，外加几个专门用来抓编码问题的
const CASES = {
  "zh.json": JSON.stringify({ 标题: "斯达林克以太网转接线", 说明: "适用于机型：标准版／高性能版", 数量: 21 }, null, 2) + "\n",
  "latin.json": JSON.stringify({ es: "Adaptador de red — señal, montaje, protección", pt: "Cabo de conexão à internet, instalação não inclusa", accents: "ñ á é í ó ú ü ç ã õ â ê ô à È Ñ" }, null, 2) + "\n",
  "edge.json": JSON.stringify({ emoji: "⚡🔌📶", quote: 'he said "ok" — she said \'no\'', backslash: "a\\b\\\\c", tab_nl: "a\tb\nc", nbsp: "a b", zwsp: "a​b", cjkPunct: "「引号」、《书名》…—～" }, null, 2) + "\n",
};

const eq = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")) === 0;

(async () => {
  console.log(`仓库 ${REPO}@${BRANCH} · 只建 tree，不 commit、不动 ref\n`);

  // 1) 拿 base_tree（不改分支）
  const ref = await gh(`/git/ref/heads/${BRANCH}`);
  const headCommit = await gh(`/git/commits/${ref.object.sha}`);
  console.log(`  base_tree = ${headCommit.tree.sha.slice(0, 12)}…`);

  // 2) ⭐ 内联 content 建 tree（就是被验的那段行为）
  const tree = Object.entries(CASES).map(([p, content]) => ({ path: `.__enc_probe__/${p}`, mode: "100644", type: "blob", content }));
  const created = await gh(`/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: headCommit.tree.sha, tree }) });
  console.log(`  新 tree = ${created.sha.slice(0, 12)}…（游离，无 commit 引用）\n`);

  // 3) 把服务端存下的字节读回来，逐字节比对
  let pass = 0, fail = 0;
  for (const [file, original] of Object.entries(CASES)) {
    const node = created.tree.find((n) => n.path.endsWith(file));
    if (!node) { console.log(`  🔴 ${file}: 返回的 tree 里没有它`); fail++; continue; }
    const blob = await gh(`/git/blobs/${node.sha}`);
    // ⚠️ 用 base64 解码，不用 API 的 utf-8 便利字段 —— 要的是**字节**，不是它替我们做的解释
    const back = Buffer.from(String(blob.content).replace(/\n/g, ""), "base64").toString("utf8");
    const same = eq(original, back);
    same ? pass++ : fail++;
    console.log(`  ${same ? "✅" : "🔴"} ${file.padEnd(12)} 原 ${Buffer.byteLength(original)}B / 回 ${Buffer.byteLength(back)}B`);
    if (!same) {
      const ob = Buffer.from(original, "utf8"), bb = Buffer.from(back, "utf8");
      let i = 0; while (i < Math.min(ob.length, bb.length) && ob[i] === bb[i]) i++;
      console.log(`      首个不同字节在 #${i}：原 ${JSON.stringify(original.slice(Math.max(0, i - 12), i + 12))}`);
      console.log(`                              回 ${JSON.stringify(back.slice(Math.max(0, i - 12), i + 12))}`);
    }
  }

  console.log(`\n${fail ? "🔴" : "✅"} 逐字节比对：${pass} 通过 / ${fail} 失败`);
  console.log(`   分支未改动（没有 commit、没有 PATCH ref）—— 可用 \`git fetch && git log -1 origin/${BRANCH}\` 核实。`);
  if (fail) { console.log("   → 结论：tree API 内联 content 不能安全承载这些字符，**退回逐文件 blob**。"); process.exit(1); }
  console.log("   → 结论：内联 content 与 blob API 的 utf-8 落盘一致，可用。");
})().catch((e) => { console.error("🔴 " + e.message); process.exit(1); });
