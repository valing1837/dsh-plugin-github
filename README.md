# dsh-plugin-github

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的 **host-only** GitHub 集成插件：
建仓库、推代码、读 diff、提审查、合并 PR —— 全部作为 DSH 的 agent 工具暴露。

针对 **DSH 0.2.0-rc.2** 编写并实测。

## 为什么是 host-only

插件**没有客户端部分**：没有 `dsh.client` 字段，没有 `lib/client.js`。

DSH 0.2.x 的浏览器端要求客户端 bundle 以 `window.__ModuleLoader__.load({...})` 自注册、且不含顶层
`import`。把普通 ESM 产物放到那里是**硬启动失败**（实测：`Cannot use import statement outside a
module` → web boot 崩溃）。本插件只注册主机侧工具，从结构上就不可能触发那类故障。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本做两件事（幂等，且改 `package.json` 前会先备份）：

1. 把包复制到 `<profile>\node_modules\dsh-plugin-github`
2. 把 `dsh-plugin-github` 加进 `<profile>\package.json` 的 `dsh.profile.bundles`

默认 profile 是 `%USERPROFILE%\.dsh\profiles\desktop`，可用 `-ProfileDir` 覆盖。

> 为什么不用 `dsh plugin add`：桌面版 profile 被 Electron 独占，CLI 会直接拒绝
> （`error: profile "desktop" is managed exclusively by the Electron application`）。

装完**重启 DSH**。宿主侧源码改动不会被 HMR 重载，新增插件才会。

## Token

Token 不写在插件里，按以下顺序解析：

1. 配置项 `token`（字面值）
2. **DSH 凭证域** `credentialRef(tokenRef)`，默认引用名 `GITHUB_TOKEN`
3. 进程环境变量 `GITHUB_TOKEN`

推荐第 2 种 —— 在 `%USERPROFILE%\.dsh\.credentials.yaml` 的 `refs:` 下加一行：

```yaml
refs:
  GITHUB_TOKEN: ghp_xxxxxxxx
```

### 权限

| 方式 | 需要什么 |
|---|---|
| 经典 token | `repo` 一个 scope 就够建仓库、推送、PR/issue、**删除仓库** |
| 细粒度 token | Contents `RW`、Pull requests `RW`、Issues `RW`、Metadata `R`；建仓库再加 Account → Administration `RW` |

用 `github_status` 可以随时确认 token 有没有解析到、从哪来的；`github_whoami` 验证有效性。

## 工具

| 工具 | 说明 |
|---|---|
| `github_status` | 报配置和 token 来源，不发网络请求、不打印密钥 |
| `github_whoami` | 验证 token，返回账号 |
| `github_create_repo` | 建仓库（个人或组织，默认私有） |
| `github_list_repos` | 列出仓库 |
| `github_delete_repo` | 删除仓库（不可逆，需 `confirm` 精确等于 `owner/repo`） |
| `github_clone` | 克隆到本地；已存在的克隆改为 fetch + checkout |
| `github_push` | init → add → commit → 推送分支 |
| `github_get_file` | 读文件（自动 base64 解码）或列目录 |
| `github_list_pulls` | 列 PR |
| `github_get_pull` | 读单个 PR：元数据 + 逐文件 patch + 全量 unified diff |
| `github_create_pull` | 开 PR（`base` 省略时自动查默认分支） |
| `github_review_pull` | 提审查：COMMENT / APPROVE / REQUEST_CHANGES，支持逐行内联评论 |
| `github_merge_pull` | 合并（merge / squash / rebase），可传 `sha` 做乐观锁 |
| `github_list_issues` | 列 issue（默认过滤掉 PR） |
| `github_get_issue` | 读 issue + 评论线程 |
| `github_create_issue` | 开 issue |
| `github_comment` | 在 issue / PR 上留普通评论 |

## 安全设计

**Token 不落盘到仓库。** `github_push` 用一次性带 token 的推送 URL，本地留下的 `origin` 是无凭证的
`https://github.com/owner/repo.git`。`github_clone` 同样在克隆完成后立刻
`git remote set-url origin <无凭证 URL>`，这一步失败会直接报错而不是留下带凭证的 `.git/config`。

**输出脱敏。** git 的报错会把带 token 的 URL 整条打出来，所以所有 stdout/stderr 都过一遍 `redact()`
（含 URL 编码形式）才返回。

**身份只在仓库没有时才兜底。** 先探 `git config user.email`，为空才注入提交身份 —— 用户自己配的永远优先。

**破坏性操作用重复全名当护栏。** `github_delete_repo` 要求 `confirm` 精确等于 `owner/repo`，
不匹配就在发请求前抛错。

## 配置项

全部有默认值，可在 profile 的 patch 里按行覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `tokenRef` | `GITHUB_TOKEN` | 凭证域引用名 |
| `token` | — | 字面 token（不推荐） |
| `apiBase` | `https://api.github.com` | REST API 基址 |
| `gitHost` | `github.com` | 构建 clone/push URL 用，GitHub Enterprise 改这里 |
| `gitPath` | `git` | git 可执行文件 |
| `sslBackend` | `openssl` | 强制 git 的 `http.sslBackend`；置空则用 git 自己的默认 |
| `authorName` / `authorEmail` | `DeepSeek Harness` / `dsh@localhost` | 仅在仓库无身份时使用 |
| `defaultOwner` | — | 省略 `owner` 时假定的用户/组织 |
| `userAgent` | `dsh-plugin-github` | 请求头 |

`sslBackend` 默认 `openssl` 是有意的：Windows 证书库在受限宿主里可能取不到，改用 OpenSSL 可绕开
（实测沙箱内 `schannel` 会报 `SEC_E_NO_CREDENTIALS`，而 OpenSSL 正常）。

## 目录结构

```
package.json        dsh.bundle.patch 指向 cordis.patch.yml
cordis.patch.yml    bundle 层：insert 一行 id=github
lib/index.js        插件本体（单文件，无用例依赖）
install.ps1         幂等安装脚本
```

## 许可

MIT
