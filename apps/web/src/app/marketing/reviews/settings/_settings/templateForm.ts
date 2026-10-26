/**
 * Reviews › Settings › Reply templates — the New / Edit template window's form: a name, a channel (or every channel)
 * and one text per language. Pure: the draft, what changed, Save held with the first reason that applies, and the body
 * for `POST /api/reviews/reply-templates` or `PATCH …/:id`. eBay takes replies of up to 500 characters, so an eBay
 * template's texts count against 500 (the API checks the same). Tested in templateForm.vitest.test.ts.
 */
import type { ReplyTemplateRow } from './settingsModel'

export type TemplateLocale = 'it' | 'de' | 'fr' | 'es' | 'en'
export type TemplateChannel = '' | 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY'

export const TEMPLATE_LOCALES: ReadonlyArray<{ value: TemplateLocale; label: string; short: string }> = [
  { value: 'it', label: 'Italian', short: 'IT' },
  { value: 'de', label: 'German', short: 'DE' },
  { value: 'fr', label: 'French', short: 'FR' },
  { value: 'es', label: 'Spanish', short: 'ES' },
  { value: 'en', label: 'English', short: 'EN' },
]

export const TEMPLATE_CHANNEL_OPTIONS: ReadonlyArray<{ value: TemplateChannel; label: string }> = [
  { value: '', label: 'All channels' },
  { value: 'AMAZON', label: 'Amazon' },
  { value: 'EBAY', label: 'eBay' },
  { value: 'SHOPIFY', label: 'Shopify' },
  { value: 'ETSY', label: 'Etsy' },
]

export const NAME_MAX = 80
export const BODY_MAX = 2000
export const EBAY_LIMIT = 500

export interface TemplateDraft {
  name: string
  channel: TemplateChannel
  bodies: Record<TemplateLocale, string>
}

const EMPTY_BODIES: Record<TemplateLocale, string> = { it: '', de: '', fr: '', es: '', en: '' }

export function emptyTemplateDraft(): TemplateDraft {
  return { name: '', channel: '', bodies: { ...EMPTY_BODIES } }
}

export function draftFromTemplate(t: Pick<ReplyTemplateRow, 'name' | 'channel' | 'bodies'>): TemplateDraft {
  return { name: t.name, channel: t.channel ?? '', bodies: { ...EMPTY_BODIES, ...t.bodies } }
}

/** The limit a text counts against: eBay's 500, else the template limit. */
export function templateLimit(channel: TemplateChannel): number {
  return channel === 'EBAY' ? EBAY_LIMIT : BODY_MAX
}

/** The languages the draft has a text for. */
export function draftLanguages(d: TemplateDraft): TemplateLocale[] {
  return TEMPLATE_LOCALES.map((l) => l.value).filter((l) => d.bodies[l].trim() !== '')
}

/** Why Save is held, or null. `names` are the other templates' names (a name is used once per business). */
export function templateHeldReason(d: TemplateDraft, names: readonly string[]): string | null {
  const name = d.name.trim()
  if (!name) return 'Give the template a name.'
  if (name.length > NAME_MAX) return `Keep the name to ${NAME_MAX} characters (it has ${name.length}).`
  if (names.some((n) => n.trim().toLowerCase() === name.toLowerCase())) return `A template called “${name}” already exists. Pick another name.`
  if (draftLanguages(d).length === 0) return 'Write the reply in at least one language.'
  const limit = templateLimit(d.channel)
  for (const l of TEMPLATE_LOCALES) {
    const over = d.bodies[l.value].trim().length - limit
    if (over > 0) {
      return d.channel === 'EBAY'
        ? `eBay takes replies of up to ${EBAY_LIMIT} characters: shorten the ${l.label} text by ${over}.`
        : `A reply is at most ${BODY_MAX.toLocaleString('en-US')} characters: shorten the ${l.label} text by ${over}.`
    }
  }
  return null
}

/** The body for POST (a new template) or PATCH (every part, so a cleared language goes away). */
export function templatePayload(d: TemplateDraft): { name: string; channel: string | null; bodies: Partial<Record<TemplateLocale, string>> } {
  const bodies: Partial<Record<TemplateLocale, string>> = {}
  for (const l of draftLanguages(d)) bodies[l] = d.bodies[l].trim()
  return { name: d.name.trim(), channel: d.channel || null, bodies }
}

export function templateChanged(a: TemplateDraft, b: TemplateDraft): boolean {
  return JSON.stringify(templatePayload(a)) !== JSON.stringify(templatePayload(b))
}
