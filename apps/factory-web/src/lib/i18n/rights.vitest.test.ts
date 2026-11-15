import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { LOCALES } from './locales'
import { CATALOGUE, createTranslator, flattenMessages, rightWords } from './messages'
import { headlineOf, permissionKey, rightOf, rightRef } from './rights'

/**
 * B-W2b-F51: a refusal or a held action names the missing right in words, never its permission code. A person reads
 * "Needs the right “Upload files to a record”", never `files.upload`.
 *
 *  - the guard: no value of any `messages/{it,en}/*.json` contains a permission code of the platform's catalogue
 *    (every name of FACTORY_PERMISSIONS, grains and link-session ones included; none allowed), and no message takes a
 *    `{permission}` parameter (a caller would pass a code into it): a right reaches a message as `{right}`, in words;
 *  - the one helper: `rightRef(permission)` as a parameter is said by every translator as the role screens' own words
 *    (admin.json `perm.*`), in both languages, for every permission of the catalogue.
 */

const MESSAGES = fileURLToPath(new URL('../../../messages', import.meta.url))
const NAMES = FACTORY_PERMISSIONS.all.map((definition) => definition.name)
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The longest name first, so `quality.lots.view` is found whole; a code is not part of a longer dotted word.
const CODE = new RegExp(`(?<![A-Za-z0-9_.])(?:${[...NAMES].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![A-Za-z0-9_])`, 'g')
const HAS_CODE = new RegExp(CODE.source)

function catalogueValues(): Array<{ where: string; value: string }> {
  return LOCALES.flatMap((locale) =>
    readdirSync(join(MESSAGES, locale))
      .filter((file) => file.endsWith('.json'))
      .sort()
      .flatMap((file) => Object.entries(flattenMessages(JSON.parse(readFileSync(join(MESSAGES, locale, file), 'utf8')))).map(([key, value]) => ({ where: `${locale}/${file} ${key}`, value }))),
  )
}

describe('B-W2b-F51: no message shows a permission code', () => {
  const values = catalogueValues()

  it('reads every catalogue of both languages and the whole permission catalogue', () => {
    expect(values.length).toBeGreaterThan(20000)
    expect(NAMES.length).toBeGreaterThan(500)
    expect(NAMES).toContain('payments.bank.view')
    expect(NAMES).toContain('money.price')
  })

  it('no value contains a permission code (allow none)', () => {
    const found = values.flatMap(({ where, value }) => [...value.matchAll(CODE)].map((match) => `${where}: ${match[0]}`))
    expect(found).toEqual([])
  })

  it('no message takes a {permission} parameter: a right reaches a message as {right}, in words', () => {
    expect(values.filter(({ value }) => value.includes('{permission}')).map(({ where }) => where)).toEqual([])
  })

  it('the guard catches a code, quoted or in brackets, and not a longer dotted word', () => {
    const hits = (text: string) => [...text.matchAll(CODE)].map((match) => match[0])
    expect(hits('Gli estratti conto richiedono il permesso (payments.bank.view). Chiedi a un amministratore.')).toEqual(['payments.bank.view'])
    expect(hits('Your role does not include “quality.lots.view”.')).toEqual(['quality.lots.view'])
    expect(hits('Needs money.price and files.read')).toEqual(['money.price', 'files.read'])
    expect(hits('Needs the right “See the bank statements and their lines”.')).toEqual([])
  })
})

describe('B-W2b-F51: one helper says a right in words', () => {
  it('every permission of the catalogue has words of its own in it and en (the role screens\' words)', () => {
    for (const locale of LOCALES) {
      const admin = CATALOGUE[locale].admin ?? {}
      expect(NAMES.filter((name) => !admin[permissionKey(name)]?.trim()), locale).toEqual([])
    }
  })

  it('rightWords and a rightRef parameter give the words in the page\'s language, never the code', () => {
    expect(rightWords('en', 'payments.bank.view')).toBe('See the bank statements and their lines')
    expect(rightWords('it', 'payments.bank.view')).toBe('Vedere gli estratti conto e le loro righe')
    // Said short: the role screens' sentence before its colon, without remarks in brackets.
    expect(rightWords('en', 'sales.credit.view')).toBe("See a customer's credit with a company")
    expect(rightWords('en', 'people.view')).toBe('See the employees, teams, loans to other lines and leaver steps')
    expect(rightWords('en', 'files.delete')).toBe('Delete a file')
    expect(headlineOf('Protected: see and correct the people involved; each view is recorded')).toBe('See and correct the people involved')
    const en = createTranslator('en', { held: 'Needs the right “{right}”.' })
    const it = createTranslator('it', { held: 'Serve il permesso «{right}».' })
    expect(en('held', { right: rightRef('files.upload') })).toBe('Needs the right “Upload files to a record”.')
    expect(it('held', { right: rightRef('files.upload') })).toBe('Serve il permesso «Caricare file su un record».')
    for (const locale of LOCALES) {
      const t = createTranslator(locale, { held: '{right}' })
      for (const name of NAMES) {
        const said = t('held', { right: rightRef(name) })
        expect(said, `${locale} ${name}`).not.toMatch(HAS_CODE)
        expect(said.split(/\s+/).length, `${locale} ${name}: ${said}`).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it('a right with no words says the unnamed right, never the code; an ordinary value passes as it is', () => {
    expect(rightWords('en', 'nothing.like.this')).toBe(CATALOGUE.en.admin?.['held.unnamedRight'])
    expect(rightWords('it', 'nothing.like.this')).toBe(CATALOGUE.it.admin?.['held.unnamedRight'])
    expect(rightOf(rightRef('files.read'))).toBe('files.read')
    expect(rightOf('files.read')).toBeNull()
    expect(createTranslator('en', { n: '{count} {name}' })('n', { count: 2, name: 'files.read' })).toBe('2 files.read')
  })
})
