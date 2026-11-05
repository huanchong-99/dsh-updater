# dsh-updater

A plugin-update tab for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) **0.2.x**.

It scans every DSH profile's dependencies, classifies each plugin by its
install source, shows current vs latest versions, and runs updates from the
**Settings → Plugins → Updates** tab. It is fully independent: no third-party
plugin packages are imported at runtime, so it keeps working even if you
uninstall every other community plugin.

## One click for everything the Plugins page installed

DSH 0.2 ships its own **Plugins** page. It can update each plugin it
installed, but only one at a time, by opening the plugin and clicking
**Update**. The card at the top of this tab runs that same Update for all of
them in one go:

- It calls DSH's own plugin manager (`ctx.pluginManager`) in the Host
  process, so every update gets the manager's behavior: the target is checked
  against the running DSH first, the old version is removed and the new one
  installed with the same selection, the change applies live when HMR is on,
  and a version that fails to install or start is rolled back to the old one.
- Third-party registry plugins move to the version the Plugins page would
  offer: the newest that declares a bundle, accepts the running DSH, and is
  neither deprecated nor a prerelease.
- Official on-demand plugins (Codex, Claude Code, Computer Use subagents) are
  realigned to the copy that matches the running DSH after a DSH upgrade, the
  same remove-and-install the Plugins page does, plus a reinstall of the old
  copy when the new one fails.
- It covers the profile this DSH process runs, which is the only profile the
  plugin manager owns. Plugins of other profiles are still updated by this
  plugin's own executors.
- Each run is a background job. The tab shows each plugin's step (checking,
  removing, installing, reinstalling) and outcome: applied, waiting for a
  restart with the reason, rolled back, or failed. One failed plugin does not
  stop the others.

What each source gets:

| Source | Built-in Plugins page | dsh-updater |
|---|---|---|
| npm registry (`dsh plugin add foo`), running profile | one plugin at a time | all at once, through the plugin manager |
| official on-demand plugin after a DSH upgrade | one plugin at a time | all at once, through the plugin manager |
| npm registry, other profiles | no | `pnpm add foo@<version> --save-exact`, newest version the running DSH admits |
| local git clone (`link:` / `file:` / `add ./checkout`) | no | `git pull --ff-only` (optionally with autostash) + install + build |
| git-hosted (`github:` / `gitlab:` / `git+…`) | no | re-add the spec so pnpm re-resolves the ref; compares against `git ls-remote` |
| local directory without git | no | listed read-only |

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
- Updates run as background jobs, one at a time: a second run while one is
  in flight answers `409`, and closing the page does not stop a job.
- Control API behind DSH's own browser authentication (the session cookie
  minted from the `?token=` URL `dsh web` prints) and, on top of that,
  loopback only — never reachable through a reverse proxy or from a LAN/phone
  origin even when DSH serves the Web UI on a network address:
  - `GET /api/plugin-updater/status` — scan, network probes, current job
  - `POST /api/plugin-updater/run` — `{ pluginManager: true }`, `{ all: true }`,
    `{ profile, all: true }`, or `{ profile, name }`; answers `202` with the job
  - `GET /api/plugin-updater/job` — the current job only, cheap to poll
- Manual updates by default; the tab checks on open and after every run.

## Compatibility

- DSH `>=0.2.0-rc.1` (declared as `engines.dsh`; DSH checks it at install
  and boot). No upper bound on purpose: a future DSH major is not refused
  up front, so if 0.3 breaks a contract this plugin relies on, the failure
  shows up at boot rather than as a refused install. For DSH 0.1.x use
  dsh-updater 0.1.x.
- Node ≥ 24.9 is what DSH 0.2 itself requires; the plugin only needs Node 22+.
- The panel lives inside the Plugins settings section (shown as "内置插件" in
  the Chinese UI), which the default `dsh-web-app` composition always mounts.
  A custom composition without `@deepseek-ai/dsh-client-ui-settings-plugins`
  has no place for the tab.
- The one-click card needs the plugin manager, which every base-backed profile
  (`web` included) mounts. Without it the card says so and the rest of the tab
  works as before.
- Verified end to end against DSH 0.2.2-rc.1: a registry plugin and an
  outdated official plugin updated live from the tab, and a release whose
  tarball was missing was rolled back to the installed version.

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

Then restart `dsh web`, open the URL it prints, and go to **Settings →
Plugins → Updates**.

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

The host half bridges to DSH's plugin manager whenever the profile mounts one
(an optional `ctx.inject(['pluginManager', 'profileContext'])` sub-plugin),
and reads profile manifests directly from disk, resolves each
dependency with Node's own `node_modules` lookup, and runs `git` / `pnpm` /
`corepack` / `npx` commands with bounded output and a hard timeout. Registry
probes use the abbreviated packument, so a status read stays small even for
packages with hundreds of versions. The browser half registers one
`settings.plugins.tab` entry and talks only to the plugin's own
`/api/plugin-updater/*` routes. Each route first asks DSH's connection
service (`ctx.connection.requestRejection`) for the browser-session check,
then applies its own loopback fence (socket address, Host, Origin and
Fetch-Metadata checks; `X-Forwarded-For` is never trusted).

After a host-side plugin changes, restart that profile (for example `dsh web`)
for the new code to load; browser-only changes need a page refresh.

## License

MIT
