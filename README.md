# dsh-updater

A standalone plugin-update panel for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

This plugin scans every DSH profile's dependencies, classifies each plugin by
its install source, shows current vs latest versions, and runs updates from
one settings panel. It is fully independent: no third-party plugin packages
are imported at runtime, so it keeps working even if you uninstall every
other community plugin.

## Features

- Scans all profiles under `~/.dsh/profiles/*/package.json`.
- Classifies every dependency into one of five sources:
  - `installation-owned` — DSH's own bundles (`dsh-base`, `dsh-web-app`...);
    read-only in the panel.
  - `npm` — installed from the npm registry; updated with
    `pnpm update --latest`.
  - `git-clone` — a local `link:`/`file:` install whose directory is inside a
    git clone; updated with `git pull --ff-only` + install + build.
  - `pnpm-git` — a `github:`/`git+...` dependency managed by pnpm; updated by
    re-adding the same spec.
  - `local-only` — a local directory without git metadata; manual only.
- One git root is updated only once even when several packages point into the
  same clone (monorepo friendly).
- Loopback-only control API:
  - `GET /api/plugin-updater/status`
  - `POST /api/plugin-updater/run`
- Manual updates by default; the panel checks on open and after every run.

## Install

From this repository:

```sh
dsh plugin --profile web add github:<owner>/dsh-updater
```

Local development:

```sh
dsh plugin --profile web add link:$(pwd)
```

Then restart `dsh web` (host half) and open Settings -> Plugin Updates.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## How it works

The host half reads profile manifests directly from disk, resolves each
dependency with Node's own `node_modules` lookup, and runs `git` /
`pnpm` / `corepack` / `npx` commands with bounded output and a hard timeout.
The browser half registers its own `settings.section` entry and talks only to
the plugin's own `/api/plugin-updater/*` routes, which are fenced to loopback
requests (Host/Origin/same-origin checks).

## License

MIT
