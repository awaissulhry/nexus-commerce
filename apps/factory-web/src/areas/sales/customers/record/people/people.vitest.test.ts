import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mailsOfContacts } from '@nexus/factory-domain/parties/contact-mails'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import { CATALOGUE, createScopedTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { Address, Contact, Party } from '../../../../parties/_shared/api'
import { CUSTOMERS } from '../../../../parties/_shared/fixtures'
import type { PartnerPerson, PortalAccess } from '../../../../admin/users/partners/api'
import { customerAccess, CUSTOMER_PEOPLE, portalModel as portalModelOf } from '../../portal/demo'
import type { PrivacyContact } from '../../depth/api'
import { addressRows, invoiceAddressOf, refusedInView, shownAddresses, addressMenu } from './addresses'
import { peopleAnswer, peopleBadge, peopleSectionAnswer, personFilterOf, privacyExceptions, privacySectionAnswer, type PeopleFacts } from './answer'
import { addressArchiveWarnings, contactArchiveWarnings } from './archive'
import { objectionAt } from '../../depth/model'
import { CP, failedRead, PEOPLE_SECTIONS, PEOPLE_TAB_NAMESPACES, peopleCan, READING, readyRead, said, sayOf, type Said } from './model'
import { partyUsageSchema, type PartyUsage, type RidersView } from './api'
import { riderMenu, riderRows, ridersAnswer } from './riders'
import type { ProfileRow, ProfilesView } from '../../../mtm/api'
import { ROWS as MTM_ROWS } from '../../../mtm/demo/fixtures'
import { partyUsageAnswer } from '@nexus/factory-domain/parties/usage'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { designScreen as customerRecordScreen } from '../fixtures'
import { addRiderProblem, PEOPLE_TAB_START, peopleTabModel, teamProblem, type AddRiderDialog, type PeopleTabReads } from './tab'
import { peopleRows, personMenu, shownPeople, type PeopleInput } from './people'

/**
 * F-CA-101…106 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 15-steps W1.1) — the tab's pure rules: one row per person (the join
 * by exact e-mail inside THIS customer), the answer line and its chips in both languages, the tab's count, the address rows, the ⋯
 * items (hidden without the right, held only by state), every word in both catalogues.
 */

const NOW = '2026-11-24T09:00:00.000Z'
const MODA = CUSTOMERS.find((party) => party.code === 'MODA-DEMO')!
const say = (locale: Locale) => sayOf(createScopedTranslator(locale, messagesFor(locale, [...PEOPLE_TAB_NAMESPACES]), CP), locale)
const sentence = (words: readonly Said[], locale: Locale) => words.map(say(locale)).join(' · ')
const ALL = peopleCan(['parties.view', 'parties.manage', 'orders.manage', 'partners.view', 'partners.invite', 'partners.manage', 'audit.read'])
const READ_ONLY = peopleCan(['parties.view', 'partners.view'])
const ALL_MEASURED = peopleCan(['parties.view', 'parties.manage', 'orders.view', 'sales.measurements.view', 'sales.mtm.record', 'sales.measurements.manage', 'sales.mtm.review', 'sales.fittings.manage'])

const contact = (n: number, name: string, email: string | null, roles: Contact['roles'], over: Partial<Contact> = {}): Contact => ({ id: `c${n}`, name, email, phone: null, roles, language: null, status: 'ACTIVE', version: 1, createdAt: `2026-0${n}-01T00:00:00.000Z`, updatedAt: NOW, ...over })
const person = (id: string, displayName: string, email: string, over: Partial<PartnerPerson> = {}): PartnerPerson => ({ ...CUSTOMER_PEOPLE[1]!, id, displayName, email, ...over })
const privacyOf = (row: Contact, over: Partial<PrivacyContact> = {}): PrivacyContact => ({ id: row.id, name: row.name, erased: false, status: row.status, lawfulBasis: 'CONTRACT', consentAt: null, consentSource: null, objectedAt: null, erasedAt: null, erasedBy: null, version: 1, ...over })
const mailsOf = (contacts: readonly Contact[]) => mailsOfContacts(contacts.map((row) => ({ id: row.id, name: row.name, email: row.email, roles: row.roles, status: row.status, createdAt: row.createdAt })))
const input = (contacts: readonly Contact[], portal: readonly PartnerPerson[] | null, over: Partial<PeopleInput> = {}): PeopleInput => ({ contacts, portal, privacy: contacts.map((row) => privacyOf(row)), mails: mailsOf(contacts), usage: null, approverId: null, now: NOW, ...over })
const address = (n: number, over: Partial<Address> = {}): Address => ({ ...MODA.addresses[0]!, id: `a${n}`, createdAt: `2026-0${n}-01T00:00:00.000Z`, ...over })
const facts = (party: Pick<Party, 'kind' | 'contacts' | 'addresses'>, portal: PortalAccess | null, over: Partial<PeopleFacts> = {}): PeopleFacts => ({
  kind: party.kind,
  people: peopleRows(input(party.contacts, portal?.settings.portalOn ? portal.people : null)),
  addresses: addressRows(party.addresses, null),
  portal: portal ? { on: portal.settings.portalOn, seats: portal.seats } : null,
  portalRight: true,
  privacyIn: true,
  riders: null,
  team: null,
  ...over,
})

describe('one row per person (Z1): contacts ∪ portal people by exact e-mail inside this customer', () => {
  it('a contact and a portal person with the same e-mail (case and spaces aside) are ONE row; the privacy state comes by the contact id', () => {
    const anna = contact(1, 'Anna Demo', 'Anna.Demo@example.com', ['ORDERS'])
    const rows = peopleRows(input([anna], [person('u1', 'Anna D.', '  anna.demo@EXAMPLE.com ')], { privacy: [privacyOf(anna, { lawfulBasis: null })] }))
    expect(rows.map((row) => row.id)).toEqual(['c-c1'])
    expect(rows[0]!.portal?.id).toBe('u1')
    expect(rows[0]!.basisMissing).toBe(true)
  })

  it('a typo in an e-mail shows two rows (honest); a portal person who is no contact is "Portal only", hinted when the name is the same', () => {
    const rows = peopleRows(input([contact(1, 'Anna Demo', 'anna.demo@example.com', ['ORDERS'])], [person('u1', 'Anna Demo', 'ana.demo@example.com')]))
    expect(rows.map((row) => row.id)).toEqual(['c-c1', 'u-u1'])
    expect(rows[1]!.contact).toBeNull()
    expect(rows[1]!.sameName).toBe('Anna Demo')
    expect(say('en')({ key: 'people.portalOnly' })).toBe('Portal only')
    expect(say('it')({ key: 'people.portalOnly' })).toBe('Solo portale')
  })

  it('only the two lists handed are read (this customer\'s): no row comes from anywhere else, an active contact wins the join over an archived one', () => {
    const old = contact(1, 'Old Anna', 'anna@example.com', ['ORDERS'], { status: 'ARCHIVED' })
    const anna = contact(2, 'Anna', 'anna@example.com', ['ORDERS'])
    const rows = peopleRows(input([old, anna], [person('u1', 'Anna', 'anna@example.com')]))
    expect(rows.map((row) => [row.id, row.portal?.id ?? null])).toEqual([
      ['c-c1', null],
      ['c-c2', 'u1'],
    ])
    expect(peopleRows(input([], null))).toEqual([])
  })

  it('an erased contact is "Erased contact" with nothing to edit — by the privacy read, or by its blank name while that read is out', () => {
    const erased = contact(1, '', null, ['ORDERS'], { status: 'ARCHIVED' })
    const [byName] = peopleRows(input([erased], null, { privacy: null }))
    expect(byName!.erased).toBe(true)
    const [byRead] = peopleRows(input([contact(2, 'X', null, [], { status: 'ARCHIVED' })], null, { privacy: [privacyOf(contact(2, 'X', null, []), { erased: true })] }))
    expect(byRead!.erased).toBe(true)
    const menu = personMenu(byRead!, { can: ALL, access: null, archivedCustomer: false, prefix: '/w/DEMO' })
    expect(menu.map((item) => item.id)).toEqual(['erased', 'link'])
    expect(say('en')(menu[0]!.held!)).toBe('This contact was erased: nothing more can be done with it.')
  })

  it('what each contact gets comes from the mail rule; an Orders contact without an e-mail gets nothing and says so', () => {
    const rows = peopleRows(input([contact(1, 'Anna', 'anna@example.com', ['ORDERS']), contact(2, 'Bruno', 'bruno@example.com', ['INVOICES']), contact(3, 'Carla', null, ['ORDERS'])], null))
    // No Quality contact: the recall notice goes to the first one with an e-mail by name (Anna).
    expect(rows.map((row) => row.mails)).toEqual([['QUOTES_AND_CONFIRMATIONS', 'SHIPPING_NOTICES', 'DELAY_NOTICES', 'RECALLS'], ['DEPOSIT_PAGES', 'INVOICES_AND_REMINDERS'], []])
    expect(rows[2]!.noMail).toBe(true)
  })

  it('archived contacts and people who left show only when asked', () => {
    const rows = peopleRows(input([contact(1, 'Anna', 'a@example.com', ['ORDERS']), contact(2, 'Old', 'o@example.com', [], { status: 'ARCHIVED' })], [person('u9', 'Gone', 'gone@example.com', { status: 'DEACTIVATED' })]))
    expect(shownPeople(rows, { archived: false, left: false }).map((row) => row.id)).toEqual(['c-c1'])
    expect(shownPeople(rows, { archived: true, left: true }).map((row) => row.id)).toEqual(['c-c1', 'u-u9', 'c-c2']) // live first, then by name
  })
})

describe('the answer line (Z5) and the tab count (Z4)', () => {
  const access = customerAccess({ people: [person('u1', 'Anna Demo', 'acquisti@moda-demo.example.com'), person('u2', 'Paolo', 'paolo@example.com', { status: 'INVITED', invitation: null, lastSignInAt: null })], seats: { taken: 2, max: 2 } })

  it('says who works with us, who signs in, the addresses — in English and in Italian', () => {
    const answer = peopleAnswer(facts(MODA, access))
    expect(sentence(answer.words, 'en')).toBe('3 people · 1 signs in to the portal, 1 invited (2 of 2 seats) · 2 addresses')
    expect(sentence(answer.words, 'it')).toBe('3 persone · 1 accede al portale, 1 invitato (2 di 2 posti) · 2 indirizzi')
    expect(sentence(peopleAnswer(facts({ kind: 'ORGANISATION', contacts: [], addresses: [] }, null)).words, 'en')).toBe('Nobody and no address yet')
  })

  it('the chips are the doors to exactly their rows: an expired invitation, seats full, nobody gets invoices…', () => {
    const answer = peopleAnswer(facts({ ...MODA, contacts: [MODA.contacts[0]!] }, access))
    expect(answer.chips.map((chip) => chip.id)).toEqual(['expired', 'seats', 'noInvoices'])
    expect(answer.tone).toBe('warning')
    expect(answer.chips.map((chip) => say('en')(chip.label))).toEqual(['1 invitation expired', 'Seats full (2 of 2)', 'Nobody gets invoices'])
    expect(answer.chips.map((chip) => say('it')(chip.label))).toEqual(['1 invito scaduto', 'Posti esauriti (2 di 2)', 'Nessuno riceve le fatture'])
    const rows = facts({ ...MODA, contacts: [MODA.contacts[0]!] }, access).people
    expect(rows.filter(personFilterOf('expired')!).map((row) => row.id)).toEqual(['u-u2'])
  })

  it('"No registered office: can\'t invoice yet" only when no address can be invoiced; two registered offices say the oldest is used', () => {
    expect(peopleAnswer(facts({ ...MODA, addresses: [address(1, { kinds: ['SHIP_TO'], isDefaultBillTo: false })] }, null)).chips.map((chip) => chip.id)).toContain('noRegistered')
    expect(peopleAnswer(facts({ ...MODA, addresses: [address(1, { kinds: ['BILL_TO'], isDefaultBillTo: true })] }, null)).chips.map((chip) => chip.id)).not.toContain('noRegistered')
    const two = [address(2, { kinds: ['REGISTERED'], city: 'Milano' }), address(1, { kinds: ['REGISTERED'], city: 'Firenze' })]
    expect(peopleAnswer(facts({ ...MODA, addresses: two }, null)).chips.map((chip) => chip.id)).toContain('registered')
    expect(invoiceAddressOf(two)?.city).toBe('Firenze')
    expect(addressRows(two, null).find((row) => row.otherRegistered)?.address.city).toBe('Milano')
  })

  it('the People answer names who gets quotes and invoices, and what a role does not see — said once', () => {
    expect(sentence(peopleSectionAnswer(facts(MODA, null)), 'en')).toBe('2 contacts · quotes & confirmations go to Anna Demo · invoices & reminders to Bruno Esempio')
    expect(sentence(peopleSectionAnswer(facts(MODA, null, { portalRight: false })), 'it')).toContain("l'accesso al portale non è mostrato per il tuo ruolo")
  })

  it('the tab count = the addresses waiting for our check only (never "0")', () => {
    expect(peopleBadge(MODA)).toBeNull()
    const waiting = { ...MODA, addresses: [...MODA.addresses, address(3, { approval: { status: 'WAITING', requestedAt: NOW, requestedBy: 'Giulia Esempio', decidedAt: null, decidedBy: null, refuseReason: null } })] }
    expect(peopleBadge(waiting)).toEqual({ count: 1, attention: true })
    expect(peopleAnswer(facts(waiting, null)).chips[0]!.id).toBe('check')
  })
})

describe('addresses (Z17): the check of a portal-added address, the defaults, a refusal in view 30 days', () => {
  const waiting = address(5, { kinds: ['SHIP_TO'], approval: { status: 'WAITING', requestedAt: NOW, requestedBy: 'Giulia Esempio', decidedAt: null, decidedBy: null, refuseReason: null } })
  const refused = (days: number) => address(6, { status: 'ARCHIVED', approval: { status: 'REFUSED', requestedAt: NOW, requestedBy: 'Giulia Esempio', decidedAt: new Date(Date.parse(NOW) - days * 86_400_000).toISOString(), decidedBy: 'Alex Demo', refuseReason: 'Not a delivery point we serve.' } })

  it('a waiting address offers Approve and Refuse… first (orders.manage), and it cannot be a default yet', () => {
    const [row] = addressRows([waiting], null)
    const items = addressMenu(row!, { can: ALL, archivedCustomer: false, prefix: '/w/DEMO' })
    expect(items.slice(0, 2).map((item) => item.id)).toEqual(['approve', 'refuse'])
    expect(say('en')(items.find((item) => item.id === 'shipTo')!.held!)).toBe('It waits for our check: it can be a default once it is approved.')
    expect(addressMenu(row!, { can: READ_ONLY, archivedCustomer: false, prefix: '/w/DEMO' }).map((item) => item.id)).not.toContain('approve')
  })

  it('a refused address stays in view 30 days after the decision, then only under Show archived; it never changes', () => {
    expect(refusedInView(addressRows([refused(29)], null)[0]!, NOW)).toBe(true)
    expect(shownAddresses(addressRows([refused(31)], null), { archived: false }, NOW)).toEqual([])
    expect(addressMenu(addressRows([refused(2)], null)[0]!, { can: ALL, archivedCustomer: false, prefix: '/w/DEMO' }).map((item) => item.id)).toEqual(['refused', 'copy', 'link'])
  })
})

describe('the ⋯ of a person: hidden without the right, held only by state (Z7, R-B3)', () => {
  const anna = peopleRows(input([contact(1, 'Anna', 'anna@example.com', ['ORDERS'])], []))[0]!
  const noEmail = peopleRows(input([contact(2, 'Carla', null, ['DESIGN'])], []))[0]!
  const full = customerAccess({ seats: { taken: 10, max: 10 } })

  it('Read-only: no Invite, no Edit, no Archive — only the copies', () => {
    expect(personMenu(anna, { can: READ_ONLY, access: customerAccess(), archivedCustomer: false, prefix: '/w/DEMO' }).filter((item) => !item.separator).map((item) => item.id)).toEqual(['copyEmail', 'link'])
  })

  it('Invite is held by STATE only: no e-mail, seats full — never by a right (the words never name a right)', () => {
    const en = say('en')
    expect(en(personMenu(noEmail, { can: ALL, access: customerAccess(), archivedCustomer: false, prefix: '/w/DEMO' }).find((item) => item.id === 'invite')!.held!)).toBe('An invitation needs an e-mail: add it to the contact first.')
    expect(en(personMenu(anna, { can: ALL, access: full, archivedCustomer: false, prefix: '/w/DEMO' }).find((item) => item.id === 'invite')!.held!)).toMatch(/Every seat of this portal is taken/)
    for (const item of personMenu(anna, { can: ALL, access: customerAccess(), archivedCustomer: true, prefix: '/w/DEMO' })) if (item.held) expect(en(item.held)).not.toMatch(/right/i)
  })
})

describe('the words: every key the tab says exists in both languages, the four sections have their addresses', () => {
  it('each said(\'…\') key of the tab\'s files is in its catalogue, in Italian and in English', () => {
    const files = ['.', '../view/people'].flatMap((folder) => readdirSync(new URL(`${folder}/`, import.meta.url)).filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.')).map((name) => readFileSync(new URL(`${folder}/${name}`, import.meta.url), 'utf8')))
    const keys = new Set(files.flatMap((source) => [...source.matchAll(/said\(\s*'([^'$]+)'/g)].map((match) => match[1]!)))
    expect(keys.size).toBeGreaterThan(80)
    for (const locale of LOCALES)
      for (const key of keys) {
        if (key === '') continue
        const [namespace, path] = key.includes(':') ? (key.split(':') as [string, string]) : [CP, key]
        const words = CATALOGUE[locale][namespace] ?? {}
        expect(words[path] !== undefined || words[`${path}_other`] !== undefined, `${locale} ${key}`).toBe(true)
      }
  })

  it('the sections are #people, #addresses, #riders, #personal-data (the Overview points at them)', () => {
    expect([...PEOPLE_SECTIONS]).toEqual(['people', 'addresses', 'riders', 'personal-data'])
  })

  it('Z6: the shared contact window keeps "Email"; the two "party" phrases are neutral now', () => {
    const en = CATALOGUE.en.parties!
    const it = CATALOGUE.it.parties!
    expect(en['contact.col.email']).toBe('Email')
    expect([en['field.partyLanguage'], it['field.partyLanguage']]).toEqual(['Default language', 'Lingua predefinita'])
    expect([en['form.contact.emailTwice'], it['form.contact.emailTwice']]).toEqual(['Another contact here has this e-mail', 'Un altro contatto qui ha questa e-mail'])
    for (const locale of LOCALES) expect(JSON.stringify(CATALOGUE[locale][CP])).not.toMatch(/\bpart(y|ies)\b/i)
  })
})

// ---- W1.2: the container's model and the windows in place (13-backend §3; Z13)
describe('the tab\'s model (tab.ts) and the windows mounted in place', () => {
  const portalModel = portalModelOf('customers', { access: customerAccess({ people: [person('u1', 'Anna Demo', 'acquisti@moda-demo.example.com')] }) })
  const reads = (over: Partial<PeopleTabReads> = {}): PeopleTabReads => ({ party: MODA, prefix: '/w/DEMO', can: ALL, now: NOW, portal: portalModel, privacy: null, usage: null, approverId: null, profiles: null, riders: null, ...over })

  it('the usage lines are left out while the usage read reads or failed — never 0; read, a contact says its open quotes', () => {
    expect(peopleTabModel(reads({ usage: READING }), PEOPLE_TAB_START).addresses.usageIn).toBe(false)
    const usage: PartyUsage = { partyId: MODA.id, asOf: NOW, contacts: [{ contactId: MODA.contacts[0]!.id, openQuotes: 2, lastQuoteAt: null, openReturns: 0, openComplaints: 0, openServiceCases: 0, lastMailInAt: null }], addresses: [] }
    const model = peopleTabModel(reads({ usage: readyRead(usage) }), PEOPLE_TAB_START)
    expect(model.addresses.usageIn).toBe(true)
    expect(model.people.all.find((row) => row.contact?.id === MODA.contacts[0]!.id)?.usage?.openQuotes).toBe(2)
    expect(peopleTabModel(reads({ usage: failedRead('problem.read.unavailable') }), PEOPLE_TAB_START).addresses.usageIn).toBe(false)
  })

  it('without the portal right: no portal column, no portal act, the People answer says it once', () => {
    const model = peopleTabModel(reads({ can: peopleCan(['parties.view', 'parties.manage']), portal: null }), PEOPLE_TAB_START)
    expect(model.people.portalColumn).toBe(false)
    expect(model.people.invite.shown).toBe(false)
    expect(sentence(model.people.answer, 'en')).toContain('portal access is not shown for your role')
  })

  it('a chip filters its section to exactly its rows; "Show all" counts the list without it', () => {
    const model = peopleTabModel(reads(), { ...PEOPLE_TAB_START, filter: 'noInvoices' })
    expect(model.people.rows.map((row) => row.contact?.name)).toEqual(['Bruno Esempio'])
    expect(model.people.unfiltered).toBe(2)
  })

  it('the portal container is ONE hook moved out of PortalAccess.tsx (the body as is); the requests read only where they are drawn', () => {
    const portal = readFileSync(new URL('../../portal/PortalAccess.tsx', import.meta.url), 'utf8')
    // F-CA-229 (W2.5): the e-mail tags (contactEmails, onPeople) went with People's two cards.
    expect(portal).toContain('export function usePortalAccess({ side, party, parts, enabled }: PortalAccessInput): { model: PortalAccessModel; actions: PortalAccessActions } {')
    expect(portal).toContain('const { model, actions } = usePortalAccess({ side, party, parts })')
    expect(portal).toContain('<PortalAccessView parts={parts} model={model} actions={actions} />')
    expect(portal).not.toMatch(/contactEmails|onPeople/)
    expect(portal).toContain("const drawsRequests = (parts ?? PORTAL_PARTS).includes('requests')")
    expect(portal).toContain('if (!can.view || !on || !drawsRequests) return')
    const tab = readFileSync(new URL('./use-people-tab.ts', import.meta.url), 'utf8')
    expect(tab).toContain("parts: ['people'], enabled: on && can.portal })")
    expect(tab).not.toMatch(/listRequests|getPortalAccess\(/)
  })

  it('the personal-data windows are ONE export; the card draws them as before', () => {
    const card = readFileSync(new URL('../../depth/view/PrivacyCard.tsx', import.meta.url), 'utf8')
    expect(card).toContain('export function PrivacyWindows({ model, actions }: { model: PrivacyModel; actions?: PrivacyActions | undefined })')
    expect(card).toContain('<PrivacyWindows model={model} actions={actions} />')
  })

  it('every write names the version it read and carries an Idempotency-Key; a 409 reads the party again', () => {
    const tab = readFileSync(new URL('./use-people-tab.ts', import.meta.url), 'utf8')
    expect(tab).toContain('approveDeliveryAddress(api, row.id, { version: row.address.version }, newIdempotencyKey())')
    expect(tab).toContain('refuseDeliveryAddress(api, row.id, { version: row.version, reason }, key)')
    expect(tab).toContain("if (conflict) reload()")
  })
})

// ---- W1.3: the views (a part owns its stylesheet; views fetch nothing; no AG grid on the tab)
describe('the views of the tab', () => {
  const folder = new URL('../view/people/', import.meta.url)
  const views = readdirSync(folder).filter((name) => /\.tsx?$/.test(name)).map((name) => ({ name, source: readFileSync(new URL(name, folder), 'utf8') }))

  it('people.css restyles no kit, party or shared class (only its own fw-ca-* classes, tokens only)', () => {
    const css = readFileSync(new URL('people.css', folder), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).not.toMatch(/\.fw-(pt|pty|om|co|cm|cdp|pa)[-\s{.,:]/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/@media/)
  })

  it('a view fetches nothing (no API client, no session, no fetching hook) and the tab has no AG grid', () => {
    expect(views.length).toBeGreaterThanOrEqual(7)
    for (const { name, source } of views) {
      expect(source, name).not.toMatch(/lib\/api\/|lib\/session\/|use-people-tab|usePortalAccess|fetch\(/)
      expect(source, name).not.toMatch(/@nexus\/ui\/grid|ListFrame|ag-grid/)
    }
  })

  it('the tab is the kit used in place: its root, its words, its sections by their addresses', () => {
    const tab = views.find((view) => view.name === 'PeopleTab.tsx')!.source
    expect(tab).toContain('<div className="fw-pt fw-ca">')
    expect(tab).toContain('<WithMessages namespaces={PEOPLE_TAB_NAMESPACES}>')
    expect([...PEOPLE_TAB_NAMESPACES]).toEqual(['orders', CP, 'parties', 'portal-access', 'sales-customers-depth', 'sales-mtm'])
    expect(views.find((view) => view.name === 'PeopleSection.tsx')!.source).toContain("id: peopleKitId('people')")
    expect(views.find((view) => view.name === 'AddressesSection.tsx')!.source).toContain("id: peopleKitId('addresses')")
  })

  it('the golden flow\'s words stay: the heads say "Add contact" and "Add address" (the shared catalogue\'s own)', () => {
    expect(views.find((view) => view.name === 'PeopleSection.tsx')!.source).toContain("say(said('parties:contact.add'))")
    expect(views.find((view) => view.name === 'AddressesSection.tsx')!.source).toContain("'parties:address.add'")
    expect(views.find((view) => view.name === 'AddressesSection.tsx')!.source).toContain("'parties:address.addRegistered'") // Z22: the picture's word when none
    expect(CATALOGUE.en.parties!['address.addRegistered']).toBe('Add the registered office')
    expect(CATALOGUE.en.parties!['contact.add']).toBe('Add contact')
    expect(CATALOGUE.en.parties!['address.add']).toBe('Add address')
  })
})

// ---- W1.4: the page (CR, CRV, the shared notice area, the Home row; D2: People docks a third)
/** A gallery case drawn as the design index draws it (the shell's words; the screen loads its own). */
function render(screen: DesignScreen<unknown>, model: unknown, locale: Locale): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('the page mounts the tab (W1.4)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('the record builds the container on every tab (it reads only on People) and the view only on ?tab=people', () => {
    const container = source('../CustomerRecord.tsx')
    expect(container).toContain("retryPrivacy: privacy.state.onRetry, enabled: tab === 'people' })") // F-CA-204 / F-CA-224: no glance; the privacy windows' acts
    expect(container).toContain("named && record.party && tab === 'people' ? (")
    expect(container).not.toMatch(/parts=\{\['people'\]\}|portalEmails|contactEmails/)
  })

  it('the view: People\'s count = the addresses waiting for our check, marked; its notices in the ONE notice area; a third of the dock', () => {
    const view = source('../view/CustomerRecordView.tsx')
    expect(view).toContain("{tab === 'people' && peopleTab}")
    expect(view).toContain("count: id === 'people' ? (peopleBadge?.count ?? undefined)")
    expect(view).toContain("<PartyNotices model={model} party={party} actions={actions}>{tab === 'people' ? peopleNotice : null}</PartyNotices>")
    expect(view).toContain("tab === 'money' || tab === 'people' ? 'third' : undefined")
    expect(view).not.toMatch(/ContactsCard|AddressesCard|activeContacts/)
    // KEEP (the Money lane's ask): the Money count and its props stay as they are.
    expect(view).toContain("id === 'money' ? moneyCount : undefined")
    expect(view).toContain('moneyTab={moneyTab /* F-CM-104 */} moneyTabNote={moneyTabNote /* F-CM-104 */}')
    expect(source('../../../../parties/_shared/view/cards.tsx')).toContain('{children /* F-CA-116 */}')
  })

  it('the depth provider hands its ONE privacy read; the hold connector stays (the Money lane\'s KEEP)', () => {
    const depth = source('../../depth/CustomerDepth.tsx')
    expect(depth).toContain("export function useCustomerPrivacy(reload?: () => void): { readonly state: CustomerDepthState['privacy']; readonly can: CustomerDepthState['can']") // F-CA-223
    expect(depth).toContain('export function useCustomerHold(party: Party)')
  })

  it('the web reads the usage answer with its OWN schema of the server\'s fixed shape (D3)', () => {
    expect(Object.keys(partyUsageSchema.shape)).toEqual(Object.keys(partyUsageAnswer.shape))
    expect(Object.keys(partyUsageSchema.shape.contacts.element.shape)).toEqual(Object.keys(partyUsageAnswer.shape.contacts.element.shape))
    expect(Object.keys(partyUsageSchema.shape.addresses.element.shape)).toEqual(Object.keys(partyUsageAnswer.shape.addresses.element.shape))
  })

  it('every gallery case on People draws the new tab — its answer line and its two sections — with today\'s cards under it', () => {
    for (const locale of LOCALES)
      for (const item of customerRecordScreen.cases.filter((entry) => (entry.model as { tab?: string; party?: unknown }).tab === 'people' && (entry.model as { party?: unknown }).party)) {
        const html = render(customerRecordScreen as DesignScreen<unknown>, item.model, locale)
        expect(html, item.id).toContain('id="answer"')
        expect(html, item.id).toContain('id="people"')
        expect(html, item.id).toContain('id="addresses"')
      }
    const privacy = render(customerRecordScreen as DesignScreen<unknown>, customerRecordScreen.cases.find((entry) => entry.id === 'w2b-324-privacy')!.model, 'en')
    expect(privacy).toContain('id="people"')
    // F-CA-226 (W2.4): the personal-data card left the tab — its section draws the exceptions (here: no lawful basis) after Addresses.
    expect(privacy.indexOf('id="addresses"')).toBeLessThan(privacy.indexOf('id="personal-data"'))
    expect(privacy.slice(privacy.indexOf('id="personal-data"'))).toContain('Lawful basis missing')
    expect(privacy).not.toContain('Personal-data actions for')
  })
})

// ---- ca-w2 W2.1: Riders & measurements, pure (both kinds of rider; no measurement without its right; a rider's own page and its team)
describe('Riders & measurements (W2.1)', () => {
  const profile = (n: number, over: Partial<ProfileRow>): ProfileRow => ({ ...MTM_ROWS[0]!, id: `pr-${n}`, partyId: MODA.id, nextFittingAt: null, openUnits: 0, old: false, ...over })
  const kept = contact(7, 'Davide Conti', 'davide@example.com', ['RIDER'])
  const waiting = contact(8, 'Lia Gori', null, ['RIDER'])
  const PROFILES = [
    profile(1, { contactId: kept.id, riderName: 'Davide Conti', garmentType: 'SUIT', review: { status: 'WAITING', at: null }, nextFittingAt: '2026-11-27T09:00:00.000Z' }),
    profile(2, { contactId: kept.id, riderName: 'Davide Conti', garmentType: 'JACKET', review: { status: 'CONFIRMED', at: NOW }, old: true }),
    profile(3, { contactId: null, riderName: ' Sara Neri ', garmentType: 'SUIT', review: { status: 'NEED_MORE', at: NOW } }),
  ]
  const RIDERS: RidersView = { partyId: MODA.id, code: MODA.code, kind: 'ORGANISATION', team: null, riders: [{ id: 'r1', code: 'CUS-0191', legalName: 'Marco Valli', tradeName: null, status: 'ACTIVE', country: 'IT', language: 'it', measurementProfiles: 2, version: 3, updatedAt: NOW }], version: MODA.version }

  it('both kinds: kept here (a Rider contact, a name on the profiles, a Rider contact not measured yet), then those with their own page', () => {
    const rows = riderRows({ kind: 'ORGANISATION', partyId: MODA.id, partyName: 'Moda Demo', contacts: [kept, waiting], profiles: PROFILES, riders: RIDERS })
    expect(rows.map((row) => [row.kind, row.name, row.profiles.length])).toEqual([
      ['here', 'Davide Conti', 2],
      ['here', 'Lia Gori', 0],
      ['here', 'Sara Neri', 1],
      ['own', 'Marco Valli', 0],
    ])
    const answer = ridersAnswer({ kind: 'ORGANISATION', rows, measurements: true, matching: 3 })
    expect(sentence(answer, 'en')).toBe('4 riders (3 kept here, 1 with their own page) · 3 profiles kept here: 1 waiting for review, 1 need more, 1 to re-measure · next fitting 27/11/2026, Davide Conti')
    expect(sentence(answer, 'it')).toBe('4 piloti (3 tenuti qui, 1 con una pagina propria) · 3 profili tenuti qui: 1 in attesa di controllo, 1 da completare, 1 da rimisurare · prossima prova 27/11/2026, Davide Conti')
  })

  it('without the measurements right: no profile, no review, no size — the riders\' names only, said ONCE; no measurement act', () => {
    const model = peopleTabModel({ party: { ...MODA, contacts: [...MODA.contacts, kept] }, prefix: '/w/DEMO', can: peopleCan(['parties.view', 'parties.manage', 'orders.view']), now: NOW, portal: null, privacy: null, usage: null, approverId: null, profiles: readyRead({ rows: PROFILES, matching: 3 } as unknown as ProfilesView), riders: readyRead(RIDERS) }, PEOPLE_TAB_START)
    expect(model.riders.all.every((row) => row.profiles.length === 0)).toBe(true)
    expect(model.riders.head.newShown || model.riders.head.linkShown).toBe(false)
    const words = sentence(model.riders.answer, 'en')
    expect(words).toContain('profiles are not shown: your role does not see measurement profiles')
    expect(words).not.toMatch(/review|re-measure|fitting/)
    for (const row of model.riders.all) expect(riderMenu(row, model.riders.menu).map((item) => item.id).filter((id) => /^(link|review|fitting|newFor)/.test(id))).toEqual([])
  })

  it('a rider\'s own page (a person customer) shows its team, and its own profiles as ONE row', () => {
    const rider = { ...MODA, id: 'p-rider', kind: 'PERSON' as const, tradeName: null, legalName: 'Marco Valli', contacts: [], addresses: [] }
    const team: RidersView = { ...RIDERS, partyId: rider.id, kind: 'PERSON', team: { id: MODA.id, code: MODA.code, legalName: 'Moda Demo S.r.l.', status: 'ACTIVE' }, riders: [] }
    const model = peopleTabModel({ party: rider, prefix: '/w/DEMO', can: ALL_MEASURED, now: NOW, portal: null, privacy: null, usage: null, approverId: null, profiles: readyRead({ rows: [profile(4, { partyId: rider.id })], matching: 1 } as unknown as ProfilesView), riders: readyRead(team) }, PEOPLE_TAB_START)
    expect(model.riders.team?.name).toBe('Moda Demo S.r.l.')
    expect(model.riders.all.map((row) => row.kind)).toEqual(['self'])
    expect(sentence(model.answer.words, 'en')).toContain('rider of Moda Demo S.r.l.')
    expect(model.riders.head.changeTeam).toBe(true)
    expect(model.riders.head.addRider).toBe(false)
  })

  it('a link needs a profile first (held by STATE); New measurements need an active customer; acts hidden without their right', () => {
    const none = peopleTabModel({ party: MODA, prefix: '/w/DEMO', can: ALL_MEASURED, now: NOW, portal: null, privacy: null, usage: null, approverId: null, profiles: readyRead({ rows: [], matching: 0 } as unknown as ProfilesView), riders: readyRead(RIDERS) }, PEOPLE_TAB_START)
    expect(say('en')(none.riders.head.linkHeld!)).toBe('A link needs a profile first: record the first measurements.')
    const prospect = peopleTabModel({ party: { ...MODA, status: 'PROSPECT' }, prefix: '/w/DEMO', can: ALL_MEASURED, now: NOW, portal: null, privacy: null, usage: null, approverId: null, profiles: readyRead({ rows: PROFILES, matching: 3 } as unknown as ProfilesView), riders: readyRead(RIDERS) }, PEOPLE_TAB_START)
    expect(say('en')(prospect.riders.head.newHeld!)).toBe('New measurements need an active customer: activate it first.')
    const own = riderRows({ kind: 'ORGANISATION', partyId: MODA.id, partyName: 'Moda Demo', contacts: [], profiles: [], riders: RIDERS })[0]!
    expect(riderMenu(own, { can: READ_ONLY, prefix: '/w/DEMO', status: 'ACTIVE' }).map((item) => item.id)).toEqual(['open', 'sep-1', 'copyLink'])
    expect(riderMenu(own, { can: ALL_MEASURED, prefix: '/w/DEMO', status: 'ACTIVE' }).map((item) => item.id)).toContain('team')
  })

  it('the container reads the profiles only with the measurements right, the riders for every reader of the customer; live by event', () => {
    const tab = readFileSync(new URL('./use-people-tab.ts', import.meta.url), 'utf8')
    expect(tab).toContain('if (!on || !can.measurements) return')
    expect(tab).toContain('listProfiles(api, { partyId })')
    expect(tab).toContain('readRiders(api, partyId)')
    expect(tab).toContain("change.type === 'party.team_changed'")
    expect(tab).toContain('timers[what] = setTimeout(() => void run(), 400)')
  })
})

// ---- ca-w2 W2.2: the Riders view and Made-to-measure's windows in place
describe('Riders & measurements on the tab, Made-to-measure\'s windows in place (W2.2)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('New measurements takes an additive preset: absent, the window opens exactly as on Made-to-measure\'s page', () => {
    const hook = source('../../../mtm/use-measurements.ts')
    expect(hook).toContain('const openNew = useCallback((preset?: MeasurementsPreset) => {')
    expect(hook).toContain("customerQ: preset?.customerQ ?? '', // F-CA-206: absent = '' (as before)")
    expect(hook).toContain("partyId: preset?.partyId ?? '',")
    expect(hook).toContain("riderName: preset?.riderName ?? '',")
    // Without a preset the contacts' read still picks the first Rider contact (today's rule).
    expect(hook).toContain("asked?.riderName ? undefined : items.find((contact) => contact.roles.includes('RIDER'))")
    expect(source('../../../mtm/MtmPage.tsx')).toContain('measurements.openNew()')
  })

  it('the tab mounts Made-to-measure\'s own windows unchanged; New measurements starts with THIS customer', () => {
    const tab = source('../view/people/PeopleTab.tsx')
    expect(tab).toContain('<MeasurementsDialog model={mtm.measurements} actions={mtm.measurementsActions} />')
    expect(tab).toContain('<LinkDialog model={mtm.link} can={mtm.can} actions={mtm.linkActions} />')
    const container = source('./use-people-tab.ts')
    expect(container).toContain('onNewMeasurements: () => measurements.openNew({ partyId, customerQ }),')
    expect(container).toContain("if (act === 'newFor') measurements.openNew({ partyId, customerQ, contactId: row.contact?.id ?? null, riderName: row.contact ? null : row.name })")
  })

  it('Review, New revision and Book a fitting are exact doors to the profile; a rider\'s orders by its profile', () => {
    const own = riderRows({ kind: 'PERSON', partyId: 'p-r', partyName: 'Marco Valli', contacts: [], profiles: [{ ...MTM_ROWS[0]!, id: 'pr-9' }], riders: null })[0]!
    const hrefs = riderMenu(own, { can: peopleCan(['parties.view', 'orders.view', 'sales.measurements.view', 'sales.mtm.review', 'sales.fittings.manage']), prefix: '/w/DEMO', status: 'ACTIVE' }).flatMap((item) => (item.href ? [item.href] : []))
    expect(hrefs).toEqual(['/w/DEMO/sales/made-to-measure/pr-9?do=review', '/w/DEMO/sales/made-to-measure/pr-9?do=fitting', '/w/DEMO/sales/orders?profile=pr-9'])
  })

  it('a profile line says its record, size, day and state — never a measurement value', () => {
    const view = source('../view/people/RidersSection.tsx')
    expect(view).not.toMatch(/profile\.(measurements|measuredPlace|takenBy)|fitNotes/)
    expect(view).toContain("'sales-mtm:list.new'")
    expect(view).toContain("'sales-mtm:list.sendLink'")
  })
})

// ---- ca-w2 W2.3: Add rider… and Change team…
describe('Add rider… and Change team… (W2.3)', () => {
  const RIDERS: RidersView = { partyId: MODA.id, code: MODA.code, kind: 'ORGANISATION', team: null, riders: [], version: MODA.version }
  const reads = (can = ALL_MEASURED) => ({ party: MODA, prefix: '/w/DEMO', can, now: NOW, portal: null, privacy: null, usage: null, approverId: null, profiles: null, riders: readyRead(RIDERS) })
  const blank: AddRiderDialog = { kind: 'own', name: '', email: '', phone: '', language: 'it', search: '', found: null, picked: null, tried: false, busy: false, problem: null, made: null }

  it('Add rider is offered only with parties.manage, on an organisation (a rider\'s own page offers Change team instead)', () => {
    expect(peopleTabModel(reads(), PEOPLE_TAB_START).riders.head.addRider).toBe(true)
    expect(peopleTabModel(reads(peopleCan(['parties.view', 'sales.measurements.view'])), PEOPLE_TAB_START).riders.head.addRider).toBe(false)
    expect(peopleTabModel(reads(), PEOPLE_TAB_START).riders.head.changeTeam).toBe(false)
  })

  it('a new rider needs a name (and a real e-mail when one is given); a picked customer or a rider kept on the team needs nothing more', () => {
    expect(addRiderProblem(blank)).toBe('rider.problem.name')
    expect(addRiderProblem({ ...blank, name: 'Marco Valli', email: 'not-an-address' })).toBe('rider.problem.email')
    expect(addRiderProblem({ ...blank, name: 'Marco Valli', email: 'marco@example.com' })).toBeNull()
    expect(addRiderProblem({ ...blank, picked: { id: 'p9', code: 'CUS-0191', name: 'Marco Valli', city: null, version: 2 } })).toBeNull()
    expect(addRiderProblem({ ...blank, kind: 'kept' })).toBeNull()
    expect(teamProblem({ riderId: 'r1', riderName: 'Marco Valli', version: 3, current: null, choice: 'move', search: '', found: null, picked: null, tried: false, busy: false, problem: null })).toBe('team.problem.pick')
  })

  it('the half-failure: the rider was made, not yet under the team — said in words, and Try again sends only the team change', () => {
    expect(say('en')(said('rider.made', { params: { name: 'Marco Valli', team: 'Moda Demo' } }))).toBe('Marco Valli was made, not yet under Moda Demo: Try again.')
    expect(say('it')(said('rider.made', { params: { name: 'Marco Valli', team: 'Moda Demo' } }))).toBe('Marco Valli è stato creato, ma non è ancora sotto Moda Demo: riprova.')
    const container = readFileSync(new URL('./use-people-tab.ts', import.meta.url), 'utf8')
    // A made rider is kept by the window: the next try skips the create and sends only PUT /parties/:rider/team.
    expect(container).toContain('let rider = dialog.made ?? (dialog.picked ?')
    expect(container).toContain("patchAdd({ busy: false, problem: problemKey(error), ...(dialog.picked ? {} : { made: rider }) })")
    expect(container).toContain('await setRiderTeam(api, rider.id, { version: rider.version, teamPartyId: partyId }, teamKeyOf)')
    // The rider is a person customer of the team's own company (a rider rides for a team of its company).
    expect(container).toContain("{ companyId: party.companyId, code: suggestCode(name), kind: 'PERSON', legalName: name, roles: ['CUSTOMER']")
  })

  it('Change team sends the rider\'s version; taking it off sends null; a rider kept on the team opens the record\'s Add contact, Rider ticked', () => {
    const container = readFileSync(new URL('./use-people-tab.ts', import.meta.url), 'utf8')
    expect(container).toContain("teamPartyId: dialog.choice === 'off' ? null : dialog.picked!.id }, key)")
    expect(container).toContain("setPreset(blankContact(['RIDER']))")
    expect(readFileSync(new URL('../view/people/PeopleTab.tsx', import.meta.url), 'utf8')).toContain('<ChangeTeamDialog dialog={model.team} actions={actions} />')
  })
})

// ---- ca-w2 W2.4: Personal data, the personal-data acts on a person's ⋯ (Z14), the Archive windows (P14)
describe('Personal data, its acts on the person, the Archive windows (W2.4)', () => {
  const PRIVACY_CAN = peopleCan(['parties.view', 'parties.manage', 'parties.privacy', 'parties.erase', 'partners.view'])
  const anna = contact(1, 'Anna Demo', 'anna@example.com', ['ORDERS'])
  const bruno = contact(2, 'Bruno Esempio', 'bruno@example.com', ['ORDERS', 'INVOICES'])
  const context = (can = PRIVACY_CAN, archivedCustomer = false) => ({ can, access: null, archivedCustomer, prefix: '/w/DEMO' })

  it('the acts of today\'s table are on the person\'s ⋯ — each its own right (hidden without it), held only by state', () => {
    const [row] = peopleRows(input([anna], null, { privacy: [privacyOf(anna, { objectedAt: NOW })] }))
    const items = personMenu(row!, context())
    expect(items.filter((item) => ['basis', 'objection', 'copy', 'erase'].includes(item.id)).map((item) => [item.id, item.held ? say('en')(item.held) : null])).toEqual([
      ['basis', null],
      ['objection', 'An objection is already recorded for this person.'],
      ['copy', null],
      ['erase', null],
    ])
    expect(personMenu(row!, context(peopleCan(['parties.view', 'parties.manage']))).map((item) => item.id)).not.toContain('basis')
    expect(personMenu(row!, context(peopleCan(['parties.view', 'parties.privacy']))).map((item) => item.id)).not.toContain('erase')
    // R-B5: an erase while a login still uses the e-mail is held, pointing at this row's Deactivate.
    const [signedIn] = peopleRows(input([anna], [person('u1', 'Anna Demo', 'anna@example.com')]))
    expect(say('en')(personMenu(signedIn!, context()).find((item) => item.id === 'erase')!.held!)).toMatch(/end their portal access first/)
    expect(say('en')(personMenu(row!, context(PRIVACY_CAN, true)).find((item) => item.id === 'basis')!.held!)).toBe('The customer is archived: reactivate it first.')
  })

  it('the Personal data section: the summary in both languages and ONLY the people who need a look', () => {
    const rows = peopleRows(input([anna, bruno], null, { privacy: [privacyOf(anna), privacyOf(bruno, { lawfulBasis: null })] }))
    expect(sentence(privacySectionAnswer(rows), 'en')).toBe('Lawful basis recorded for 1 of 2 contacts · no objection · nothing erased')
    expect(sentence(privacySectionAnswer(rows), 'it')).toBe('Base giuridica registrata per 1 contatti su 2 · nessuna opposizione · nessuna cancellazione')
    expect(privacyExceptions(rows).map((entry) => [entry.row.contact?.name, entry.kind])).toEqual([['Bruno Esempio', 'basis']])
  })

  it('Archive {name}? says who gets its mails after (the mail rule run without it), its portal access, the open quotes that name it', () => {
    const facts = { contact: anna, contacts: [anna, bruno], customer: 'Moda Demo', portal: 'ACTIVE' as const, approver: true, usage: { contactId: anna.id, openQuotes: 2, lastQuoteAt: null, openReturns: 0, openComplaints: 0, openServiceCases: 0, lastMailInAt: null } }
    const words = contactArchiveWarnings(facts).map((warning) => [warning.tone, say('en')(warning.words)])
    expect(words).toEqual([
      ['warning', 'Gets quotes & confirmations now: after this, they go to Bruno Esempio (the next Orders contact with an e-mail).'],
      ['warning', 'Still signs in to the portal: archiving does not end that. Deactivate their portal access too, from this row.'],
      ['warning', 'The named production approver in the portal: name another one on Portal settings, or approvals wait for nobody.'],
      ['info', 'Named on 2 open quotes: they keep this contact; their confirmations then go to Bruno Esempio, never to an archived contact.'],
      ['info', "Their next e-mail to us is no longer matched to Moda Demo's threads."],
    ])
    const alone = contactArchiveWarnings({ ...facts, contact: bruno, contacts: [bruno], portal: null, approver: false, usage: null })
    expect(alone.map((warning) => warning.tone)).toEqual(['danger', 'danger', 'info'])
  })

  it('Archive "{address}"? says its defaults, what the e-invoices use after, the draft quotes and shipments that name it', () => {
    const office = address(1, { kinds: ['REGISTERED', 'BILL_TO'], isDefaultBillTo: true, isDefaultShipTo: false, city: 'Firenze' })
    const usage = { addressId: office.id, draftQuoteVersions: 1, preparedShipments: 2, openSampleShipments: 0, openPortalRequests: 0, openChangeRequests: 0 }
    expect(addressArchiveWarnings({ address: office, addresses: [office], usage }).map((warning) => warning.tone)).toEqual(['info', 'warning', 'danger', 'warning', 'info'])
    const second = address(2, { kinds: ['REGISTERED'], isDefaultBillTo: false, city: 'Milano' })
    expect(say('en')(addressArchiveWarnings({ address: office, addresses: [office, second], usage: null })[2]!.words)).toBe('E-invoices use this address: they will use the registered office in Milano.')
  })

  it('the old personal-data card left the tab in the same step: the acts open the depth provider\'s own windows from the ⋯', () => {
    const container = readFileSync(new URL('../CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(container).not.toMatch(/depth\?\.contacts|after=\{/)
    expect(container).toContain('openPrivacy: privacy.state.onOpen')
    expect(readFileSync(new URL('../view/people/PeopleTab.tsx', import.meta.url), 'utf8')).toContain('<PrivacyWindows model={privacy.model} actions={privacy.actions} />')
    expect(readFileSync(new URL('./use-people-tab.ts', import.meta.url), 'utf8')).toContain("input.openPrivacy?.(act, row.privacy)")
  })
})

// ---- ca-w2 W2.5: the old code out (each after a grep of its every use on main)
describe('the old People parts are out (W2.5)', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('People reads the contacts\' privacy only (its riders and profiles are its own reads); the glance stays the Overview\'s and Money\'s', () => {
    const depth = source('../../depth/use-depth.ts')
    expect(depth).toContain("else if (tab === 'people') void loadPrivacy()")
    expect(depth).not.toContain('loadPrivacy(), loadGlance()')
    expect(depth).toContain("else if (tab === 'money') void Promise.all([loadGlance(), loadHolds()])")
  })

  it('R-B7: an objection is recorded on the day the person objected (noon UTC of that day; never later than now)', () => {
    expect(objectionAt('2026-11-20', new Date('2026-11-24T09:00:00.000Z'))).toBe('2026-11-20T12:00:00.000Z')
    expect(objectionAt('2026-11-24', new Date('2026-11-24T09:00:00.000Z'))).toBe('2026-11-24T09:00:00.000Z')
    expect(objectionAt(undefined)).toBeNull()
    expect(source('../../depth/use-depth.ts')).toContain('at: objectionAt(dialog.day)')
  })

  it('the depth slot keeps only Terms & requirements\' parts; the hold connector stays (the Money lane\'s KEEP); the glance parts and the table went', () => {
    const slot = source('../../depth/CustomerDepth.tsx')
    expect(slot).not.toMatch(/NowPart|ContactsPart|GlanceNow|PrivacyCard\b/)
    expect(slot).toContain('export function useCustomerHold(party: Party)')
    expect(readdirSync(new URL('../../depth/view/', import.meta.url))).not.toContain('GlanceParts.tsx')
    expect(source('../../depth/view/PrivacyCard.tsx')).not.toContain('export function PrivacyCard(')
    expect(source('../../portal/view/PeopleCard.tsx')).not.toMatch(/contactEmails|isContact/)
  })
})
