# dsh-updater

A plugin-update tab for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) **0.2.x**.

It scans every DSH profile's dependencies, classifies each plugin by its
install source, shows current vs latest versions, and runs updates from the
**Settings → Plugins → Updates** tab. It is fully independent: no third-party
plugin packages are imported at runtime, so it keeps working even if you
uninstall every other community plugin.

## Why, when DSH has a Plugins page

DSH 0.2 ships its own **Plugins** page, which installs, removes, and updates
bundles — but its update path only covers packages that were installed from an
**npm registry** under their own name. This tab adds what that page does not do:

| Source | Built-in Plugins page | dsh-updater |
|---|---|---|
| npm registry (`dsh plugin add foo`) | update | update (same `pnpm add foo@<version> --save-exact` shape, pinned to the newest version your running DSH admits) |
| local git clone (`link:` / `file:` / `add ./checkout`) | no | `git pull --ff-only` (optionally with autostash) + install + build |
| git-hosted (`github:` / `gitlab:` / `git+…`) | no | re-add the spec so pnpm re-resolves the ref; compares against `git ls-remote` |
| local directory without git | no | listed read-only |
| every profile at once | no (current profile only) | yes |

Both tools take the same profile write lock (`<profile>/package.json.lock`), so
they never run pnpm in one profile at the same time.

## Features

- Scans all profiles under `~/.dsh/profiles/*/package.json` (or `$DSH_HOME`).
- Classifies every dependency into one of five sources:
  - `installation-owned` — DSH's own bundles (`dsh-base`, `dsh-web-app`...);
    read-only, shown with the running DSH version.
  - `npm` — installed from a registry. The newest version is read from the
    registry the profile's `.npmrc` / `npm_config_registry` names (mirrors such
    as npmmirror work), deprecated versions are skipped, prereleases are
    offered only when the installed version is a prerelease, and versions whose
    `engines.dsh` (or `@deepseek-ai/dsh*` peers) reject the running DSH are
    reported but never installed — the launcher would refuse them at boot.
  - `git-clone` — a `link:`/`file:` install inside a git clone; updated with
    `git pull --ff-only` + install + build. Dirty trees are refused unless you
    choose **Update with stash**.
  - `pnpm-git` — a `github:`/`git+...` dependency managed by pnpm; updated by
    re-adding the same spec.
  - `local-only` — a local directory without git metadata; manual only.
- One git root is updated only once even when several packages point into the
  same clone (monorepo friendly).
- One update at a time: a second run while one is in flight answers `409`.
- Loopback-only control API, never reachable through a reverse proxy or from
  a LAN/phone origin even when DSH serves the Web UI on a network address:
  - `GET /api/plugin-updater/status`
  - `POST /api/plugin-updater/run`
- Manual updates by default; the tab checks on open and after every run.

## Compatibility

- DSH `>=0.2.0-rc.1 <0.3.0` (declared as `engines.dsh`; DSH checks it at
  install and boot). For DSH 0.1.x use dsh-updater 0.1.x.
- Node ≥ 24.9 is what DSH 0.2 itself requires; the plugin only needs Node 22+.
- The panel lives inside the Plugins settings section, which the default
  `dsh-web-app` composition always mounts. A custom composition without
  `@deepseek-ai/dsh-client-ui-settings-plugins` has no place for the tab.

## Install

From this repository (pnpm ≥ 10 asks you to allow the build once):

```sh
dsh plugin --profile web add github:huanchong-99/dsh-updater
```

The first `add` fails with pnpm's `allowBuilds` hint because a git install
runs this package's `prepare` build. Copy the key pnpm printed into the
profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-updater: true
```

and run the `add` again. Pin a commit (`github:huanchong-99/dsh-updater#<sha>`)
if you want later pushes to stay out of your machine until you choose them.

Local development:

```sh
dsh plugin --profile web add link:$(pwd)
```

Then restart `dsh web` and open **Settings → Plugins → Updates**.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

The test suite needs no network and no DSH profiles; the git smoke scripts
under `scripts/` exercise the autostash paths against throwaway repositories.

## How it works

The host half reads profile manifests directly from disk, resolves each
dependency with Node's own `node_modules` lookup, and runs `git` / `pnpm` /
`corepack` / `npx` commands with bounded output and a hard timeout. Registry
probes use the abbreviated packument, so a status read stays small even for
packages with hundreds of versions. The browser half registers one
`settings.plugins.tab` entry and talks only to the plugin's own
`/api/plugin-updater/*` routes, which are fenced to loopback requests
(socket address, Host, Origin and Fetch-Metadata checks; `X-Forwarded-For` is
never trusted).

After a host-side plugin changes, restart that profile (for example `dsh web`)
for the new code to load; browser-only changes need a page refresh.

## License

MIT
