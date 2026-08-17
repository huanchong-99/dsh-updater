# dsh-updater

面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)
的独立插件更新面板。

本插件扫描所有 DSH profile 的依赖，按安装来源对每个插件分类，展示当前版本
与最新版本，并从一个设置面板主动执行更新。它完全独立：运行时不再 import
任何第三方插件包，因此即使卸载所有其他社区插件，本插件依然可用。

## 功能

- 扫描 `~/.dsh/profiles/*/package.json` 下所有 profile 的依赖。
- 将每个依赖归类为五种来源之一：
  - `installation-owned` — DSH 自带 bundle（`dsh-base`、`dsh-web-app` 等）；
    面板只读。
  - `npm` — 从 npm registry 安装；使用 `pnpm update --latest` 更新。
  - `git-clone` — 本地 `link:`/`file:` 安装且目录位于 git 克隆内；使用
    `git pull --ff-only` + install + build 更新。
  - `pnpm-git` — `github:`/`git+...` 形式、由 pnpm 管理的 git 依赖；通过
    重新 `pnpm add` 同一 spec 更新。
  - `local-only` — 无 git 元数据的本地目录；仅手动维护。
- 同一 git 根只更新一次，多个包指向同一克隆（monorepo）时不会重复 pull。
- 仅限 loopback 的控制 API：
  - `GET /api/plugin-updater/status`
  - `POST /api/plugin-updater/run`
- 默认手动更新；面板打开时与每次更新后自动检查。

## 安装

从仓库安装：

```sh
dsh plugin --profile web add github:<owner>/dsh-updater
```

本地开发：

```sh
dsh plugin --profile web add link:$(pwd)
```

随后重启 `dsh web`（host 半区），打开 设置 -> 插件更新。

## 开发

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## 工作原理

host 半区直接读取 profile 清单，使用 Node 自身的 `node_modules` 查找解析每个
依赖，并以有界输出和硬超时运行 `git` / `pnpm` / `corepack` / `npx` 命令。
browser 半区注册自己的 `settings.section` 条目，只与本插件自己的
`/api/plugin-updater/*` 路由通信；这些路由带 loopback 请求防护
（Host/Origin/同源检查）。

## License

MIT
