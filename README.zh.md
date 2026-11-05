# dsh-updater

面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) **0.2.x**
的插件更新标签页。

它扫描所有 DSH profile 的依赖，按安装来源对每个插件分类，展示当前版本与最新
版本，并在 **设置 → 内置插件 → 更新** 标签页里执行更新。它完全独立：运行时不
import 任何第三方插件包，因此即使卸载所有其他社区插件，本插件依然可用。

## 一键更新「插件」页面装的所有插件

DSH 0.2 自带 **插件** 页面，它能更新自己装的每个插件，但只能一个一个点进去按
**更新**。本标签页顶部的卡片把同样的「更新」对所有插件一次跑完：

- 直接调用 Host 进程里 DSH 自己的插件管理器（`ctx.pluginManager`），所以每次
  更新的行为都和官方完全一致：先检查与当前 DSH 的兼容性，卸载旧版本、按原来的
  启用状态装新版本，启用 HMR 时立即生效；新版本装不上或起不来时自动装回旧版本。
- 第三方 registry 插件更新到「插件」页面会提供的版本：声明了 bundle、兼容当前
  DSH、未弃用且不是预发布版的最新版本。
- 官方按需安装的插件（Codex、Claude Code、Computer Use 子代理）在 DSH 升级后
  对齐到与当前 DSH 匹配的版本，做法与「插件」页面相同（先卸再装），并且新版本
  失败时会自动装回旧版本。
- 覆盖的是当前 DSH 进程运行的 profile——插件管理器只管这一个。其他 profile 的
  插件仍由本插件自己的执行器更新。
- 每次运行是一个后台任务。标签页逐个显示进度（检查、卸载、安装、装回）和结果：
  已生效、需重启（附原因）、已回滚或失败。某个插件失败不影响其他插件继续更新。

各来源的处理方式：

| 来源 | 内置插件页面 | dsh-updater |
|---|---|---|
| npm registry（`dsh plugin add foo`），当前 profile | 一个一个更新 | 一键全部，经插件管理器执行 |
| DSH 升级后的官方按需插件 | 一个一个更新 | 一键全部，经插件管理器执行 |
| npm registry，其他 profile | 不支持 | `pnpm add foo@<version> --save-exact`，只选当前 DSH 允许的最新版本 |
| 本地 git 克隆（`link:` / `file:` / `add ./checkout`） | 不支持 | `git pull --ff-only`（可选 autostash）+ install + build |
| git 托管依赖（`github:` / `gitlab:` / `git+…`） | 不支持 | 重新 add 同一 spec 让 pnpm 重新解析 ref；用 `git ls-remote` 对比 |
| 无 git 的本地目录 | 不支持 | 只读列出 |

两者使用同一把 profile 写锁（`<profile>/package.json.lock`），不会同时在同一
个 profile 里跑 pnpm。

## 功能

- 扫描 `~/.dsh/profiles/*/package.json`（或 `$DSH_HOME`）下的所有 profile。
- 将每个依赖归类为五种来源之一：
  - `installation-owned` — DSH 自带 bundle（`dsh-base`、`dsh-web-app` 等）；
    只读，显示运行中的 DSH 版本。
  - `npm` — 从 registry 安装。最新版本从 profile 的 `.npmrc` /
    `npm_config_registry` 指定的 registry 读取（npmmirror 等镜像可用），跳过
    已弃用版本，只有当前已是预发布版时才提供预发布版本；`engines.dsh`（或
    `@deepseek-ai/dsh*` peer）不允许当前 DSH 的版本只提示、不安装——否则
    启动时会被 DSH 拒绝。
  - `git-clone` — `link:`/`file:` 安装且目录位于 git 克隆内；使用
    `git pull --ff-only` + install + build。有未提交改动时拒绝更新，除非点
    **暂存更新**。
  - `pnpm-git` — `github:`/`git+...` 形式、由 pnpm 管理的 git 依赖；通过重新
    `pnpm add` 同一 spec 更新。
  - `local-only` — 无 git 元数据的本地目录；仅手动维护。
- 同一 git 根只更新一次，多个包指向同一克隆（monorepo）时不会重复 pull。
- 更新以后台任务运行，同一时刻只有一个：进行中再次提交返回 `409`；关闭页面
  不会中断任务。
- 控制 API 先过 DSH 自己的浏览器认证（`dsh web` 打印的 `?token=` 地址换来的会话
  cookie），再叠加仅限 loopback 的限制；即使 DSH 把 Web UI 开在局域网地址或反向
  代理后面，也不会从 LAN / 手机 / 代理客户端打到：
  - `GET /api/plugin-updater/status` — 扫描、网络探测、当前任务
  - `POST /api/plugin-updater/run` — `{ pluginManager: true }`、`{ all: true }`、
    `{ profile, all: true }` 或 `{ profile, name }`；返回 `202` 和任务
  - `GET /api/plugin-updater/job` — 只返回当前任务，适合轮询
- 默认手动更新；标签页打开时与每次更新后自动检查。

## 兼容性

- DSH `>=0.2.0-rc.1`（通过 `engines.dsh` 声明，DSH 在安装和启动时校验）。
  有意不设上限：未来的 DSH 大版本不会被预先拒绝；若 0.3 改了本插件依赖的契
  约，问题会在启动时暴露，而不是表现为安装被拒。DSH 0.1.x 请使用
  dsh-updater 0.1.x。
- DSH 0.2 自身要求 Node ≥ 24.9；本插件只需要 Node 22+。
- 面板挂在设置里「内置插件」分区的标签页里，默认的 `dsh-web-app` 组合始终包含
  该分区。若自定义组合去掉了 `@deepseek-ai/dsh-client-ui-settings-plugins`，
  标签页没有挂载点。
- 一键卡片需要插件管理器，所有基于 base 的 profile（包括 `web`）都会挂载它。
  没有时卡片会提示，标签页其余功能照常。
- 已在 DSH 0.2.2-rc.1 上端到端验证：从标签页一键把一个 registry 插件和一个落后
  的官方插件热更新到新版本；对一个 tarball 缺失的版本，更新失败后自动回滚到了
  原版本。

## 安装

从仓库安装（pnpm ≥ 10 会要求你允许一次构建）：

```sh
dsh plugin --profile web add github:huanchong-99/dsh-updater
```

第一次 `add` 会因为 git 安装需要运行本包的 `prepare` 构建而失败，并打印
pnpm 的 `allowBuilds` 提示。把 pnpm 打印的键复制到 profile 的
`pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-updater: true
```

然后重新执行 `add`。如果不希望后续 push 自动进入你的机器，可以固定 commit
（`github:huanchong-99/dsh-updater#<sha>`）。

本地开发：

```sh
dsh plugin --profile web add link:$(pwd)
```

随后重启 `dsh web`，打开它打印的地址，进入 **设置 → 内置插件 → 更新**。

## 开发

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

测试不依赖网络和 DSH profile；`scripts/` 下的 git 冒烟脚本在临时仓库里验证
autostash 路径。

## 工作原理

host 半区在 profile 挂载了插件管理器时与之桥接（一个可选的
`ctx.inject(['pluginManager', 'profileContext'])` 子插件），并直接读取 profile
清单，使用 Node 自身的 `node_modules` 查找解析每个
依赖，并以有界输出和硬超时运行 `git` / `pnpm` / `corepack` / `npx` 命令。
registry 探测使用精简 packument，几百个版本的包也不会把状态读取撑大。
browser 半区注册一个 `settings.plugins.tab` 条目，只与本插件自己的
`/api/plugin-updater/*` 路由通信。每个路由先调用 DSH 连接服务的
`ctx.connection.requestRejection` 做浏览器会话认证，再做本插件自己的 loopback
防护（socket 地址、Host、Origin 与 Fetch-Metadata 检查；永不信任
`X-Forwarded-For`）。

host 侧插件更新后需要重启对应 profile（例如 `dsh web`）才会加载新代码；仅浏
览器侧的改动刷新页面即可。

## License

MIT
