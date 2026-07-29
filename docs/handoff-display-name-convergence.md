# 交接：显示名收敛（**未开工**，停在设计）

**状态**：2026-07-28 停手。**一行代码都没写，一个字节数据都没迁。**
**为什么停**：官网那两问没有答案，而"迁到哪里"没定就写迁移脚本 = 写一份大概率要重写的东西。
⚠️ **而这是一次真改数据的迁移 —— 半途停下来的数据迁移是这条链上最危险的状态。所以是"没开始"，不是"做了一半"。**

---

## 0. 🔴 下一次开工第一件事

**不是写脚本，是这三件，按顺序**：

1. **读 `origin/stage-a-catalog`**（见 §4）—— 三天前有过一次同题尝试，**别重造**。
2. **拿到官网那两问的答案**（见 §1）—— 没有答案就不要动数据。
3. **先定文件名**：`forms.json` / `categories.json` 加多语言 `name`，**还是** `catalog.json`？
   ⚠️ **现在有两种提法在并存。若不先定，会造出第三份拷贝** —— 而我们正在做的事就是消灭多份拷贝。

---

## 1. 两个未决问题（都归官网，它掌握读取侧成本，我不掌握）

### ① 读取侧：直接读品类记录，还是仍生成 `chrome.json`？

**我的倾向：直接读，不生成。** 三条理由：
- `header.*` 是**通用 UI 串袋子**（97 个顶层键，`header.*` 约 35 个，品类名只占 5 个；其余是首页/攻略/场景/垂直行业导航）。往里塞 = 污染一个不属于品类的命名空间。
- **机型显示名不在 `header.*`，在 `footer.*`**，和地址、邮箱、版权混在一起 —— 宿主更不该被生成覆盖。
- 少一层派生 = 少一个会漂的中间态。

⚠️ **代价在读取侧**（模板里 8 处硬编码 `{{t.header.xxx}}` + `_chrome.html`），**那是官网的活，它拍。**

### ② 机型的真源认哪个？

**我的倾向：B —— 品类和机型统一。** 都把多语言 `name` 放进各自记录，`locales.json model_display` 与 `chrome.footer.*` 一起降级为待删的旧拷贝。

**理由**：Joe 在后台看到的是同一个界面、同一个动作，**两条路径不该有两种真源**。

⚠️ **但事实是它们现在形状不同**，见 §2③。

---

## 2. 🔴 三件下一次一定会重新踩的

### ① key 绝不能从显示名派生 —— **一次都不能**

`chrome.json` 的键是从英文显示名 slug 出来的（`Mounts & Brackets` → `header.mounts_brackets`）。**而 `header.mounts` 已经存在**：

```
header.mounts_brackets  en=Mounts & Brackets · pt=Suportes e Fixações · es=Soportes y bases · zh=支架与固定架
header.mounts           en=Mounts            · pt=Suportes            · es=Soportes         · zh=支架
```
**两个键都是活的**（`header.mounts_brackets` 在 `_chrome.html`/`home.html`；`header.mounts` 在 `home.html`/`page-starlink-compatible-accessories.html`）。

> **Joe 刚把 `Mounts & Brackets` 改成了 `Mounts`。** 按"英文名派生键"生成，会撞进一个已存在、已被别处使用、四语值不同的键 ——
> **不是覆盖别人的翻译，就是静默绑到别人的翻译上。而英文页看着完全正常。**

⭐ 这与 2026-07-28 从产品身上拆掉的是同一个病（`form` 曾存显示名 ⇒ 改名 = 改主键）。见 [`data-format-migration.md`](contracts/data-format-migration.md)。

### ② `reason.*` 是**机器读的**，不是注释

要搬的 12 个值对象里，非语种字段共 **19 个**（`reason.es-MX` 12/12 · `reason` 7/12）。

```
scripts/catalog-dupe-check.mjs:33    if (v['reason.dupe']) { exempt.push(…); continue; }   ← 显式豁免机制
scripts/brand-residue-scan.mjs:124   if (k.startsWith('reason.')) continue;                ← 扫描器显式跳过
scripts/es-chrome-seed.migration.mjs 绿=证据原文 · 黄=「判断:」开头 · 🔴 红=「🔴 无证据:」开头，不放行
```
**`reason` 有语法 —— 前缀编码置信度。** 而 `header.cases_protection` 此刻带着一盏红灯
（`🔴 无证据: Estuche 已在规范标红…标红上线`）。

> **⇒ 迁移的验收单位 = 整个值对象逐字段相同**（含 `reason.*`，含任何我们不认识的字段），
> **不是"四个语种的字符串相同"。** 只搬四语的脚本会吃掉一盏红灯，**而且没有任何检查会红。**

⚠️ 副作用：`reason.*` 搬进新文件后，`brand-residue-scan` 那条 `startsWith('reason.')` 跳过**不会自动跟过来** → 新文件会假阳性。**改文件名的同时要改它。**

### ③ 机型的真源**已经被声明了**，只是没人读它

```
chrome.json  footer.standard_circular 的 reason.es-MX 原文：
    "fallback: 型号名(locales.json model_display 单一真源)"
实测：locales.json model_display 与 chrome.footer.* 的 en，7 个全部相同
```
> **数据自己写着 `locales.json model_display` 是单一真源，`footer.*` 是它的 fallback 拷贝，而页面读的是那份 fallback。**
> ⚠️ **7 个现在一致，不是因为有机制保证，是因为在此之前没有人成功改过机型名。**

---

## 3. ⚠️ 生产此刻的状态：**已经分叉了**

```
品类     forms.json(后台真源)   chrome.json(页面实际读的)
mounts   Mounts                 Mounts & Brackets        🔴 分叉
其余 4                                                    ✅ 同
```
**由 `29666df73`（Joe 2026-07-28 21:15 那次成功的改名）造成。**

> 🔴 **跑 rebuild 不会修好它。** 页面读的是 `chrome.json`，那份没动。
> **别在下一次开工时先去跑一遍 rebuild** —— 那会浪费一次构建，并且让人以为问题变了。

**修复发生在本收敛做完的那一刻，不在之前。**

---

## 4. 🔴 `origin/stage-a-catalog` —— 三天前的同题尝试，**先读再动**

```
a62926f3  feat(admin): catalog CRUD 编码总工 A/B/D 决定（staged 待命·不部署）
e21060b7  feat(admin): 分类增删 CRUD（catalog.json 统一真源，INERT 直到官网 render 迁移）
```

**它已经想到的**（`src/index.ts:373-409`）：
- `CATALOG_FILE = "data/catalog.json"` 作为统一真源
- **从现源合成种子**（catalog.json 不存在时）
- **INERT 语义**：`exists` = 官网已落 catalog.json → 才可保存生效；否则只做预览，**admin 不抢先写**
  ⭐ **这正是"先复制、后删除"的同一个安排** —— 可以直接复用。

🔴 **但不要 merge / rebase 它**：它比 `main` 落后约 4 天，缺掉这几天的全部东西
（`subreq.ts` / `gitsha.ts` / `preflight.mjs` / `migrate-form-to-key.mjs` / 全部 docs / vendor 的 6 次自证…）。
`git diff main..stage-a-catalog` 是 −5690 行。**它是【想法参考】，不是可续写的代码。**

---

## 5. 迁移脚本的路数（定了形状之后照抄）

范本：`scripts/migrate-form-to-key.mjs` + `scripts/freeze-form-baseline.mjs`。

```
本地 node 跑，不在 Worker 里 · 对着冻结基线 dry-run 默认
比【集合】不比【计数】 · 认不出的值中止，不猜 · 一个 commit（回滚 = 一条 git revert）
🔴 基线冻的是【现有四语译文 + 全部 reason.*】—— 逐条逐字段相同才算过
🔴 先复制、后删除：chrome.json 一个字节不动 → 官网读取侧切换 → 确认无引用 → 才删旧键
```
**已核实可放心复制的两件**：
- 那 12 个键与 `header.scene.*` 那条"跨命名空间字节相同"约束**无关**（枚举字段名 + 正对照探针，非搜短语）。
- 那 12 个值与 `chrome.json` 其它键**无重值** ⇒ 将来删旧键不会孤立掉谁在共用的值。

---

## 6. 还有一半没治：**"哪个品类出现在导航里"也是一份真源**

模板里 8 处硬编码 `{{t.header.xxx}}` 决定了导航里有哪些品类。**加一个新品类，导航不会自己长出来。**

```
改名不生效     → Joe 试了会发现
加品类不进导航 → Joe 可能【发现不了】，因为他会以为"还没构建"
```
已请官网把它算进读取侧改造。**别把它当成下一件事，它是同一件事的另一半。**
