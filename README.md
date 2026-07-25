# wanew-admin（产品后台，admin.wanew.com）

独立 Cloudflare Worker（**独立 GitHub 仓** `zq8345/Wanew-Admin`；2026-07-24 从官网 monorepo `zq8345/Wanew` 提取，保历史）。
发布产物 = 通过 GitHub API 向**官网仓 `zq8345/Wanew` 的 `main`** 打**原子 commit**（= 触发一次 Pages 部署）。
即：本仓是后台**引擎**，写出的产品页落在**官网仓**（`GITHUB_REPO` 变量）。

## vendor/（官网共享库只读镜像 —— 勿手改）

后台运行时 regen 复用官网的渲染引擎（单真源、不复刻逻辑）。独立成仓后，这 4 个官网共享库
以**只读镜像**形式 vendor 进本仓，权威真源仍在官网仓：

| 本仓镜像 | ← 官网仓权威路径（`zq8345/Wanew:main`） | 用途 |
|---|---|---|
| `vendor/render.js` | `functions/_lib/render.js` | 产品页渲染 + 列表 regen |
| `vendor/chrome.js` | `functions/_lib/chrome.js` | 三语站壳 `makeChrome` |
| `vendor/github.js` | `functions/_lib/github.js` | GitHub API 原子提交/读文件 |
| `vendor/locale-dirs.mjs` | `scripts/locale-dirs.mjs` | locale 目录映射 |

- **初次 vendor 自** `zq8345/Wanew:main@9aa88b8b`（2026-07-24）。
- **漂移守卫**：`npm run guard:vendor` 逐字节比对镜像 vs 官网 `main` 权威版；不一致 exit 1、拉不到 exit 2（fail-closed）。
  已并入 `npm run typecheck`（发版闸）。官网 `main` 一改这些库（如 W3 合 main 动 `render.js`）→ 守卫**变红提示重新同步**。
- **重新同步**：`npm run vendor:sync`（从官网 main 重新拉，字节精确）→ 再 `npm run guard:vendor` 确认 → commit。
- ⚠️ **勿手改 `vendor/` 下任何文件**；要改去改上游官网仓，再 sync。`vendor/**` 在 `.gitattributes` 标 `-text`
  钉死字节（防 autocrlf 把 LF 转 CRLF 造假漂移）。

## 部署（deploy=总工，执行窗只 commit）

```
npm run typecheck        # 闸：tsc + vendor 漂移守卫（需联网核对官网权威库）——先绿再发
npx wrangler deploy      # 或 npm run deploy
```

- **令牌**：账号级 API 令牌即可（Workers Scripts:Edit + Workers R2:读写）。
  `account_id` 已钉死在 wrangler.jsonc —— 无 memberships 读权时 wrangler 不会再静默退出（批4 复盘）。
- **域**：`admin.wanew.com` custom domain 已由 Joe 控制台挂到 wanew.com zone（一次性）。
  后续 deploy **不再需要任何 zone 级权限**；wrangler 对已存在的同名域是幂等的。
- `workers_dev: false`：无裸 workers.dev 端点（生产实测 404 ✓）。

## 机密（wrangler secret put，printf 管道防 CRLF——10003 教训）

```
printf '%s' "$TOKEN" | npx wrangler secret put GITHUB_TOKEN
```

- `GITHUB_TOKEN`：fine-grained PAT，Repository access 仅 `zq8345/Wanew`（后台写产品页到官网仓），Contents Read+write。
  本地开发放 `.dev.vars`（gitignored），真值存放位置见总调度记录。

## 本地开发

```
npm ci                   # 首次装依赖
npm run dev              # wrangler dev --port 8790
```

- `.dev.vars` 需含 `DEV_BYPASS_AUTH=1`（跳过 Cf-Access 头校验）+ `GITHUB_TOKEN`。
- 任何本地验证前先证进程身份：单 PID 占 8790 + `GET /api/_whoami`（wrangler 僵尸会顶着端口装活）。

## 安全模型（M4，fail-closed）

- 边缘：Cloudflare Access 应用挂在 admin.wanew.com（未登录 302 到 tejoy.cloudflareaccess.com）。
- Worker：校验 `Cf-Access-Jwt-Assertion` 存在性头（**故意不做** Basic Auth 兜底——宁可锁死不可裸奔）。
- 静态 UI 壳走 `run_worker_first`，同样在门后。
