/**
 * Reviews › Settings › Reply templates — the template window's form (Save held with the first reason, eBay's 500
 * characters, the body sent) and the Inbox reply box's Templates menu (a channel's own and every-channel templates, in
 * the review's language, else English, else the first text).
 */
import { describe, expect, it } from 'vitest'
import { replyTemplateMenu, reviewLocale, templateText } from './replyTemplates'
import type { ReplyTemplateRow } from './settingsModel'
import { draftFromTemplate, emptyTemplateDraft, templateChanged, templateHeldReason, templateLimit, templatePayload } from './templateForm'

const tpl = (id: string, channel: ReplyTemplateRow['channel'], bodies: ReplyTemplateRow['bodies']): ReplyTemplateRow =>
  ({ id, name: `Template ${id}`, channel, bodies, languages: Object.keys(bodies) as ReplyTemplateRow['languages'], usedCount: 0, updatedAt: '2026-10-26T00:00:00.000Z' })

describe('the template window', () => {
  it('Save is held with the first reason', () => {
    const d = emptyTemplateDraft()
    expect(templateHeldReason(d, [])).toBe('Give the template a name.')
    expect(templateHeldReason({ ...d, name: 'Size advice' }, ['size advice'])).toBe('A template called “Size advice” already exists. Pick another name.')
    expect(templateHeldReason({ ...d, name: 'Size advice' }, [])).toBe('Write the reply in at least one language.')
    const ebay = { ...d, name: 'A', channel: 'EBAY' as const, bodies: { ...d.bodies, de: 'x'.repeat(538) } }
    expect(templateHeldReason(ebay, [])).toBe('eBay takes replies of up to 500 characters: shorten the German text by 38.')
    expect(templateHeldReason({ ...ebay, channel: '' }, [])).toBeNull()
    expect(templateLimit('EBAY')).toBe(500)
  })

  it('sends only the languages with a text, and every channel as none', () => {
    const d = { ...emptyTemplateDraft(), name: ' Thanks ', bodies: { ...emptyTemplateDraft().bodies, en: ' Thank you! ', it: '  ' } }
    expect(templatePayload(d)).toEqual({ name: 'Thanks', channel: null, bodies: { en: 'Thank you!' } })
  })

  it('an unchanged edit is no change', () => {
    const start = draftFromTemplate(tpl('1', 'EBAY', { it: 'Grazie' }))
    expect(start.channel).toBe('EBAY')
    expect(templateChanged(start, { ...start, name: `${start.name} ` })).toBe(false)
    expect(templateChanged(start, { ...start, bodies: { ...start.bodies, de: 'Danke' } })).toBe(true)
  })
})

describe('the Inbox Templates menu', () => {
  it('the review’s language, else its market’s, else English', () => {
    expect(reviewLocale('de', 'IT')).toBe('de')
    expect(reviewLocale(null, 'FR')).toBe('fr')
    expect(reviewLocale('pt', 'NL')).toBe('en')
  })

  it('a text in the language, else English, else the first one', () => {
    expect(templateText({ bodies: { it: 'Grazie', en: 'Thanks' } }, 'it')).toEqual({ text: 'Grazie', locale: 'it' })
    expect(templateText({ bodies: { it: 'Grazie', en: 'Thanks' } }, 'de')).toEqual({ text: 'Thanks', locale: 'en' })
    expect(templateText({ bodies: { fr: 'Merci' } }, 'de')).toEqual({ text: 'Merci', locale: 'fr' })
    expect(templateText({ bodies: {} }, 'de')).toBeNull()
  })

  it('the channel’s own and the every-channel templates, with which language each text is', () => {
    const menu = replyTemplateMenu([tpl('a', 'EBAY', { de: 'Danke' }), tpl('b', null, { en: 'Thanks' }), tpl('c', 'AMAZON', { de: 'x' })], 'ebay', 'de')
    expect(menu).toEqual([
      { id: 'a', label: 'Template a', body: 'Danke', description: 'German' },
      { id: 'b', label: 'Template b', body: 'Thanks', description: 'English — no German text yet' },
    ])
  })
})
