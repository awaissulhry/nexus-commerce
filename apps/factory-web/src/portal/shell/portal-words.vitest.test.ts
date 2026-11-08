import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { CAPABILITIES } from '@nexus/factory-domain/auth/partners/kinds'
import { PARTNER_ROLE_TEMPLATES } from '@nexus/factory-domain/auth/roles/templates'
import { PARTNER_TASK_KINDS } from '@nexus/factory-domain/portal/tasks/kinds'
import { PARTNER_SEARCH_GROUPS } from '@nexus/factory-domain/search/partner/contracts'
import { COMPOSER_REASONS } from '@nexus/factory-domain/threads/partner/rules'
import { CATALOGUE, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { designScreen } from './fixtures'
import { RECORD_TYPE_WORDS } from './thread-model'

/**
 * The portal frame's words (B-W2b-173): every partner permission, role, task kind, search group and composer reason the API
 * can name has its words in Italian and English — a new one on the API fails here, not as a key on a partner's screen — and
 * every design case of SCR-027 draws in both languages with no raw key.
 */

const LOCALES = ['it', 'en'] as const
const has = (locale: 'it' | 'en', key: string) => key in (CATALOGUE[locale].portal ?? {})

describe('the portal’s words', () => {
  it('says what every partner permission (and the files and threads a portal reads) allows', () => {
    const names = [...FACTORY_PERMISSIONS.partnerAssignable.map((definition) => definition.name), 'files.read', 'threads.read']
    for (const locale of LOCALES) expect(names.filter((name) => !has(locale, `access.permission.${name.replace(/\./g, '_')}`)), locale).toEqual([])
  })

  it('names every partner role and capability, every task kind, search group and composer reason, every record type', () => {
    for (const locale of LOCALES) {
      expect(PARTNER_ROLE_TEMPLATES.map((template) => `role.${template.key}`).filter((key) => !has(locale, key)), locale).toEqual([])
      expect(CAPABILITIES.map((capability) => `access.capability.${capability}`).filter((key) => !has(locale, key)), locale).toEqual([])
      expect(PARTNER_TASK_KINDS.map((kind) => `tasks.kind.${kind}`).filter((key) => !has(locale, key)), locale).toEqual([])
      expect(PARTNER_SEARCH_GROUPS.map((group) => `search.group.${group}`).filter((key) => !has(locale, key)), locale).toEqual([])
      expect([...COMPOSER_REASONS, 'other'].map((reason) => `thread.held.${reason}`).filter((key) => !has(locale, key)), locale).toEqual([])
      expect([...RECORD_TYPE_WORDS, 'other'].map((type) => `record.type.${type}`).filter((key) => !has(locale, key)), locale).toEqual([])
    }
  })
})

const KEY = /\b(nav|rail|top|search|bell|menu|band|live|notice|foot|bottomBar|state|preview|tasks|thread|record|terms|email|still|keys|unsaved|access|display|gate|role)\.[a-zA-Z_-]+/

describe('SCR-027 design cases', () => {
  it('every case draws in Italian and English with no raw key and made-up data only', () => {
    expect(designScreen.cases.length).toBeGreaterThanOrEqual(20)
    for (const locale of LOCALES) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
        expect(html, `${entry.id} (${locale})`).toContain('main-content')
        expect(html).not.toMatch(/@(?!example\b)[a-z0-9-]+\.(com|it|eu)\b/)
      }
    }
  })

  it('the Italian frame speaks Italian (no English of the frame on an Italian page)', () => {
    const entry = designScreen.cases.find((item) => item.id === 'customer')!
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell', 'portal']) }, createElement(designScreen.view, { model: entry.model })))
    expect(html).toContain('Cosa ti aspetta')
    expect(html).toContain('Ordini, 2 da confermare')
    expect(html).not.toContain('What waits for you')
    expect(html).not.toContain('Ask a question')
  })
})
