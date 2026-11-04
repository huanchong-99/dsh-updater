/**
 * Standalone tsdown build for the dsh-updater plugin.
 *
 * Emits two artifacts into `lib/`:
 *  1. `lib/index.js` — the Node (host) half. The dsh Loader imports the
 *     package `main`; this half owns the profile scan, classification,
 *     update executors, and the /api/plugin-updater route family.
 *  2. `lib/client.js` — the browser half, shaped like the harness's own
 *     client bundle: a closure-factory artifact that calls
 *     `window.__ModuleLoader__.load({ id, factory })`, resolves platform
 *     modules through the loader's frozen module table, and inlines CSS
 *     Modules (compiled by lightningcss, injected as a `<style data-plugin>`).
 *
 * The externals list mirrors the DSH 0.2.x client platform module table
 * (`@deepseek-ai/dsh-client-web/src/platform.ts`). Every other
 * `@deepseek-ai/*` value import is a build error (purity gate): the module
 * table answers only these words, so anything else would be a runtime
 * `require` miss inside the browser.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Stable plugin id: must equal the package name. */
const PACKAGE_ID = 'dsh-updater'

/**
 * Platform modules the shell shares into the frozen module table (DSH 0.2.x).
 * Keep in sync with `@deepseek-ai/dsh-client-web/src/platform.ts`.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/**
 * Specifiers resolved from the loader module table at bundle load time. The
 * plugin declares no `dsh.client.external` requests, so the baseline is the
 * whole list; the only value imports this bundle actually makes are `react`
 * and `react/jsx-runtime`.
 */
const CLIENT_EXTERNALS: string[] = [...PLATFORM_MODULES]

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Virtual-id wrapper keeping module CSS away from tsdown's own CSS pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

/** Rebase a physical lib-relative source onto a browser URL mirroring the package directories. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repoPath = physicalSource.startsWith(REPOSITORY_ROOT)
    ? physicalSource.slice(REPOSITORY_ROOT.length).replaceAll(sep, '/')
    : source
  return repoPath.startsWith('src/') ? repoPath : source
}

export default defineConfig(() => [
  {
    // Node (host) half: the package `main`.
    name: PACKAGE_ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    deps: {
      // The host half keeps zero runtime dependencies: the only third-party
      // library it uses (semver, for DSH's engines/peer admission rule) is
      // inlined, so a git / tarball install needs nothing beyond the build.
      alwaysBundle: ['semver'],
    },
  },
  {
    // Browser half: served at /plugins/<PACKAGE_ID>/client.js.
    name: `${PACKAGE_ID}/client`,
    entry: ['src/client/index.ts'],
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      // Resolved from the loader module table at bundle load time.
      neverBundle: CLIENT_EXTERNALS,
      // tsdown auto-externalizes package dependencies; the module table only
      // answers the explicit externals above, so everything else must inline.
      alwaysBundle: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    },
    plugins: [
      {
        // Bundle purity gate: a @deepseek-ai value import that is neither a
        // platform module nor inlined is a guaranteed runtime require miss.
        name: `${PACKAGE_ID}-client-purity`,
        resolveId(source: string) {
          if (!source.startsWith('@deepseek-ai/')) return null
          if (CLIENT_EXTERNALS.includes(source)) return null
          throw new Error(
            `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS). `
            + 'Cross-plugin value imports are forbidden; use type-only imports or cordis services.',
          )
        },
      },
      {
        // Inline *.module.css: compile to a hashed class map + a <style> tag
        // injected at factory execution (same contract as the harness build).
        name: `${PACKAGE_ID}-css-modules-inline`,
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.module.css')) return null
          const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
          return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
          const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
          this.addWatchFile(fileId)
          const source = await readFile(fileId)
          const { code, exports: cssExports } = transform({
            filename: fileId,
            code: source,
            cssModules: { pattern: '[hash]_[local]' },
            minify: true,
          })
          const classMap: Record<string, string> = {}
          for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
          const tagId = `${PACKAGE_ID}/${basename(fileId)}`
          return [
            `const css = ${JSON.stringify(code.toString())};`,
            `const tagId = ${JSON.stringify(tagId)};`,
            'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
            '  const tag = document.createElement(\'style\');',
            `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
            '  tag.dataset.pluginCss = tagId;',
            '  tag.textContent = css;',
            '  document.head.appendChild(tag);',
            '}',
            `export default ${JSON.stringify(classMap)};`,
          ].join('\n')
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
