# dsh-updater

面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) **0.2.x**
的插件更新标签页。

它扫描所有 DSH profile 的依赖，按安装来源对每个插件分类，展示当前版本与最新
版本，并在 **设置 → 插件 → 更新** 标签页里执行更新。它完全独立：运行时不
import 任何第三方插件包，因此即使卸载所有其他社区插件，本插件依然可用。

## DSH 已经有「插件」页面了，为什么还需要它

DSH 0.2 自带的 **插件** 页面可以安装、卸载和更新 bundle，但它的更新只覆盖
**以包名从 npm registry 安装** 的包。本标签页补上它不做的部分：

| 来源 | 内置插件页面 | dsh-updater |
|---|---|---|
| npm registry（`dsh plugin add foo`） | 可更新 | 可更新（同样写成 `pnpm add foo@<version> --save-exact` 的精确锁定，且只选运行中 DSH 允许的最新版本） |
| 本地 git 克隆（`link:` / `file:` / `add ./checkout`） | 不支持 | `git pull --ff-only`（可选 autostash）+ install + build |
| git 托管依赖（`github:` / `gitlab:` / `git+…`） | 不支持 | 重新 add 同一 spec 让 pnpm 重新解析 ref；用 `git ls-remote` 对比 |
| 无 git 的本地目录 | 不支持 | 只读列出 |
| 一次看所有 profile | 不支持（只看当前 profile） | 支持 |

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
- 同一时刻只跑一个更新；更新进行中再次提交会返回 `409`。
- 仅限 loopback 的控制 API，即使 DSH 把 Web UI 开在局域网地址或反向代理后面，
  也不会从 LAN / 手机 / 代理客户端打到：
  - `GET /api/plugin-updater/status`
  - `POST /api/plugin-updater/run`
- 默认手动更新；标签页打开时与每次更新后自动检查。

## 兼容性

- DSH `>=0.2.0-rc.1`（通过 `engines.dsh` 声明，DSH 在安装和启动时校验）。
  有意不设上限：未来的 DSH 大版本不会被预先拒绝；若 0.3 改了本插件依赖的契
  约，问题会在启动时暴露，而不是表现为安装被拒。DSH 0.1.x 请使用
  dsh-updater 0.1.x。
- DSH 0.2 自身要求 Node ≥ 24.9；本插件只需要 Node 22+。
- 面板挂在「插件」设置分区的标签页里，默认的 `dsh-web-app` 组合始终包含该分
  区。若自定义组合去掉了 `@deepseek-ai/dsh-client-ui-settings-plugins`，标签
  页没有挂载点。

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

随后重启 `dsh web`，打开 **设置 → 插件 → 更新**。

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

host 半区直接读取 profile 清单，使用 Node 自身的 `node_modules` 查找解析每个
依赖，并以有界输出和硬超时运行 `git` / `pnpm` / `corepack` / `npx` 命令。
registry 探测使用精简 packument，几百个版本的包也不会把状态读取撑大。
browser 半区注册一个 `settings.plugins.tab` 条目，只与本插件自己的
`/api/plugin-updater/*` 路由通信；这些路由带 loopback 请求防护（socket 地址、
Host、Origin 与 Fetch-Metadata 检查；永不信任 `X-Forwarded-For`）。

host 侧插件更新后需要重启对应 profile（例如 `dsh web`）才会加载新代码；仅浏
览器侧的改动刷新页面即可。

## License

MIT
