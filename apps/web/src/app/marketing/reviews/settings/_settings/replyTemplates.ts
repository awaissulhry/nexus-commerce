/**
 * Reviews — the saved replies a person picks in the Inbox reply box ("Templates" menu of the DS ReplyComposer), from
 * Reviews › Settings › Reply templates. Pure: a channel's own templates and the every-channel ones, most used first,
 * each in the review's language (else English, else the first text it has). Tested in templateForm.vitest.test.ts.
 */
import type { ReplyTemplate } from '@/design-system/patterns'
import type { ReplyTemplateRow } from './settingsModel'

type Locale = 'it' | 'de' | 'fr' | 'es' | 'en'
const LOCALES: Locale[] = ['it', 'de', 'fr', 'es', 'en']
const NAME: Record<Locale, string> = { it: 'Italian', de: 'German', fr: 'French', es: 'Spanish', en: 'English' }

const MARKET_LOCALE: Record<string, Locale> = { IT: 'it', DE: 'de', AT: 'de', FR: 'fr', BE: 'fr', ES: 'es', UK: 'en', GB: 'en', IE: 'en', US: 'en' }

/** The language a reply to this review is written in: the review's own, else its market's, else English. */
export function reviewLocale(language: string | null | undefined, market: string | null | undefined): Locale {
  const own = (language ?? '').toLowerCase().slice(0, 2)
  if (LOCALES.includes(own as Locale)) return own as Locale
  return MARKET_LOCALE[(market ?? '').toUpperCase()] ?? 'en'
}

/** A template's text in a language, and which language that is. */
export function templateText(t: Pick<ReplyTemplateRow, 'bodies'>, locale: Locale): { text: string; locale: Locale } | null {
  for (const l of [locale, 'en' as Locale, ...LOCALES]) {
    const text = t.bodies[l]?.trim()
    if (text) return { text, locale: l }
  }
  return null
}

/** The Templates menu for a review on `channel` in `locale`. */
export function replyTemplateMenu(templates: readonly ReplyTemplateRow[], channel: string, locale: Locale): ReplyTemplate[] {
  const ch = channel.toUpperCase()
  return templates
    .filter((t) => t.channel == null || t.channel === ch)
    .flatMap((t) => {
      const found = templateText(t, locale)
      if (!found) return []
      const note = found.locale === locale ? NAME[found.locale] : `${NAME[found.locale]} — no ${NAME[locale]} text yet`
      return [{ id: t.id, label: t.name, body: found.text, description: note }]
    })
}
