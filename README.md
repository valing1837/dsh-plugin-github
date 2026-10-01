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
| `github_search` | 跨库搜索：issues/PR、repositories、code |
| `github_get_checks` | 读某个 commit 的 check runs + 合并状态 |
| `github_set_status` | 发 commit status（审查门禁的原语） |
| `github_list_branches` | 列分支及各自 head commit |
| `github_compare` | 比较两个 ref：ahead/behind、commits、改动文件 |
| `github_update_pull` | 改 PR：标题/正文/base，或用 state 关开 |
| `github_update_issue` | 改 issue：标题/正文/关开/labels/assignees |
| `github_put_file` | 通过 contents API 建或改文件（无需克隆即产生 commit） |
| `github_delete_file` | 通过 contents API 删文件 |
| `github_list_releases` | 列 release |
| `github_create_release` | 发版（tag 不存在时自动创建） |
| `github_analyze_pull` | 对 PR diff 跑确定性审查规则，返回发现 + 可发布的 review body + 行内评论（只读） |

## 斜杠命令

`/github` 提供不经过模型轮次的直接查询：

```
/github status                          token 来源、apiBase、门禁状态
/github whoami                          当前账号
/github repo <owner>/<name>             仓库概要
/github pr <owner>/<name> <n>           PR 概要
/github checks <owner>/<name> <ref>     CI 状态（列出不是绿色的 run）
/github review <owner>/<name> <n>     对 PR 跑确定性审查
/github search <query>                  搜索 issue / PR
```

实现上刻意**不注入** `commands`，而是用 `ctx.get('commands')` 探测：没组合命令运行时的 profile
也应该拿到全部 28 个工具，不能因为这一个接缝就整体加载失败。

## 写操作审批门禁

`approveWrites`（默认 `true`）开启时，插件注册一个 `tools/pre-execute` waterfall 监听器，对下面
14 个会改变 GitHub 状态的工具返回：

```js
{ kind: 'ask', reason: 'github_delete_repo will change state on GitHub: owner/repo' }
```

**门禁本身不调用审批服务** —— 运行时收到 `ask` 后会自己经 `ctx.approval` 派发，只有
`allowed-once` 才继续；没有应答方时**失败关闭**（拒绝），不是放行。

被门禁拦的：`create_repo` `delete_repo` `push` `create_pull` `update_pull` `review_pull`
`merge_pull` `create_issue` `update_issue` `comment` `put_file` `delete_file` `create_release` `set_status`

**不在门禁内**的只有 `github_clone`：它只从 GitHub 读，往本地写什么由文件沙箱管辖，不是 GitHub 写操作。

嫌烦就把 `approveWrites` 设为 `false`，监听器根本不会注册。
## 确定性审查

`lib/review.js` 是个**纯函数模块**：输入 unified diff，输出发现。没有网络、没有时钟、没有随机数 ——
这是它能被测试、也能将来原样跑在 composite action 里的原因。

它**刻意不做模型调用**。每一条发现都必须仅凭 diff 就能站得住脚，因为在别人 PR 上发言不该取决于
采样模型的心情；需要判断力的部分留给调用方。

| 规则 | 严重度 | 触发条件 |
|---|---|---|
| `secret-literal` | error | 新增代码里出现形如 `apiKey = "..."` 的凭据字面量 |
| `known-token-prefix` | error | 出现 `ghp_` / `github_pat_` / `sk-` / `AKIA…` / `xox…` 等真实 token 前缀 |
| `conflict-marker` | error | 提交了解析冲突标记 `<<<<<<<` |
| `focused-test` | error | 提交了 `.only(` / `fit(` / `@pytest.mark.only`，会静默跳过其余用例 |
| `sensitive-file` | error | 改动 `.env` / `id_rsa` / `*.pem` / `credentials.*` 这类文件 |
| `debug-leftover` | warning | 留下 `console.log` / `debugger` / `binding.pry` / `fmt.Print` |
| `dangerous-eval` | warning | 新增 `eval(` / `new Function(` / `child_process` |
| `destructive-shell` | warning | 新增 `rm -rf` / `git push --force` / `git reset --hard` |
| `todo-added` | note | 新增 `TODO` / `FIXME` / `XXX` / `HACK` |
| `trailing-whitespace` | note | 新增行有行尾空白 |
| `lockfile-only` | note | 改了 lockfile，提醒确认 manifest 也改了 |
| `large-change` | note | 改动行数超过 `largeChangeLines`（默认 800） |

输出三样东西：**发现列表**、**可直接发布的 review body**（开头带稳定标记
`<!-- dsh-plugin-github:review -->`，调用方靠它在重复运行时认出自己的评论）、以及**GitHub
review 形状的行内评论**（只能锚定到具体新增行的发现才进 inline，文件级和 PR 级的另列在
`unanchoredFindings`，不会被丢掉）。

解析器的计数已与 GitHub 自己的统计**逐提交对账**（files / additions / deletions 全一致）。
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
| `approveWrites` | `true` | 是否对写操作走人工审批（`ask`，无应答方则拒绝） |
| `reviewMinSeverity` | `warning` | 成为行内评论的最低严重度：error / warning / note |
| `reviewMaxComments` | `20` | `github_analyze_pull` 产出的行内评论上限（≤50） |
| `largeChangeLines` | `800` | 改动行数超过它就把 PR 标为 large |

`sslBackend` 默认 `openssl` 是有意的：Windows 证书库在受限宿主里可能取不到，改用 OpenSSL 可绕开
（实测沙箱内 `schannel` 会报 `SEC_E_NO_CREDENTIALS`，而 OpenSSL 正常）。

## 目录结构

```
package.json        dsh.bundle.patch 指向 cordis.patch.yml
cordis.patch.yml    bundle 层：insert 一行 id=github
lib/index.js        插件本体（单文件，无用例依赖）
install.ps1         幂等安装脚本
```

## 开发与测试

```bash
npm test          # node --test test/
```

`test/harness.mjs` 用 Node 的模块钩子（`module.registerHooks`）把
`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-credentials`
三个只在 DSH 安装里存在的包替换成桩，并 mock 全局 `fetch`。所以整套测试**不碰网络、不碰 DSH
profile、不需要重启**，而且仓库里不需要提交 `node_modules`。

24 条用例覆盖：工具面完整性、每个新工具的 URL / HTTP 方法 / 请求体形状、参数校验
（非法 kind / state / event / method）、`github_delete_repo` 的 `confirm` 护栏（并断言护栏在**任何
请求之前**就生效）、GitHub 错误透传、以及 token 缺失时的报错文案。

> `node --test test/` 会让 Node 为每个测试文件 spawn 子进程。在受限沙箱里 piped stdio 会被拒
> （`EPERM: spawn`），此时直接跑 `node test/tools.test.mjs`——同进程、不 spawn，结果一样。
## 许可

MIT
