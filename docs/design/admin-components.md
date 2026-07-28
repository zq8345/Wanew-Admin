# Admin dense 组件登记（供官网 DESIGN.md §7.4 收录）

**发起方**：wanew-admin · 仓 `zq8345/Wanew-Admin` · 路径 `docs/design/admin-components.md`
**给谁**：官网 DESIGN.md §7.4。**目标形态是 §7.4 _引用_ 本文件，不是抄一份**——两处维护必漂（同 vendor 镜像、同"宪法与实现同批改"那条）。
**现状**：A 阶段——先出这份清单交官网并入；B 阶段（引用式）随 `/products/` 迁移那批做。

> ⚠️ **B 落地必须带守卫**：官网侧要能验证"被引用的这份文件仍存在且可达"。否则我哪天改名/删了，DESIGN.md 会指向一个不存在的地方而没人知道——那正是"引用了一个结构上写不进去的路径"的镜像版。vendor 守卫已在做跨仓校验，同一套办法可用。

---

## 0. 前提：令牌不在这里定义

admin **不定义任何 `--w3-*`**（由 `scripts/token-lint.mjs` 机器强制，纳入 `npm run typecheck`）。
品牌令牌来自 `public/w3-tokens.css` —— 官网 `skin/css/w3.css` 顶层 `:root` 的**逐字节切片镜像**（vendor 守卫盯着）。
admin 自有的一律 `--dz-*` 前缀。

**admin 自有令牌（`--dz-*`，24 个）**
- 密度：`control-h 32px · row-py 8px · cell-px 10px · panel-pad 16px · gap 12px · gap-sm 8px · nav-w 184px · nav-item-py 7px · header-h 52px · radius 12px · radius-s 6px · ease`
- 语义色（官网 `:root` 里**没有**这三个，故是新增不是覆盖）：`ok · err · glass`
- W4 收编 magic 后新增：`warn · on-accent · accent-hi · accent-bg · accent-bg-soft · ok-bg · ok-line · err-bg · err-line · warn-bg · warn-line`

---

## 1. 组件族（183 个在用类 / 按族）

| 族 | 用途 | 唯一写法在 |
|---|---|---|
| **`dz-*`**（17） | 应用壳：header / side / nav-item / main / toolbar / field / btn / table / pagenav / acct / logout | `public/shell.css` |
| `card` `note` `h3sub` `hint-q` `ta-r` `tnum` `muted` | 通用原子：卡片、说明段、标题内副标签、问号提示、数字右对齐 | shell.css |
| **`cat-*`**（9） | 分类页：两卡布局 `cat-2col`、卡 `cat-block`、行内名 `cat-name`/`cat-namewrap`、产品数 `cat-cnt`、加项 `cat-add`、新行高亮 `cat-new` | index.html `<style>` |
| `c-ord` `c-act` `ord-grp` `ico` `ico-del` | 表格里的顺序/操作列与图标按钮 | index.html |
| **`fg*` / `fgrid`**（大图卡） | 首页精选产品：大图卡 + 序号徽标 `seq` + 移出 `rm` | index.html |
| **`pk-*`**（5） | 产品图片选择器：遮罩 `pk-mask`、面板 `pk`、`pk-head/body/grid/foot`、项 `pk-i`（`.added` 态） | index.html |
| **`mtile-*`**（5）· `fcard-*`（5）· `fcrumb-*`（4）· `fguide-*`（6） | 媒体库：文件瓦片、文件夹卡、面包屑、空态引导 | index.html |
| **`vp-*`**（6） | 视频选择器/弹层 | index.html |
| **`af-*`**（10） | 审计日志：条目、diff 展开、状态标 | index.html |
| **`dlg-*`**（6）· `dtl-*`（4）· `dstat` `dfeat` `ddonut-row` | 仪表盘：图例、时间线、统计卡、精选缩略 | index.html |
| `gsec` `grow` `gax` `gchip` `gtool` `gempty` | 攻略库：分组、行、轴标、筛选 chip | index.html |
| `serp` `cc` `cmpl` | SEO 编辑器：Google 结果预览、字符计数、完成度格 | index.html |
| `hero-pv` `hk-*` `tlens` | 首页 Hero：实时预览、按层级的字段样式、长短标题对照 | index.html |
| `cmw` `cmwrap` | 产品适配终端多选 chip | index.html |
| `stab` `pill` `chip` `langtab*` `buildnote` `missing-sum` | 状态 tab / 标签 / 语言 tab / 构建提示条 / 缺摘要标记 | 两处 |

---

## 2. 两条纪律（已机器化，不靠人记得）

1. **admin 不定义 `--w3-*`** → `scripts/token-lint.mjs`（定义即红；镜像缺失或为空也红——否则"页面根本没加载令牌层"会因无可抱怨而假绿）。
2. **镜像逐字节** → `scripts/vendor.mjs check`（5 个镜像，含令牌切片）。切片规则：取**花括号深度 0** 的 `:root`，**且必须恰好一个**（上游若拆成多块就红，不许静默取第一个）。

---

## 3. 一条明确的例外，别在后续清理里"顺手"收编

`.serp`（Google 结果预览）里的 `#fff / #202124 / #4d5156 / #1a0dab` **故意保持字面值**：它们模仿的是 **Google 的页面**，不是本后台主题。跟着我们的主题走就失去用途——Joe 要看的正是"在 Google 上长什么样"。已在 shell.css 注明。

---

## 4. 行内 style 的口径（与 §3 一致，但不是"零 inline"）

实测 175 处，处置：
- **32 处收成类**（重复出现的展示型）。
- **22 处 `display:none` 不收**：JS 在 16 处读写 `style.display` 做视图切换，收了就是改交互。
- **5 处不收**：写进 `w.document.write()` 的**另一个文档**，那边拿不到本站样式表，收了会**静默失效**。
- **~116 处一次性布局不收**：逐个建类会得到 116 个**只用一次**的类，同样的一次性样式多一层间接，**比 inline 更糟**。

**§3 的规则是「每类组件只有一种实现」，不是「零 inline style」。** 本清单按前者维护。
