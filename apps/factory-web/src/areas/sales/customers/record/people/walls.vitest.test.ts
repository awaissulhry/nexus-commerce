import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { createScopedTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { addressMenu } from './addresses'
import { CP, PEOPLE_TAB_NAMESPACES, peopleCan, sayOf, type Said } from './model'
import { personMenu } from './people'
import { riderMenu } from './riders'
import { BUSY, CA_CASES, CA_PARTS, CA_ROLES, caHeld, CaPeopleDesign, caRoleHeld, caTabOf, CHECK, INVOICES, MANY, NEW, PRIVACY, RIDER, SEATS, type CaCaseModel, type CaRole } from './_demo/fixtures'

/**
 * F-CA T.2 (customer page › PEOPLE & ADDRESSES tab, lane ca- ca-t; 15-steps "The wall tests, by name") — the walls of the tab, each by
 * its name, drawn from the gallery's `ca-*` cases (the tab as the container builds it, the server's walls applied as the API applies
 * them) and pinned on the sources:
 *   Brand          "customer B sees nothing of customer A"
 *   Money          "no amount on People & addresses"
 *   Worker privacy "our people's names stay in the office"
 *   Body data      "no measurement without its right"
 *   Rights         "hidden, never held for a right"
 * The words are checked in English and in Italian; a test over every case is split per language and per part of the picture.
 */

const caseOf = (id: string): CaCaseModel => CA_CASES.find((item) => item.id === id)!.ca
const draw = (ca: CaCaseModel, locale: Locale = 'en') => render(createElement(CaPeopleDesign, { ca }), locale)
const words = (ca: CaCaseModel, locale: Locale = 'en') => textOf(draw(ca, locale))
const roleCase = (role: CaRole): CaCaseModel => caseOf(`ca-role-${role.replace('_', '-')}`)
const sayIn = (locale: Locale) => sayOf(createScopedTranslator(locale, messagesFor(locale, [...PEOPLE_TAB_NAMESPACES]), CP), locale)

// The tab's sources: its pure rules and its views (the container and the calls are pinned apart).
const HERE = fileURLToPath(new URL('.', import.meta.url))
const VIEWS = fileURLToPath(new URL('../view/people/', import.meta.url))
const filesOf = (dir: string) =>
  readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
const RULES = filesOf(HERE).filter((file) => file.name !== 'use-people-tab.ts' && file.name !== 'api.ts')
const VIEW_FILES = filesOf(VIEWS)
const TAB = [...RULES, ...VIEW_FILES]
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
/** Every code file under a folder (the portal's), recursively. */
function codeUnder(dir: string): Array<{ readonly path: string; readonly text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return codeUnder(path)
    return /\.(tsx?|jsx?)$/.test(name) ? [{ path, text: readFileSync(path, 'utf8') }] : []
  })
}

const PICTURE = [BUSY, NEW, CHECK, PRIVACY, SEATS, INVOICES, RIDER, MANY] as const

describe('Brand wall (web)', () => {
  it('customer B sees nothing of customer A', () => {
    // 1. Every read names THIS customer's id: the tab's calls, and the container's reads with the page's party id.
    const paths = [...source('./api.ts').matchAll(/`(\/[^`]*)`/g)].map((match) => match[1]!)
    expect(paths.length).toBeGreaterThan(4)
    for (const path of paths) expect(path, path).toMatch(/\$\{enc\((partyId|addressId|riderId)\)\}/)
    const container = source('./use-people-tab.ts')
    for (const read of ['readPartyUsage(api, partyId)', 'listProfiles(api, { partyId })', 'readRiders(api, partyId)', 'getProductionLimits(api, partyId)', "usePortalAccess({ side: 'customers', party: { id: partyId,"]) expect(container, read).toContain(read)
    // 2. No list is filtered by customer in the browser: the rules and the views never keep rows by a customer's id or code.
    for (const file of TAB) {
      expect(file.text, file.name).not.toMatch(/\.filter\([^\n]*\b(?:partyId|customer\.(?:id|code))\b/)
      expect(file.text, file.name).not.toMatch(/\bpartyId\s*[!=]==|[!=]==\s*(?:\w+\.)?partyId\b/)
    }
    // 3. The join reads only this customer's two lists: every row is one of its contacts or one of its portal people; the portal read
    //    names this customer.
    for (const customer of PICTURE) {
      const { model, portal } = caTabOf({ customer, role: 'owner' })
      if (portal?.access) expect(portal.access.party.id, customer.party.code).toBe(customer.party.id)
      for (const row of model.people.all) {
        if (row.contact) expect(customer.party.contacts, `${customer.party.code} ${row.id}`).toContain(row.contact)
        if (row.portal) expect(customer.access.people, `${customer.party.code} ${row.id}`).toContain(row.portal)
      }
      for (const row of model.addresses.all) expect(customer.party.addresses, `${customer.party.code} ${row.id}`).toContain(row.address)
      for (const profile of customer.profiles.rows) expect(profile.partyId, customer.party.code).toBe(customer.party.id)
    }
    // 4. Drawn: customer A's people, e-mails, addresses and riders kept there are nowhere on another customer's tab (its own rider page
    //    names only its team).
    const A = BUSY
    const secrets = [...A.party.contacts.flatMap((row) => [row.name, row.email ?? '']), ...A.access.people.flatMap((row) => [row.displayName, row.email]), ...A.party.addresses.map((row) => row.line1), ...A.profiles.rows.map((row) => row.riderName)].filter((word) => word.trim() !== '')
    const own = words({ customer: A, role: 'owner' })
    for (const name of A.party.contacts.filter((row) => row.status === 'ACTIVE').map((row) => row.name)) expect(own, name).toContain(name)
    for (const B of PICTURE.filter((customer) => customer !== A))
      for (const locale of LOCALES) {
        const theirs = words({ customer: B, role: 'owner' }, locale)
        for (const secret of secrets) expect(theirs.toLowerCase(), `${B.party.code} (${locale}): ${secret}`).not.toContain(secret.toLowerCase())
      }
  })
})

describe('Money wall', () => {
  for (const locale of LOCALES)
    for (const [part, ids] of Object.entries(CA_PARTS))
      it(`no amount on People & addresses — ${locale} · ${part}`, () => {
        for (const id of ids) {
          const text = words(caseOf(id), locale).replace(/[\w.+-]+@[\w.-]+/g, '')
          expect(text.match(/[€$£¥]|\b(?:EUR|CHF|USD|GBP)\b/)?.[0] ?? null, `${id} (${locale}) currency`).toBeNull()
          expect(text.match(/\d[.,]\d{2}(?!\d)/)?.[0] ?? null, `${id} (${locale}) a figure with cents`).toBeNull()
        }
      })

  it('no amount on People & addresses: "Sees prices" is a Yes / No, and the tab reads no amount', () => {
    expect(words(caseOf('ca-busy'))).toContain('Sees prices')
    expect(words(caseOf('ca-busy'))).toContain('No prices')
    expect(words(caseOf('ca-busy'), 'it')).toContain('Vede i prezzi')
    expect(words(caseOf('ca-busy'), 'it')).toContain('Senza prezzi')
    for (const file of TAB) expect(file.text, file.name).not.toMatch(/\b(?:amount|netAmount|currency|formatMoney|formatCurrency|balance)\b/)
  })
})

describe('Worker privacy', () => {
  it("our people's names stay in the office", () => {
    // The portal imports nothing of the tab.
    const SRC = fileURLToPath(new URL('../../../../../', import.meta.url))
    const portal = [...codeUnder(join(SRC, 'portal')), ...codeUnder(join(SRC, 'app', '(portal)'))]
    expect(portal.length).toBeGreaterThan(10)
    for (const file of portal) expect(file.text, file.path).not.toMatch(/['"][^'"]*customers\/record\/(?:view\/)?people(?:\/|['"])/)
    // Measured by / decided by / erased by come only from office reads: who measured is never read; who decided an address comes
    // from the party read's check (the office's own), who erased from the personal-data read; the Refuse window never names who decides.
    for (const file of TAB) expect(file.text, file.name).not.toMatch(/\b(?:takenBy|measuredBy|measuredPlace)\b/)
    for (const file of TAB)
      for (const match of file.text.matchAll(/(?<![.\w'"])(\w+)\??\.(decidedBy|erasedBy)\b/g)) expect([match[1], match[2]], file.name).toEqual(match[2] === 'decidedBy' ? ['approval', 'decidedBy'] : [expect.stringMatching(/^(privacy|data)$/), 'erasedBy'])
    expect(source('../view/people/RefuseAddressDialog.tsx')).not.toContain('decidedBy')
    // Drawn: the office reads who refused and who erased; a rider's measurer is never on the tab.
    expect(words(caseOf('ca-check'))).toContain('Carlo Prova')
    expect(words(caseOf('ca-privacy'))).toContain('Alex Demo')
    for (const id of ['ca-busy', 'ca-rider', 'ca-many']) expect(words(caseOf(id)), id).not.toContain('Demo Fitter')
  })
})

describe('Body data (web)', () => {
  it('no measurement without its right', () => {
    // The roles without sales.measurements.view (their template's REAL grant): Finance, Warehouse, Read-only.
    const blind: readonly CaRole[] = ['finance', 'warehouse', 'read_only']
    for (const role of blind) expect(peopleCan(caRoleHeld(role)).measurements, role).toBe(false)
    for (const role of ['owner', 'sales', 'production_manager'] as const) expect(peopleCan(caRoleHeld(role)).measurements, role).toBe(true)
    const cases = [...blind.map(roleCase), caseOf('ca-no-measurements-right')]
    for (const ca of cases) {
      // The API's wall: no profile read, no rider's profile count (null, never 0).
      const { reads, model } = caTabOf(ca)
      expect(reads.profiles, ca.role).toBeNull()
      expect(model.riders.measurements, ca.role).toBe(false)
      for (const rider of model.riders.all) {
        expect(rider.profiles, `${ca.role} ${rider.name}`).toEqual([])
        expect(rider.party?.measurementProfiles ?? null, `${ca.role} ${rider.name}`).toBeNull()
      }
      for (const locale of LOCALES) {
        const text = words(ca, locale)
        // The riders' names only (a rider with its own page, a contact with the role Rider), said once.
        expect(text, `${ca.role} (${locale})`).toContain('Pilota Seed')
        expect(text, `${ca.role} (${locale})`).toContain('Davide Campione')
        expect(text, `${ca.role} (${locale})`).toContain(locale === 'en' ? 'profiles are not shown: your role does not see measurement profiles' : 'i profili non sono mostrati: il tuo ruolo non vede i profili di misura')
        // No revision, size, review, measuring day or profile count.
        for (const word of locale === 'en' ? ['Rev. ', 'Closest size', 'Measured ', 'on its own page ›', 'Marta Demo'] : ['Rev. ', 'Taglia più vicina', 'Misurato il', 'sulla sua pagina ›', 'Marta Demo']) expect(text, `${ca.role} (${locale}): ${word}`).not.toContain(word)
      }
    }
    // With the right, the same team shows its profiles (the size, the revision) — never a measurement itself.
    const owner = words(roleCase('owner'))
    for (const word of ['Rev. ', 'Closest size 52', 'Marta Demo', '2 profiles on its own page ›']) expect(owner, word).toContain(word)
    // The tab never reads a measurement: no value, fit note or note of a revision; every `.measurements` it reads is a right or a flag.
    for (const file of TAB) {
      expect(file.text, file.name).not.toMatch(/\b(?:fitNotes|internalNote|measuredBy|takenBy)\b/)
      for (const match of file.text.matchAll(/(\w+)\??\.measurements\b/g)) expect(['can', 'facts', 'riders', 'mtm', 'sales'], `${file.name}: ${match[0]}`).toContain(match[1])
    }
  })
})

describe('Rights', () => {
  /** A held reason that names a right (the parties' and the depth's "Needs the right …", the portal's `right.*`). */
  const RIGHT_KEY = /(?:^|:)(?:right\.|held\.(?:manage|block|vies|hold|privacy|erase|styles|files|right|projects|needs|noRight)$)/
  const RIGHT_WORDS: Readonly<Record<Locale, RegExp>> = { en: /needs the right|your role|permission/i, it: /serve il permesso|il tuo ruolo|permesso/i }

  for (const role of CA_ROLES)
    it(`hidden, never held for a right — ${role}`, () => {
      const ca = roleCase(role)
      const can = peopleCan(caHeld(ca))
      const { model } = caTabOf(ca)
      // Every act's held reason, on every row's ⋯ and every head, is a STATE (never a missing right).
      const held: Said[] = [
        ...model.people.all.flatMap((row) => personMenu(row, model.people.menu).flatMap((item) => (item.held ? [item.held] : []))),
        ...model.addresses.all.flatMap((row) => addressMenu(row, model.addresses.menu).flatMap((item) => (item.held ? [item.held] : []))),
        ...model.riders.all.flatMap((row) => riderMenu(row, model.riders.menu).flatMap((item) => (item.held ? [item.held] : []))),
        ...[model.people.invite.held, model.riders.head.newHeld, model.riders.head.linkHeld, model.riders.head.held, model.privacy.recordHeld].filter((entry): entry is Said => entry !== null),
      ]
      for (const reason of held) {
        expect(reason.key, `${role}: ${reason.key}`).not.toMatch(RIGHT_KEY)
        for (const locale of LOCALES) expect(sayIn(locale)(reason), `${role} (${locale}): ${reason.key}`).not.toMatch(RIGHT_WORDS[locale])
      }
      for (const locale of LOCALES) {
        const html = draw(ca, locale)
        for (const match of html.matchAll(/aria-description="([^"]*)"/g)) expect(match[1], `${role} (${locale})`).not.toMatch(RIGHT_WORDS[locale])
      }
      // The buttons drawn are exactly the ones the role has (each its own right).
      const html = draw(ca)
      const text = textOf(html)
      expect(text.includes('Add contact'), `${role}: Add contact`).toBe(can.manage)
      expect(text.includes('Add address'), `${role}: Add address`).toBe(can.manage)
      expect(html.includes('lucide-user-plus'), `${role}: Invite`).toBe(can.invite && can.portal)
      expect(text.includes('New measurements'), `${role}: New measurements`).toBe(can.measurements && can.mtmRecord)
      expect(text.includes('Send a measurement link…'), `${role}: Send a measurement link`).toBe(can.measurements && can.mtmLink)
      expect(text.includes('Approve'), `${role}: Approve`).toBe(can.ordersManage)
      expect(text.includes('Sees prices'), `${role}: the portal column`).toBe(can.portal)
      expect(model.riders.head.addRider, `${role}: Add rider…`).toBe(can.manage)
    })

  it('hidden, never held for a right — Read-only invites no one (R-B3), and changes nothing', () => {
    const ca = roleCase('read_only')
    const can = peopleCan(caHeld(ca))
    expect(can.invite).toBe(false)
    expect(can.manage).toBe(false)
    const { model } = caTabOf(ca)
    expect(model.people.invite.shown).toBe(false)
    const html = draw(ca)
    expect(html).not.toContain('lucide-user-plus')
    for (const word of ['Add contact', 'Add address', 'Add the registered office', 'Approve']) expect(textOf(html), word).not.toContain(word)
    // Its ⋯ offers no change: no Edit, Archive…, Restore, Invite or portal act on any row.
    const acts = model.people.all.flatMap((row) => personMenu(row, model.people.menu).map((item) => item.act ?? item.id))
    for (const act of ['edit', 'archive', 'restore', 'invite', 'change', 'resend', 'revoke', 'suspend', 'reactivate', 'deactivate', 'erase']) expect(acts, act).not.toContain(act)
  })
})
