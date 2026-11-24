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
import { peopleAnswer, peopleBadge, peopleSectionAnswer, personFilterOf, type PeopleFacts } from './answer'
import { CP, failedRead, PEOPLE_SECTIONS, PEOPLE_TAB_NAMESPACES, peopleCan, READING, readyRead, sayOf, type Said } from './model'
import type { PartyUsage } from './api'
import { PEOPLE_TAB_START, peopleTabModel, type PeopleTabReads } from './tab'
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
  const reads = (over: Partial<PeopleTabReads> = {}): PeopleTabReads => ({ party: MODA, prefix: '/w/DEMO', can: ALL, now: NOW, portal: portalModel, privacy: null, usage: null, approverId: null, glance: null, ...over })

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
    expect(portal).toContain('export function usePortalAccess({ side, party, parts, onPeople, enabled }: PortalAccessInput): { model: PortalAccessModel; actions: PortalAccessActions } {')
    expect(portal).toContain('const { model, actions } = usePortalAccess({ side, party, parts, onPeople })')
    expect(portal).toContain('<PortalAccessView parts={parts} contactEmails={contactEmails} model={model} actions={actions} />')
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
    expect([...PEOPLE_TAB_NAMESPACES]).toEqual(['orders', CP, 'parties', 'portal-access', 'sales-customers-depth'])
    expect(views.find((view) => view.name === 'PeopleSection.tsx')!.source).toContain("id: peopleKitId('people')")
    expect(views.find((view) => view.name === 'AddressesSection.tsx')!.source).toContain("id: peopleKitId('addresses')")
  })

  it('the golden flow\'s words stay: the heads say "Add contact" and "Add address" (the shared catalogue\'s own)', () => {
    expect(views.find((view) => view.name === 'PeopleSection.tsx')!.source).toContain("say(said('parties:contact.add'))")
    expect(views.find((view) => view.name === 'AddressesSection.tsx')!.source).toContain("'parties:address.add'")
    expect(CATALOGUE.en.parties!['contact.add']).toBe('Add contact')
    expect(CATALOGUE.en.parties!['address.add']).toBe('Add address')
  })
})
