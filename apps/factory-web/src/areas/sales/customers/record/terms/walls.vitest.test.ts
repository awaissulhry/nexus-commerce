import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '../../../../../lib/api/client'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { createScopedTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { searchStyles } from '../../depth/api'
import { fiscalCodeHidden } from './identity'
import { CT, sayOf, TERMS_TAB_NAMESPACES, termsCan, type Said } from './model'
import type { Act } from './holds'
import type { TermsTabModel } from './tab'
import { CT_BUSY, CT_CASES, CT_ROLES, CT_SOLE, CT_SOLE_FISCAL_CODE, CT_TWO, ctRoleHeld, CtTermsDesign, ctTabOf, type CtCaseModel, type CtRole } from './_demo/fixtures'

/**
 * F-CT T.2 (customer page › TERMS & REQUIREMENTS tab, lane ct- ct-t; 15-steps "The wall tests, by name") — the walls of the tab, each by
 * its name, drawn from the gallery's `ct-*` cases (the tab as the container builds it, the server's walls applied as the API applies
 * them) and pinned on the sources:
 *   Brand          "customer B sees nothing of customer A"
 *   Money          "no amount on Terms & requirements without the price grain"
 *   Worker privacy "our people's names stay in the office"
 *   Personal data  "a sole trader's codice fiscale only to those who may change customers" (D2)
 *   Rights         "hidden, never held for a right"
 * The words are checked in English and in Italian.
 */

const caseOf = (id: string): CtCaseModel => CT_CASES.find((item) => item.id === id)!.ct
const roleId = (role: CtRole) => role.replace('_', '-')
const draw = (ct: CtCaseModel, locale: Locale = 'en') => render(createElement(CtTermsDesign, { ct }), locale)
const words = (ct: CtCaseModel, locale: Locale = 'en') => textOf(draw(ct, locale))
const sayIn = (locale: Locale) => sayOf(createScopedTranslator(locale, messagesFor(locale, [...TERMS_TAB_NAMESPACES]), CT), locale)
const said1 = (words: Said, locale: Locale = 'en') => sayIn(locale)(words)

// The tab's sources: its pure rules and its views (the container and the calls are pinned by name below).
const HERE = fileURLToPath(new URL('.', import.meta.url))
const VIEWS = fileURLToPath(new URL('../view/terms/', import.meta.url))
const filesOf = (dir: string) =>
  readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
const TAB_FILES = [...filesOf(HERE), ...filesOf(VIEWS)]
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('Brand: customer B sees nothing of customer A', () => {
  it('every read of the tab names THIS customer on the server (its id in the call)', () => {
    const container = read('./use-terms-tab.ts')
    for (const call of ['getCommercialTerms(api, partyId)', 'readCarrierAccount(api, partyId)']) expect(container, call).toContain(call)
    const depth = read('../../depth/use-depth.ts')
    for (const call of ['readHolds(api, partyId)', 'readCompanyTerms(api, partyId)', 'readRequirements(api, partyId)', 'readPartyFiles(api, partyId)', 'searchStyles(api, styleQuery, partyId, controller.signal)']) expect(depth, call).toContain(call)
    const record = read('../../../../parties/_shared/PartyRecord.tsx')
    for (const call of ['viesHistory(api, partyId)', 'viesHistory(api, partyId, history.next)']) expect(record, call).toContain(call)
  })

  it('the style search sends forCustomer=<this customer> (S1: our own styles and this customer\'s, never another brand\'s)', async () => {
    const urls: string[] = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ styles: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchFn, csrfToken: () => 'csrf' })
    await searchStyles(api, 'seed', CT_BUSY.party.id)
    expect(urls).toHaveLength(1)
    const query = new URL(urls[0]!, 'http://x').searchParams
    expect(query.get('forCustomer')).toBe(CT_BUSY.party.id)
    expect(query.get('q')).toBe('seed')
  })

  it('no list is filtered by customer in the browser; the library\'s customers count is never read; another customer is never named', () => {
    expect(TAB_FILES.length).toBeGreaterThan(20)
    for (const { name, text } of TAB_FILES) {
      expect(text, name).not.toMatch(/\.filter\([^)]*(partyId|party\.id|customerId)/)
      expect(text, name).not.toMatch(/\.customers\b(?!\/)/)
    }
    const busy = words(caseOf('ct-busy'))
    for (const other of [CT_TWO.party.code, CT_TWO.party.legalName, CT_SOLE.party.code]) expect(busy, other).not.toContain(other)
  })
})

describe('Money: no amount on Terms & requirements without the price grain', () => {
  /** An amount on screen: a currency sign or a figure with cents. */
  const AMOUNT = /€|\d[.,]\d{2}\b/
  const WITHOUT: readonly CtRole[] = CT_ROLES.filter((role) => !ctRoleHeld(role).includes('money.price'))

  it('the roles without the price grain are the ones the design names (Sales, Production manager, Warehouse, Read-only)', () => {
    for (const role of ['sales', 'production_manager', 'warehouse', 'read_only'] as const) expect(WITHOUT, role).toContain(role)
    // The guard is real: with the price grain the minimum order IS an amount on screen.
    expect(words(caseOf('ct-role-owner'))).toMatch(AMOUNT)
  })

  for (const locale of LOCALES) {
    it(`${locale}: no minimum order and no credit amount for a role without the grain; the term names stay`, () => {
      for (const role of WITHOUT) {
        const text = words(caseOf(`ct-role-${roleId(role)}`), locale)
        expect(text.match(AMOUNT)?.[0] ?? null, `${role} (${locale})`).toBeNull()
        expect(text, `${role} (${locale})`).toContain(locale === 'en' ? 'Bank transfer 60 days' : 'Bonifico 60 gg')
      }
    })
  }

  it('the rules never draw the minimum or a credit limit without the grain (the model, not only the screen)', () => {
    for (const role of WITHOUT) {
      const { reads } = ctTabOf(caseOf(`ct-role-${roleId(role)}`))
      expect(reads.can.price, role).toBe(false)
      expect(reads.commercial?.status === 'ready' ? reads.commercial.value.minimumOrderAmount : 'unread', role).toBeNull()
      const companies = reads.companies?.status === 'ready' ? reads.companies.value.companies : []
      for (const entry of companies) expect(entry.terms?.creditLimitAmount ?? null, role).toBeNull()
    }
  })
})

describe('Worker privacy: our people\'s names stay in the office', () => {
  const PORTAL = fileURLToPath(new URL('../../../../../portal/', import.meta.url))
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : /\.tsx?$/.test(name) ? [join(dir, name)] : []))

  it('no file under the portal imports the tab (its rules or its views)', () => {
    const files = walk(PORTAL)
    expect(files.length).toBeGreaterThan(50)
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/customers\/record\/(terms|view\/terms)\b/)
  })

  it('who placed, released, wrote or ended comes only from the office reads (the rules read them, never a portal API)', () => {
    for (const { name, text } of TAB_FILES) expect(text, name).not.toMatch(/from '[^']*\/portal\//)
    expect(read('./holds.ts')).toMatch(/placedBy/)
    expect(read('./requirements.ts')).toContain('by: row.createdBy')
  })
})

describe('Personal data: a sole trader\'s codice fiscale only to those who may change customers (D2)', () => {
  for (const locale of LOCALES) {
    it(`${locale}: Terms shows it to a role with parties.manage only; the others read "Hidden for your role" once`, () => {
      for (const role of CT_ROLES) {
        const manage = ctRoleHeld(role).includes('parties.manage')
        const text = words(caseOf(`ct-sole-${roleId(role)}`), locale)
        if (manage) expect(text, `${role} (${locale})`).toContain(CT_SOLE_FISCAL_CODE)
        else {
          expect(text, `${role} (${locale})`).not.toContain(CT_SOLE_FISCAL_CODE)
          expect(text.split(said1({ key: 'ct.id.personal' }, locale)).length - 1, `${role} (${locale})`).toBe(1)
        }
      }
    })
  }

  it('Warehouse, Production manager and Read-only may not: hidden on Terms AND on the Overview fact (the ONE rule)', () => {
    for (const role of ['warehouse', 'production_manager', 'read_only'] as const) {
      expect(ctRoleHeld(role), role).not.toContain('parties.manage')
      expect(fiscalCodeHidden(CT_SOLE.party, termsCan(ctRoleHeld(role))), role).toBe(true)
    }
    expect(read('../overview/rows.ts')).toContain('!fiscalCodeHidden(party, can)')
    expect(fiscalCodeHidden(CT_BUSY.party, termsCan(ctRoleHeld('read_only')))).toBe(false) // an organisation's is no personal data
  })
})

describe('Rights: hidden, never held for a right', () => {
  const actsOf = (model: TermsTabModel): Array<readonly [string, Act]> => [
    ['hold.place', model.hold.place],
    ...model.hold.inForce.map((row) => [`hold.release.${row.id}`, row.release] as const),
    ['commercial.change', model.commercial.head.change],
    ['commercial.delivery', model.commercial.head.delivery],
    ['commercial.po', model.commercial.poChange],
    ...model.commercial.menu.setFor.map((item) => [`commercial.setFor.${item.companyId}`, item.act] as const),
    ...(model.commercial.companies ?? []).flatMap((row, at) => [[`company.set.${at}`, row.set] as const, [`company.back.${at}`, row.back] as const]),
    ['requirements.add', model.requirements.add],
    ...model.requirements.rows.flatMap((row) => [[`requirement.replace.${row.id}`, row.replace] as const, [`requirement.end.${row.id}`, row.end] as const]),
    ['identity.correct', model.identity.correct],
    ['identity.add', model.identity.add],
    ...(model.identity.vies ? [['vies.checkAgain', model.identity.vies.checkAgain] as const] : []),
  ]
  const CHANGES = /^(commercial\.|company\.|requirements?\.|identity\.)/

  it('per role: an act is drawn only with its right, and never held for a right', () => {
    for (const role of CT_ROLES) {
      const held = ctRoleHeld(role)
      const acts = actsOf(ctTabOf(caseOf(`ct-role-${roleId(role)}`)).model)
      expect(acts.length, role).toBeGreaterThan(8)
      for (const [name, act] of acts) {
        expect(act.held, `${role} ${name}`).toBeNull() // the busy brand is not archived and no VIES check runs
        if (CHANGES.test(name) && !held.includes('parties.manage')) expect(act.shown, `${role} ${name}`).toBe(false)
        if (name.startsWith('hold.') && !held.includes('parties.hold')) expect(act.shown, `${role} ${name}`).toBe(false)
      }
    }
    // The Owner sees every act of the busy brand.
    const owner = actsOf(ctTabOf(caseOf('ct-role-owner')).model)
    for (const name of ['commercial.change', 'commercial.delivery', 'requirements.add', 'identity.correct', 'identity.add']) expect(owner.find(([key]) => key === name)![1].shown, name).toBe(true)
  })

  it('held only by state: an archived customer holds every act it draws with its words; a VIES check running holds Check again', () => {
    for (const [name, act] of actsOf(ctTabOf(caseOf('ct-archived')).model)) if (act.shown) expect(act.held, name).not.toBeNull()
    const running = ctTabOf(caseOf('ct-eu-checking')).model.identity.vies!.checkAgain
    expect([running.shown, running.held && said1(running.held)]).toEqual([true, 'A check is running'])
    for (const locale of LOCALES) expect(said1(ctTabOf(caseOf('ct-archived')).model.commercial.head.change.held!, locale), locale).not.toMatch(/right|permess|ruolo|role/i)
  })

  it('the readers\' words never say a right is missing on the tab (the record says "You can view, not change" once)', () => {
    for (const role of CT_ROLES) {
      const text = words(caseOf(`ct-role-${roleId(role)}`))
      expect(text, role).not.toMatch(/You (may|can) not|needs the right|your role may/i)
    }
  })
})
