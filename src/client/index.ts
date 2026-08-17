/**
 * dsh-updater browser half. Registers one first-level settings section
 * (`plugin-updater`) that renders the update panel. Fully standalone: only
 * official DSH platform modules and type merges are used.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only merges: locale Context (ctx.locale) and the `settings.section`
// SlotMap declaration (ui-settings). Erased at compile time.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { UpdaterSection } from './UpdaterSection.tsx'
import { en, NS, zh, type UpdaterKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    updater: UpdaterKey
  }
}

/** Cordis services required by the browser half. */
export const inject = ['slots', 'locale']

/**
 * Mount the plugin update panel as its own settings section.
 * @param ctx - browser root context.
 */
export function apply(ctx: ClientContext): void {
  // Dictionaries first: the register() locale seat renders through the
  // locale face, so the namespace must exist before the section mounts.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'updater: dictionaries')

  // `slots.inject` defers the registration until ui-settings declares
  // `settings.section` (handles boot-order regardless of the graph edge).
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'plugin-updater',
    order: 130,
    label: () => ctx.locale.bind(NS)('title'),
    locale: NS,
  }, UpdaterSection))
}
