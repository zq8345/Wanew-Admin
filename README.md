# wanew-admin（产品后台，admin.wanew.com）

独立 Cloudflare Worker，与官网 Pages 站点**同仓**（运行时 regen 需要 import
`../functions/_lib/render.js` / `chrome.js` / `github.js`——单真源不复刻）。
发布产物 = 通过 GitHub API 向本仓 `main` 打**原子 commit**（= 一次 Pages 部署）。

## 部署（deploy=总工，执行窗只 commit）

```
cd admin-worker
npm run typecheck        # 闸：tsc + zero-diff 护栏（管线==产物 不变量）——先绿再发
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

- `GITHUB_TOKEN`：fine-grained PAT，Repository access 仅 `zq8345/Wanew`，Contents Read+write。
  本地开发放 `.dev.vars`（gitignored），真值存放位置见总调度记录。

## 本地开发

```
npm run dev              # wrangler dev --port 8790
```

- `.dev.vars` 需含 `DEV_BYPASS_AUTH=1`（跳过 Cf-Access 头校验）+ `GITHUB_TOKEN`。
- 任何本地验证前先证进程身份：单 PID 占 8790 + `GET /api/_whoami`（wrangler 僵尸会顶着端口装活）。

## 安全模型（M4，fail-closed）

- 边缘：Cloudflare Access 应用挂在 admin.wanew.com（未登录 302 到 tejoy.cloudflareaccess.com）。
- Worker：校验 `Cf-Access-Jwt-Assertion` 存在性头（**故意不做** Basic Auth 兜底——宁可锁死不可裸奔）。
- 静态 UI 壳走 `run_worker_first`，同样在门后。
