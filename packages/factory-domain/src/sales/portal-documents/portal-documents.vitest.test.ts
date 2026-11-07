import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES } from '../../auth/roles/templates'
import { certificateFor, certificateValidOn, receivedStateOf, type CertificateFacts } from './conformity'
import {
  fingerprintOf,
  groupOf,
  groupsFor,
  isNew,
  KIND_RULES,
  kindOfFile,
  kindOfInvoice,
  matchesSearch,
  maySee,
  PORTAL_DOCUMENT_KINDS,
  replacementsOf,
  titleOf,
  type SharedFileFacts,
} from './library'
import { PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY, PORTAL_CUSTOMER_DOCUMENTS_FINANCE, PORTAL_CUSTOMER_DOCUMENTS_PERMISSIONS, PORTAL_CUSTOMER_DOCUMENTS_VIEW } from './permissions'

const file = (facts: Partial<SharedFileFacts>): SharedFileFacts => ({ recordType: 'Shipment', fileKind: 'DOCUMENT', category: null, created: null, source: null, generatedKind: null, quoteAccepted: null, ...facts })

describe('who sees which documents (the plan: Quality certificates, Finance invoices)', () => {
  it('declares three partner permissions, given by role; the Admin holds them all, never the Designer or a supplier', () => {
    for (const name of PORTAL_CUSTOMER_DOCUMENTS_PERMISSIONS) expect(FACTORY_PERMISSIONS.get(name)?.partner).toBe(true)
    const holders = (permission: string) =>
      PARTNER_ROLE_TEMPLATES.filter((template) => template.permissions.includes(permission as never))
        .map((template) => template.key)
        .sort()
    expect(holders(PORTAL_CUSTOMER_DOCUMENTS_VIEW)).toEqual(['customer-admin', 'customer-buyer', 'customer-finance', 'customer-quality', 'customer-viewer'])
    expect(holders(PORTAL_CUSTOMER_DOCUMENTS_CONFORMITY)).toEqual(['customer-admin', 'customer-buyer', 'customer-quality', 'customer-viewer'])
    expect(holders(PORTAL_CUSTOMER_DOCUMENTS_FINANCE)).toEqual(['customer-admin', 'customer-finance'])
  })

  it('opens a group with its permission, and money documents only with the price grain', () => {
    const quality = { view: true, conformity: true, finance: false, price: false }
    const finance = { view: true, conformity: false, finance: true, price: true }
    const preview = { view: true, conformity: true, finance: true, price: false }
    expect(groupsFor(quality)).toEqual(['DELIVERY', 'CONFORMITY', 'OTHER'])
    expect(groupsFor(finance)).toEqual(['DELIVERY', 'FINANCE', 'ORDERS', 'OTHER'])
    // An office preview holds the reads but no money: no invoice, no order confirmation.
    expect(groupsFor(preview)).toEqual(['DELIVERY', 'CONFORMITY', 'OTHER'])
    expect(maySee({ view: false, conformity: false, finance: false, price: true }, 'DELIVERY')).toBe(false)
  })

  it('has words for every kind, and every kind a group', () => {
    for (const kind of PORTAL_DOCUMENT_KINDS) {
      expect(KIND_RULES[kind].words.it.length).toBeGreaterThan(0)
      expect(KIND_RULES[kind].words.en.length).toBeGreaterThan(0)
      expect(groupOf(kind)).toBeTruthy()
    }
  })
})

describe('what a shared file is', () => {
  it('names the shipment copies by what made them, the source first', () => {
    expect(kindOfFile(file({ source: { complianceKind: 'DECLARATION_OF_CONFORMITY', generatedKind: null } }))).toBe('DECLARATION_OF_CONFORMITY')
    expect(kindOfFile(file({ created: { action: 'shipping.attachDocument', details: { documentKind: 'USER_INFORMATION' } } }))).toBe('USER_INFORMATION')
    expect(kindOfFile(file({ created: { action: 'shipping.attachDocument', details: { documentKind: 'DDT' } } }))).toBe('DDT')
    expect(kindOfFile(file({ source: { complianceKind: null, generatedKind: 'INSPECTION_REPORT' } }))).toBe('INSPECTION_REPORT')
    expect(kindOfFile(file({ created: { action: 'quality.shareDocument', details: { documentType: 'CERTIFICATE_OF_CONFORMITY' } } }))).toBe('CERTIFICATE_OF_CONFORMITY')
    expect(kindOfFile(file({ recordType: 'Party', created: { action: 'receivables.statement', details: {} } }))).toBe('STATEMENT')
  })

  it("tells a quote from the order confirmation (its ACCEPTED version), and fiscal files carry prices", () => {
    expect(kindOfFile(file({ recordType: 'Quote', fileKind: 'FISCAL_ARCHIVE', quoteAccepted: true }))).toBe('ORDER_CONFIRMATION')
    expect(kindOfFile(file({ recordType: 'Quote', fileKind: 'FISCAL_ARCHIVE', quoteAccepted: false }))).toBe('QUOTE')
    expect(kindOfFile(file({ recordType: 'SalesOrder', fileKind: 'FISCAL_ARCHIVE' }))).toBe('FISCAL_DOCUMENT')
    expect(groupOf('FISCAL_DOCUMENT')).toBe('FINANCE')
  })

  it('reads the category, then the file kind; a photo, a body photo or the carrier invoice is never a document', () => {
    expect(kindOfFile(file({ category: 'POD' }))).toBe('PROOF_OF_DELIVERY')
    expect(kindOfFile(file({ category: 'TEST_REPORT' }))).toBe('TEST_REPORT')
    expect(kindOfFile(file({ fileKind: 'CERTIFICATE' }))).toBe('CERTIFICATE')
    expect(kindOfFile(file({ recordType: 'SalesOrder' }))).toBe('OTHER')
    expect(kindOfFile(file({ fileKind: 'PHOTO' }))).toBeNull()
    expect(kindOfFile(file({ category: 'BODY_PHOTO', fileKind: 'ATTACHMENT' }))).toBeNull()
    expect(kindOfFile(file({ category: 'CARRIER_INVOICE' }))).toBeNull()
  })

  it('names invoices by their FatturaPA type, and titles carry each part once', () => {
    expect([kindOfInvoice('TD01'), kindOfInvoice('TD24'), kindOfInvoice('TD02'), kindOfInvoice('TD04')]).toEqual(['INVOICE', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE'])
    expect(titleOf('DECLARATION_OF_CONFORMITY', ['JKT-01', null, 'JKT-01'])).toEqual({ it: 'Dichiarazione di conformità UE · JKT-01', en: 'EU declaration of conformity · JKT-01' })
    expect(fingerprintOf('3f9a1c2b0d4e5f60718293a4b5c6d7e8')).toBe('3f9a1c2b0d4e')
  })
})

describe('fixed versions (SAL-092)', () => {
  it('names the current version of each series; a lone document is current', () => {
    const replaced = replacementsOf([
      { id: 'a1', series: 'file:a', order: 1, superseded: true },
      { id: 'a2', series: 'file:a', order: 2, superseded: false },
      { id: 'q1', series: 'quote:q', order: 1, superseded: false },
      { id: 'q3', series: 'quote:q', order: 3, superseded: false },
      { id: 'q2', series: 'quote:q', order: 2, superseded: false },
      { id: 'x', series: null, order: 1, superseded: false },
    ])
    expect(Object.fromEntries(replaced)).toEqual({ a1: 'a2', a2: null, q1: 'q3', q2: 'q3', q3: null, x: null })
  })
})

describe('new since the last visit, until opened', () => {
  const now = new Date('2026-11-07T10:00:00Z')
  it('is new after the previous visit and until the person opens it; on a first visit, the last 30 days', () => {
    const lastVisitAt = new Date('2026-11-01T10:00:00Z')
    expect(isNew({ availableAt: new Date('2026-11-02T10:00:00Z'), lastVisitAt, opened: false, now })).toBe(true)
    expect(isNew({ availableAt: new Date('2026-11-02T10:00:00Z'), lastVisitAt, opened: true, now })).toBe(false)
    expect(isNew({ availableAt: new Date('2026-10-30T10:00:00Z'), lastVisitAt, opened: false, now })).toBe(false)
    expect(isNew({ availableAt: new Date('2026-10-20T10:00:00Z'), lastVisitAt: null, opened: false, now })).toBe(true)
    expect(isNew({ availableAt: new Date('2026-09-20T10:00:00Z'), lastVisitAt: null, opened: false, now })).toBe(false)
  })

  it('finds every word typed, case and accents aside', () => {
    expect(matchesSearch('conformita jkt', ['Dichiarazione di conformità UE · JKT-01'])).toBe(true)
    expect(matchesSearch('jkt 02', ['JKT-01'])).toBe(false)
    expect(matchesSearch('  ', ['anything'])).toBe(true)
  })
})

describe('the declaration and certificate valid on the shipping date (SAL-087)', () => {
  const cert = (id: string, facts: Partial<CertificateFacts>): CertificateFacts => ({
    id,
    number: `NB-${id}`,
    standard: 'EN 17092-4:2020',
    ppeClass: 'A',
    notifiedBodyName: 'Made-up body',
    notifiedBodyNumber: '0000',
    validFrom: '2025-01-01',
    validTo: '2029-12-31',
    status: 'VALID',
    statusChangedOn: null,
    ...facts,
  })

  it('is valid inside its dates; a suspension counts only from its day; a draft never', () => {
    expect(certificateValidOn(cert('a', {}), '2026-11-24')).toBe(true)
    expect(certificateValidOn(cert('a', { validTo: '2026-11-23' }), '2026-11-24')).toBe(false)
    expect(certificateValidOn(cert('a', { status: 'EXPIRED', validTo: '2026-11-30' }), '2026-11-24')).toBe(true)
    expect(certificateValidOn(cert('a', { status: 'SUSPENDED', statusChangedOn: '2026-12-01' }), '2026-11-24')).toBe(true)
    expect(certificateValidOn(cert('a', { status: 'WITHDRAWN', statusChangedOn: '2026-11-20' }), '2026-11-24')).toBe(false)
    expect(certificateValidOn(cert('a', { status: 'DRAFT' }), '2026-11-24')).toBe(false)
  })

  it('names the cited certificate when valid that day, else one covering the style, else the cited one', () => {
    const cited = cert('cited', { validTo: '2026-06-30' })
    const renewal = cert('renewal', { validFrom: '2026-07-01' })
    expect(certificateFor(cited, [cited, renewal], '2026-05-01')?.id).toBe('cited')
    expect(certificateFor(cited, [cited, renewal], '2026-11-24')?.id).toBe('renewal')
    expect(certificateFor(cited, [], '2026-11-24')?.id).toBe('cited')
    expect(certificateFor(null, [], '2026-11-24')).toBeNull()
  })

  it('is complete with the declaration, the leaflet and, for category II and III, a certificate valid that day', () => {
    expect(receivedStateOf({ ppe: true, certificateRequired: true, declaration: true, userInformation: true, certificateValid: true })).toBe('COMPLETE')
    expect(receivedStateOf({ ppe: true, certificateRequired: true, declaration: true, userInformation: true, certificateValid: false })).toBe('INCOMPLETE')
    expect(receivedStateOf({ ppe: true, certificateRequired: false, declaration: true, userInformation: true, certificateValid: false })).toBe('COMPLETE')
    expect(receivedStateOf({ ppe: true, certificateRequired: false, declaration: false, userInformation: true, certificateValid: false })).toBe('INCOMPLETE')
    expect(receivedStateOf({ ppe: false, certificateRequired: false, declaration: false, userInformation: false, certificateValid: false })).toBe('NOT_REQUIRED')
  })
})
