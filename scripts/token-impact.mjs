#!/usr/bin/env node
// 品牌令牌「值」变化的可见性闸。
// ─────────────────────────────────────────────────────────────────────────
// 🔴 现有两道闸都查不到这件事：
//    vendor 守卫  查 public/w3-tokens.css 与官网**逐字节一致** —— 官网把 --w3-accent 换个颜色，它照样绿；
//    token-lint  查 admin **没有自己定义** --w3-* —— 值变了它也照样绿。
//    ⇒ 两条都绿，而 admin 的界面**沉默地跟着变**，没有任何东西在看。
//    这就是总工说的那句"闸的覆盖面 < 它给人的信心"。
//
// ⚠️ 本闸**不判断变得对不对**（那是人的事），它只保证：**值变了会红，并且当场说出谁在用。**
//    "沉默地跟着变"才是这一族的病；一个响亮的红灯 + 一张消费清单，就够把人叫去看一眼。
//
// ⚠️ 为什么在【变更未提交时】判，而不是自己存一份基线：
//    再存一份令牌值 = **第二个真源**，官网一改就要两处同步，而不同步的那天它会安静地说谎。
//    镜像本身就是基线：`git show HEAD:public/w3-tokens.css` vs 工作区 —— 零重复。
//    🔴 所以这道闸的射程是「re-vendor 那一刻」，而那正是唯一该有人看一眼的时刻。
//
//   node scripts/token-impact.mjs
import { readFileSync as _read } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 行尾归一（本仓 autocrlf=true，工作区 CRLF / 仓里 LF —— 不归一会把整份文件判成"全变了"）
const read = (f) => _read(f, "utf8").split("\r\n").join("\n");
const MIRROR = "public/w3-tokens.css";
const CONSUMERS = ["public/shell.css", "public/index.html"];

const parseTokens = (css) => {
  const out = new Map();
  // ⚠️ 先剥注释：官网那份 CSS 的注释里出现过令牌名，不剥会把注释里的当成定义。
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--w3-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
};

let bad = 0;
const fail = (msg) => { bad++; console.error(msg); };

const nowCss = read(path.join(ROOT, MIRROR));
const now = parseTokens(nowCss);
if (now.size === 0) { console.error(`🔴 ${MIRROR} 里一个 --w3-* 都没解析出来 —— 解析器坏了或文件空了，停。`); process.exit(1); }

// ── ① 孤儿消费：admin 用了镜像里没有的令牌 ────────────────────────────────
// 🔴 `var(--w3-x)` 若 x 未定义**且没写兜底**，整条声明在计算值阶段作废 —— 属性静默失效，
//    页面不报错、控制台不报错，只是那处样式没生效。**没有任何现有闸看这件事。**
//    有兜底的（`var(--x,#c92a2a)`）不算错，但也要报出来：它说明这个令牌不在契约里。
{
  const orphanHard = [], orphanSoft = [];
  for (const rel of CONSUMERS) {
    const src = read(path.join(ROOT, rel));
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/var\(\s*(--w3-[a-z0-9-]+)\s*(,)?/g)) {
        if (now.has(m[1])) continue;
        (m[2] ? orphanSoft : orphanHard).push(`${rel}:${i + 1}  ${m[1]}`);
      }
    });
  }
  if (orphanHard.length) {
    fail(`🔴 ${orphanHard.length} 处消费了镜像里没有的品牌令牌，而且**没写兜底** —— 那条声明会静默失效。`);
    orphanHard.forEach((o) => console.error(`     ${o}`));
    console.error(`   → 要么改用 --dz-*（admin 自有），要么去官网把令牌加进真源，别在这里定义。`);
  }
  console.log(`✅ 孤儿消费（无兜底）0 处${orphanSoft.length ? ` · ⚠️ ${orphanSoft.length} 处用了镜像外的令牌但写了兜底：${orphanSoft.join(" / ")}` : ""}`);
  if (orphanSoft.length) console.log(`   ⚠️ 有兜底 = 不会坏，但它不在官网契约里 —— 官网哪天真加了同名令牌，这里会被无声接管。`);
}

// ── ② 值变化的可见性 ──────────────────────────────────────────────────────
// 🔴 三态。扫描域为空时报「不适用」，不报通过 —— "没查到"和"查过没问题"必须长得不一样。
{
  let headCss = null;
  try { headCss = execFileSync("git", ["show", `HEAD:${MIRROR}`], { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).split("\r\n").join("\n"); }
  catch { headCss = null; }

  if (headCss === null) {
    console.log(`⚪ 令牌值变化：**不适用** —— 取不到 HEAD 版本的 ${MIRROR}（新文件或非 git 环境）。这不是通过。`);
  } else {
    const before = parseTokens(headCss);
    const changed = [], removed = [];
    for (const [k, v] of before) {
      if (!now.has(k)) removed.push(k);
      else if (now.get(k) !== v) changed.push([k, v, now.get(k)]);
    }
    const added = [...now.keys()].filter((k) => !before.has(k));

    if (!changed.length && !removed.length && !added.length) {
      console.log(`✅ 令牌值变化：0 处（对照 HEAD，共比了 ${before.size} 个令牌）`);
    } else {
      // 消费清单：谁在用这些变了的令牌。
      // 🔴 必须**跟一跳别名**。admin 有一层 `--dz-c-accent: var(--w3-accent)` 的别名层，
      //    直接数 `var(--w3-accent)` 只会数到**那一行**，然后报"admin 消费 1 处" ——
      //    而真实爆炸半径是所有用 `--dz-c-accent` 的地方。
      //    ⚠️ 一个把整站强调色说成"1 处"的闸，比没有闸更危险：它给的是**错误的安心**。
      const grepSites = (needle) => {
        const out = [];
        for (const rel of CONSUMERS) {
          read(path.join(ROOT, rel)).split("\n").forEach((line, i) => {
            if (new RegExp(`var\\(\\s*${needle}\\s*[,)]`).test(line)) out.push({ rel, line: i + 1, text: line });
          });
        }
        return out;
      };
      const sitesOf = (tok) => {
        const direct = grepSites(tok);
        // 别名归属必须**按令牌配对**，不能按行。
        // ⚠️ 第一版写的是"这一行上出现的所有 --dz-*"，而 shell.css:25 一行定义了三个别名 ——
        //    于是改 --w3-accent 会被算上 --dz-c-tile 和 --dz-c-ink。**多报和少报一样是错的**，
        //    而且多报更阴：噪音会被加豁免，最后整条规则等于没有。
        const aliases = new Set();
        for (const d of direct) for (const m of d.text.matchAll(new RegExp(`(--dz-[a-z0-9-]+)\\s*:\\s*var\\(\\s*${tok}\\s*[,)]`, "g"))) aliases.add(m[1]);
        const via = [...aliases].flatMap((a) => grepSites(a).map((s) => `${s.rel}:${s.line}`));
        return {
          direct: direct.map((d) => `${d.rel}:${d.line}`),
          aliases: [...aliases],
          total: new Set([...direct.map((d) => `${d.rel}:${d.line}`), ...via]).size,
        };
      };
      console.error(`\n🔴 品牌令牌的**值**变了 —— admin 的界面会跟着变，而没有任何别的闸在看这件事。`);
      for (const [k, a, b] of changed) {
        const s = sitesOf(k);
        console.error(`   ~ ${k}\n       ${a}  →  ${b}`);
        console.error(`       直接引用 ${s.direct.length} 处${s.direct.length ? "：" + s.direct.join(" · ") : "（当前没人直接用）"}`);
        if (s.aliases.length) console.error(`       ⚠️ 经别名 ${s.aliases.join(", ")} 扩散 ⇒ **实际影响 ${s.total} 处** —— 别被"直接引用 ${s.direct.length} 处"骗了`);
      }
      for (const k of removed) {
        const s = sitesOf(k);
        console.error(`   - ${k} **被官网删了**${s.total ? ` 🔴 而 admin 还有 ${s.total} 处在用（直接 ${s.direct.length}${s.aliases.length ? " + 别名 " + s.aliases.join(",") : ""}）：${s.direct.join(" · ")}` : "（admin 没用，无影响）"}`);
      }
      if (added.length) console.error(`   + 新增 ${added.length} 个：${added.join(", ")}`);
      console.error(`\n   → 这不是"别合"，是**去看一眼**：跑 npm run ui-lab，按 tools/measure.js 量，确认对比度与版式没被带偏。`);
      console.error(`   → 看过了、认可了，就把镜像和这次改动一起 commit —— 红灯会随之消失，而 diff 里留着痕。`);
      bad++;
    }
  }
}

// ── ③ 闸自检：喂一个明知有问题的样本，它必须报得出来 ──────────────────────
// 🔴 恒绿的闸和没有闸是一回事，而它看起来更让人放心。
//    一次性的"我建它时验过"证明不了它今天还活着 —— 重构、正则改动都会让它悄悄失效。
{
  const probe = parseTokens(`:root{--w3-accent:#111;--w3-bg:#222 /* --w3-fake:#333 */}`);
  const ok = probe.size === 2 && probe.get("--w3-accent") === "#111" && !probe.has("--w3-fake");
  if (!ok) { console.error(`🔴 解析器自检失败（应解析出 2 个、且不把注释里的 --w3-fake 当定义，实得 ${probe.size} 个）。闸本身坏了，不能信它的绿灯。`); process.exit(1); }
  const diffProbe = (() => {
    const a = parseTokens(":root{--w3-accent:#111;--w3-gone:#999}"), b = parseTokens(":root{--w3-accent:#222;--w3-new:#000}");
    const ch = [...a].filter(([k, v]) => b.has(k) && b.get(k) !== v).length;
    const rm = [...a.keys()].filter((k) => !b.has(k)).length;
    const ad = [...b.keys()].filter((k) => !a.has(k)).length;
    return ch === 1 && rm === 1 && ad === 1;
  })();
  if (!diffProbe) { console.error(`🔴 差分自检失败：给它 1 改 / 1 删 / 1 增的样本，它没有全部报出来。`); process.exit(1); }
  console.log(`✅ 闸自检：解析器不吃注释 ✓ · 差分能报出 改/删/增 各 1 ✓`);
}

process.exit(bad ? 1 : 0);
