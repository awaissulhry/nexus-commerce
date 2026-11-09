import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { commerceImportInfo } from '@nexus/factory-domain/product/commerce-import/source'
import { ApiError } from '../../../../../lib/api/errors'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { commerceHeld, continueHeld, liveReasonKey, onlyStarted, readProblemKey } from './commerce-model'
import { COMMERCE_DEMO, designScreen } from './fixtures'
import { CommerceImportButton } from './view/CommerceImport'

/** B-W2b-209: New style › Nexus Commerce product and the styles header's Import (SCR-274). Made-up data only. */

const HERE = fileURLToPath(new URL('.', import.meta.url))

describe('who may start styles from a Commerce file', () => {
  it('holds Continue for a role that cannot start styles or import files, then while the sources are read', () => {
    expect(commerceHeld({ manage: false, imports: { run: true, apply: true } })).toBe('hold.noManage')
    expect(commerceHeld({ manage: true, imports: { run: false, apply: false } })).toBe('hold.noImport')
    expect(commerceHeld({ manage: true, imports: { run: true, apply: false } })).toBeNull()
    expect(continueHeld(COMMERCE_DEMO.source())).toBeNull()
    expect(continueHeld(COMMERCE_DEMO.source({ info: { status: 'loading' } }))).toBe('hold.reading')
    expect(continueHeld(COMMERCE_DEMO.source({ info: { status: 'error', problem: 'fault.unavailable' } }))).toBe('hold.unread')
    expect(continueHeld(COMMERCE_DEMO.source({ held: 'hold.noManage' }))).toBe('hold.noManage')
  })

  it("says why the live read is off in the server's terms", () => {
    expect(liveReasonKey(commerceImportInfo())).toBe('source.live.reason.OWNER_WORD')
  })

  it('reads a problem as our words, and opens the one style a file started', () => {
    expect(readProblemKey(new ApiError('not_found', 404, 'not_found', 'x'))).toBe('fault.not_found')
    expect(readProblemKey(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('fault.internal')
    expect(readProblemKey(new Error('x'))).toBe('fault.internal')
    expect(onlyStarted(COMMERCE_DEMO.STARTED)?.code).toBe('DEMO-TOUR')
    expect(onlyStarted(COMMERCE_DEMO.MANY)).toBeNull()
  })
})

describe('the words', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('vitest') ? [join(dir, entry.name)] : []))

  it('every key the screens name is in it and en', () => {
    const literal = new Set<string>()
    for (const file of sources(HERE)) for (const match of readFileSync(file, 'utf8').matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) literal.add(match[1]!)
    const built = [
      ...['hold.noManage', 'hold.noImport', 'hold.reading', 'hold.unread', 'source.live.reason.OWNER_WORD', 'source.live.on'],
      ...['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'internal'].map((kind) => `fault.${kind}`),
      ...['CONCEPT', 'DEVELOPMENT', 'SAMPLING', 'APPROVED', 'IN_PRODUCTION', 'PHASE_OUT', 'DISCONTINUED'].map((state) => `lifecycle.${state}`),
      'done.skus',
      'done.hidden',
      'done.onlyHidden',
    ]
    expect(literal.size).toBeGreaterThan(30)
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['products-commerce-import'] ?? {}
      const has = (key: string) => key in words || (`${key}_one` in words && `${key}_other` in words)
      expect([...literal, ...built].filter((key) => !has(key)), locale).toEqual([])
    }
  })

  it('the header button speaks both languages', () => {
    const html = (locale: (typeof LOCALES)[number]) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(CommerceImportButton, { held: null })))
    expect(html('it')).toContain('Importa')
    expect(html('en')).toContain('Import')
  })

  it('the design screen has every state and role case', () => {
    expect(designScreen.screen).toBe('SCR-274')
    expect(designScreen.cases.map((item) => item.id)).toEqual(
      expect.arrayContaining(['source', 'source-loading', 'source-error', 'source-no-manage', 'source-no-import', 'upload', 'planned', 'applied', 'done', 'done-many', 'done-none', 'done-loading', 'done-error', 'no-permission']),
    )
  })
})
