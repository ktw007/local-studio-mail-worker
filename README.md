# Local Studio Mail Worker

部署到自己的 Cloudflare 账号的域名收件箱。Email Routing 接收邮件，Worker 解析邮件并提供管理接口，D1 保存邮箱和邮件。电脑退出后云端仍可收信。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ktw007/local-studio-mail-worker)

**部署按钮会创建 Worker 和 D1、初始化表结构。邮件域名及路由需要按下面第 3 步接入。** 不需要付费套餐、R2、信用卡或本地安装开发工具；需要自己的 Cloudflare 账号、GitHub/GitLab 授权及可接入 Email Routing 的域名。Cloudflare 的账号开通要求和额度以控制台为准。

## 1. 准备服务密钥

生成随机密钥并保存，用于自己的桌面客户端访问服务。推荐密码管理器生成 64 位随机十六进制字符串；也可在本机执行：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

这是邮箱服务的 `SERVICE_TOKEN`，不是 Cloudflare API Token。不要使用本教程中的固定字符串，不要写入仓库或 URL。知道该密钥的人可管理这个服务的全部邮箱。

## 2. 点击部署按钮

1. 点击上方 **Deploy to Cloudflare**，登录自己的 Cloudflare 并授权自己的 Git 平台账号。
2. 选择账号以及新仓库、Worker、D1 的名称。D1 应选择新建专用数据库。
3. 在配置页将 `DOMAIN` 改成自己的收信域名，例如 `mail.example.org`；不要填 `https://` 或 `@`。
4. 将第 1 步生成的密钥填入 `SERVICE_TOKEN`。它来自 `.dev.vars.example` 的 Secret 提示，不要填在公开变量里。
5. 部署命令保留 **`npm run deploy`**。它通过 `predeploy` 先执行 `wrangler d1 migrations apply DB --remote`，再发布 Worker。数据库按绑定名 `DB` 初始化，用户可以自定义数据库名称。
6. 部署完成后保存 Worker 的 `https://名称.子域.workers.dev` 地址。

Cloudflare 会将此公开模板复制到你的 Git 账号，并为你创建、绑定 D1、填入实际数据库 ID。模板中的全零 ID 是占位符，不是任何人的数据库；不要直接用未替换的配置在命令行部署。

部署后在 Worker 设置中核对：DOMAIN 为自己的域名、SERVICE_TOKEN 是 Secret、DB 为新 D1、Cron 为每天 `17 3 * * *`（UTC）。如果提示缺少表，检查部署命令是否为 `npm run deploy`。

## 3. 接入邮件路由

在 Cloudflare 目标域名中启用 **Email Routing**，按控制台要求完成 DNS 与必要的目标邮箱验证。已经有企业邮箱的域名不要直接替换 MX；优先使用专用收信域名。

首次先测试一个新地址：

1. 在桌面应用“域名邮箱 → 连接设置”填写 Worker 根地址及 SERVICE_TOKEN。
2. 创建一个新邮箱，例如 `test01`。地址必须先存在于服务数据库中，才能收信。
3. 在 Cloudflare“Email Routing → Routing rules”添加同一地址的规则，动作选择 **Send to a Worker**，目标选择刚部署的 Worker。
4. 从外部邮箱给该地址发送一封普通邮件，回到桌面刷新查看。

新地址测试通过后，可选择开启 **Catch-all → Send to a Worker**。这样以后在桌面新建邮箱无需再增加路由；Worker 只接收数据库中处于启用状态的地址。保留已有精确转发规则，它们匹配的邮件不会进入 Catch-all。想接管旧地址时必须单独修改相应精确规则。

部署按钮不会修改 DNS、已有邮件规则或启用 Catch-all。Worker/D1 部署成功也不代表真实收信已验证。

## 使用与接口

所有 HTTPS API 使用 `Authorization: Bearer <SERVICE_TOKEN>`。健康检查 `GET /v1/health` 验证数据库并返回版本和域名；未带密钥的访问返回 401，这是正常的。请使用客户端或本机请求，不要把密钥放到 URL。

| 接口 | 功能 |
| --- | --- |
| GET /v1/mailboxes | 查询邮箱，含回收站，最多 1000 个 |
| POST /v1/mailboxes | 创建邮箱：`{"local":"test01","name":"测试"}` |
| PATCH /v1/mailboxes/:id | 更新 `name`、`environment_id`、`status`（active/disabled/deleted） |
| GET /v1/mailboxes/:id/messages | 最近 100 封邮件摘要 |
| GET /v1/messages/:id | 邮件详情，纯文本正文 |
| PATCH /v1/messages/:id | 标记已读 |

停用、回收站地址拒绝新来信，可恢复。地址长期保留，邮件超过 30 天后按日清理，实际最长约 31 天。单封上限 512 KiB，正文最多保留 100,000 字符；不保存附件，不执行 HTML、不加载远程图片。只有 HTML 的新邮件会提取纯文本正文，保留可见验证码并忽略脚本、样式和隐藏内容；升级前已丢弃的 HTML 正文无法恢复，需要重新发送邮件。服务本身不会自动执行邮件中的操作。

这是单个项目的管理服务，不提供不同用户之间的访问权限隔离。数据库按 SMTP 信封收件人分箱，完全相同的原始邮件按收件箱去重。

## 免费套餐适用范围

只使用 Workers、D1、Email Routing，适合少量邮箱和轻量收信。官方当前 Workers Free 为每天 100,000 请求、每次 10 ms CPU；D1 Free 为最多 10 个数据库、单库 500 MB、账号总存储 5 GB，另有每日读写额度。账户里已有资源会占用这些额度。达到额度会影响收信和查询，不能保证任意邮件解析或任意负载都免费可用。

建议先用自己的实际邮件测试。桌面每 15 秒查询一次选中邮箱，全天约 5,760 次请求。没有启用需要付费的产品，也不自动升级套餐。

## 开发与手动部署

需要 Node.js 22.12+，建议 24 LTS。

```sh
npm ci
npm run check
npm test
npm run build
```

本地开发：复制 `.dev.vars.example` 为 `.dev.vars`，填入本地测试密钥，运行 `npm run dev`。不要提交 `.dev.vars`。

手动部署：`npx wrangler login`；`npx wrangler d1 create local-studio-mail`；将返回的数据库 ID 和自己的 DOMAIN 写入 wrangler.jsonc；执行 `npx wrangler secret put SERVICE_TOKEN` 交互填写密钥；再 `npm run deploy`，最后配置邮件路由。命令行创建资源时请确认目标账号。

## 升级、密钥轮换与备份

升级自己的模板副本时保留 DOMAIN、实际 D1 ID、服务密钥及邮箱路由。不要重新创建数据库来升级代码。通过 `wrangler secret put SERVICE_TOKEN` 或控制台更新 Secret，随后同步更新桌面端凭据；旧密钥立即失效。

使用 D1 的导出/备份功能保护数据。重新部署 Worker 不等于备份数据库。仓库未包含任何实际账号 ID、邮箱资料、邮件或密钥。

官方依据：[部署按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。

MIT License.
