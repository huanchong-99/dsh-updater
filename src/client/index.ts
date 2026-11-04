/**
 * dsh-updater browser half. Registers one tab (`updates`) inside the Settings
 * → Plugins section, next to the built-in Installed / Discover tabs. Fully
 * standalone: only official DSH platform modules and type merges are used.
 *
 * DSH 0.2.x contract: the client root context is cordis' own `Context`
 * (the former `@deepseek-ai/dsh-client-runtime` package no longer exists),
 * the `settings.plugins.tab` list slot is declared at runtime by
 * `@deepseek-ai/dsh-client-ui-settings-plugins`, and `slots.inject` defers the
 * registration until that declaration lands, whatever the activation order.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only merges: locale Context (ctx.locale) and the settings SlotMap
// declarations (`settings.plugins.tab` lives in ui-settings' contract).
// Erased at compile time — no value import crosses a plugin boundary.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the `ctx.slots` Context merge (the slot registry is provided by
// the UI renderer plugin at runtime; `inject` waits for it).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { UpdatesTab } from './UpdatesTab.tsx'
import { en, NS, zh, type UpdaterKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    updater: UpdaterKey
  }
}

/** Cordis services required by the browser half. */
export const inject = ['slots', 'locale']

/** Tab id inside the Plugins settings section. */
export const TAB_ID = 'updates'

/**
 * Mount the plugin update panel as a tab of the Plugins settings section.
 * @param ctx - browser root context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionaries first: the register() locale seat renders through the
  // locale face, so the namespace must exist before the tab mounts.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'updater: dictionaries')
  const t = ctx.locale.bind(NS)

  // `slots.inject` waits for ui-settings-plugins to declare the tab slot. The
  // built-in tabs are Installed (order 10) and Discover; this one follows them.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: TAB_ID,
    order: 30,
    label: () => t('tab'),
    locale: NS,
  }, UpdatesTab))
}
