import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONTACT_MAILS, DELAY_NOTICE_MAX, mailsOfContacts, recipientsOfMails, type MailContact } from './contact-mails'

/**
 * The mail rule of People & addresses (lane ca-, Z9): each kind of mail by its sender's own rule, by name. The last test reads the
 * senders' source so a sender that changes its recipients changes this rule with it.
 */

const contact = (id: string, name: string, roles: readonly string[], over: Partial<MailContact> = {}): MailContact => ({ id, name, email: `${id}@example.com`, roles, status: 'ACTIVE', createdAt: '2026-01-01T00:00:00.000Z', ...over })
const ids = (rows: readonly MailContact[]) => rows.map((row) => row.id)

describe('mailsOfContacts — who gets which mail by default', () => {
  it('quotes and confirmations: the OLDEST active ORDERS contact with an e-mail (quotes.ts, orders-depth/confirmation.ts)', () => {
    const rows = [contact('b', 'Bea', ['ORDERS'], { createdAt: '2026-03-01T00:00:00.000Z' }), contact('a', 'Anna', ['ORDERS'], { createdAt: '2026-05-01T00:00:00.000Z' }), contact('c', 'Carla', ['ORDERS'], { createdAt: '2026-02-01T00:00:00.000Z', email: null })]
    expect(ids(recipientsOfMails(rows).QUOTES_AND_CONFIRMATIONS)).toEqual(['b'])
    expect(recipientsOfMails([contact('x', 'X', ['INVOICES'])]).QUOTES_AND_CONFIRMATIONS).toEqual([])
  })

  it('shipping notices: every active ORDERS contact with an e-mail, by name (shipping/notices, tracking-link/office.ts)', () => {
    const rows = [contact('z', 'Zeno', ['ORDERS']), contact('a', 'Anna', ['ORDERS', 'INVOICES']), contact('q', 'Quinto', ['QUALITY']), contact('o', 'Old', ['ORDERS'], { status: 'ARCHIVED' })]
    expect(ids(recipientsOfMails(rows).SHIPPING_NOTICES)).toEqual(['a', 'z'])
  })

  it('delay notices: up to 3 active ORDERS contacts with an e-mail, by name (planning/promise-keep/store.ts)', () => {
    const rows = ['d', 'c', 'b', 'a'].map((id) => contact(id, id.toUpperCase(), ['ORDERS']))
    expect(DELAY_NOTICE_MAX).toBe(3)
    expect(ids(recipientsOfMails(rows).DELAY_NOTICES)).toEqual(['a', 'b', 'c'])
  })

  it('deposit pages: the first active INVOICES contact by name, else the first ORDERS one (payments/deposit-link.ts)', () => {
    expect(ids(recipientsOfMails([contact('o', 'Olga', ['ORDERS']), contact('i2', 'Zoe', ['INVOICES']), contact('i1', 'Ivo', ['INVOICES'])]).DEPOSIT_PAGES)).toEqual(['i1'])
    expect(ids(recipientsOfMails([contact('o2', 'Pia', ['ORDERS']), contact('o1', 'Olga', ['ORDERS'])]).DEPOSIT_PAGES)).toEqual(['o1'])
    expect(recipientsOfMails([contact('d', 'Dora', ['DESIGN'])]).DEPOSIT_PAGES).toEqual([])
  })

  it('invoices and reminders: every active INVOICES contact with an e-mail (receivables/store.ts, invoicing/sdi/copy.ts)', () => {
    const rows = [contact('i2', 'Zoe', ['INVOICES']), contact('i1', 'Ivo', ['INVOICES']), contact('i3', 'Ugo', ['INVOICES'], { email: '  ' }), contact('o', 'Olga', ['ORDERS'])]
    expect(ids(recipientsOfMails(rows).INVOICES_AND_REMINDERS)).toEqual(['i1', 'i2'])
  })

  it('recall notices: the first QUALITY contact with an e-mail, else the first active one with an e-mail (compliance/recall)', () => {
    expect(ids(recipientsOfMails([contact('a', 'Anna', ['ORDERS']), contact('q', 'Quinto', ['QUALITY'])]).RECALLS)).toEqual(['q'])
    expect(ids(recipientsOfMails([contact('b', 'Bea', ['DESIGN']), contact('a', 'Anna', ['OWNER'])]).RECALLS)).toEqual(['a'])
    expect(recipientsOfMails([contact('n', 'Nadia', ['QUALITY'], { email: null })]).RECALLS).toEqual([])
  })

  it('a contact gets its mails in one order; an archived or erased one (no e-mail) gets nothing; every contact has an entry', () => {
    const rows = [contact('a', 'Anna', ['ORDERS', 'INVOICES', 'QUALITY']), contact('x', 'Xeno', ['ORDERS'], { status: 'ARCHIVED' }), contact('e', '', ['ORDERS'], { email: null })]
    const mails = mailsOfContacts(rows)
    expect(mails.get('a')).toEqual([...CONTACT_MAILS])
    expect(mails.get('x')).toEqual([])
    expect(mails.get('e')).toEqual([])
    expect([...mails.keys()]).toEqual(['a', 'x', 'e'])
  })

  it('each line names its sender, and the senders still choose as the rule says (their source, read)', () => {
    const rule = readFileSync(new URL('./contact-mails.ts', import.meta.url), 'utf8')
    for (const path of ['sales/quotes/quotes.ts', 'sales/orders-depth/confirmation.ts', 'shipping/tracking-link/office.ts', 'planning/promise-keep/store.ts', 'payments/deposit-link.ts', 'receivables/store.ts', 'invoicing/sdi/copy.ts', 'compliance/recall/distributors.ts']) expect(rule, path).toContain(path)
    const api = (path: string) => readFileSync(new URL(`../../../../apps/factory-api/src/modules/${path}`, import.meta.url), 'utf8')
    expect(api('sales/quotes/quotes.ts')).toContain("where: { partyId: party.row.id, status: 'ACTIVE', roles: { has: 'ORDERS' }, email: { not: null } }, select: { id: true }, orderBy: { createdAt: 'asc' } }")
    // The order confirmation's fallback (ca-s S.3 may reshape the line: the oldest ACTIVE ORDERS contact stays the rule).
    const confirmation = api('sales/orders-depth/confirmation.ts')
    expect(confirmation).toContain("roles: { has: 'ORDERS' }")
    expect(confirmation).toContain("orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]")
    expect(api('shipping/tracking-link/office.ts')).toContain("where: { partyId, status: 'ACTIVE', roles: { has: 'ORDERS' }, email: { not: null } }, select: { id: true, name: true, email: true, language: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }")
    expect(api('planning/promise-keep/store.ts')).toContain('take: 3,')
    expect(api('payments/deposit-link.ts')).toContain("for (const role of ['INVOICES', 'ORDERS'] as const)")
    expect(api('receivables/store.ts')).toContain("where: { partyId, status: 'ACTIVE', roles: { has: 'INVOICES' }, email: { not: null } }, orderBy: [{ name: 'asc' }, { id: 'asc' }]")
    expect(api('compliance/recall/distributors.ts')).toContain("own.find((contact) => contact.roles.includes('QUALITY') && fit(contact)) ?? own.find((contact) => fit(contact))")
  })
})
