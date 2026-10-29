import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '@nexus/factory-domain/auth/permissions/catalogue'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, placeholdersOf } from '../../../lib/i18n/messages'
import { ADMIN_PAGE_NAMESPACES } from './messages'

/**
 * The B-W0-28 Admin pages' words (PLAN §4.6, PLT-127): each page's catalogue (`admin-<page>.json`) has the same keys and
 * placeholders in it and en, no empty text, its keys under the page's own prefixes only, and every key the page's code
 * names literally exists there. (Part 1's admin-screens test checks the shared `admin` keys over the same folders.)
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PAGES: ReadonlyArray<{ namespace: (typeof ADMIN_PAGE_NAMESPACES)[number]; folder: string; prefixes: readonly string[] }> = [
  { namespace: 'admin-documents', folder: 'documents', prefixes: ['docs'] },
  { namespace: 'admin-languages', folder: 'languages', prefixes: ['langs'] },
  { namespace: 'admin-connections', folder: 'connections', prefixes: ['conn', 'mail'] },
  { namespace: 'admin-import', folder: 'import', prefixes: ['imp'] },
  { namespace: 'admin-audit', folder: 'audit', prefixes: ['audit'] },
]
/** Strings shaped like keys that are not: the permissions the code names (and example.com domains, filtered below). */
const NOT_KEYS: ReadonlySet<string> = new Set(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name))

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') && entry.name !== 'fixtures.ts' ? [path] : []
  })

describe('the B-W0-28 pages\' catalogues', () => {
  it('cover the five pages', () => {
    expect(PAGES.map((page) => page.namespace).sort()).toEqual([...ADMIN_PAGE_NAMESPACES].sort())
  })

  for (const page of PAGES) {
    it(`${page.namespace}: the same keys and placeholders in it and en, under its own prefixes`, () => {
      const en = CATALOGUE.en[page.namespace] ?? {}
      const itc = CATALOGUE.it[page.namespace] ?? {}
      expect(Object.keys(en).length, page.namespace).toBeGreaterThan(40)
      expect(Object.keys(itc).sort()).toEqual(Object.keys(en).sort())
      for (const key of Object.keys(en)) {
        expect(page.prefixes.some((prefix) => key.startsWith(`${prefix}.`)), `${page.namespace} ${key}`).toBe(true)
        expect(en[key]?.trim(), `en ${key}`).not.toBe('')
        expect(itc[key]?.trim(), `it ${key}`).not.toBe('')
        expect(placeholdersOf(itc[key] ?? ''), `placeholders of ${key}`).toEqual(placeholdersOf(en[key] ?? ''))
      }
    })

    it(`${page.namespace}: every key its code names literally exists`, () => {
      const pattern = new RegExp(`['"\`]((?:${page.prefixes.join('|')})\\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"\`]`, 'g')
      const keys = new Set<string>()
      for (const file of sources(join(ROOT, page.folder))) for (const match of readFileSync(file, 'utf8').matchAll(pattern)) if (!NOT_KEYS.has(match[1]!) && !/(^|\.)example\.com$/.test(match[1]!)) keys.add(match[1]!)
      expect(keys.size, page.namespace).toBeGreaterThan(10)
      const missing = [...keys].filter((key) => !LOCALES.every((locale) => key in (CATALOGUE[locale][page.namespace] ?? {}) || (`${key}_one` in (CATALOGUE[locale][page.namespace] ?? {}) && `${key}_other` in (CATALOGUE[locale][page.namespace] ?? {}))))
      expect(missing).toEqual([])
    })
  }
})
