import { describe, expect, it } from 'vitest'
import { composeDocument } from '../../documents/compose'
import type { CompanyLegal } from '../../documents/model'
import { answerProblem, linkQuoteState, type AnswerInput, type LinkQuoteFacts } from './acceptance'
import { acceptanceMail, quoteDocument, quoteMail, sizesText, type CustomerQuote } from './document'
import type { QuoteIssue } from './quotes'
import { acceptLinkDays, addressComplete, billToSnapshot, reviseProblem, sendChecks, shipToSnapshot, versionOfLink, type AddressFacts, type SendCheckFacts } from './send'
import { DEPOSIT_DUE_DAYS, defaultTermsVersion, quoteTerms, termsKindOf, type TermsInput } from './terms'

/**
 * Sending and accepting a quote (B-W1-24), pure. Every company, customer, number and amount is made up.
 */

const OFFICE: AddressFacts = { name: null, line1: 'Via Finta 1', line2: null, postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT', contactName: null, phone: null }
const WORKSHOP: AddressFacts = { name: 'Laboratorio', line1: 'Via Finta 9', line2: 'Capannone 2', postalCode: '20900', city: 'Monza', province: 'MB', country: 'IT', contactName: 'Mario Prova', phone: '+39 000 0000000' }

const facts = (over: Partial<SendCheckFacts> = {}): SendCheckFacts => ({
  issues: [],
  status: 'DRAFT',
  approvalNeeded: false,
  companyLegal: [],
  billTo: OFFICE,
  shipTo: WORKSHOP,
  identity: { taxMode: 'IT_B2B', sdiRecipientCode: 'FAKE001', pec: null },
  vatChanged: false,
  standingFirmOffer: null,
  termsText: null,
  termsVersion: null,
  depositAsked: true,
  bankDetailsKnown: true,
  ...over,
})
const issue = (code: QuoteIssue['code'], severity: QuoteIssue['severity']): QuoteIssue => ({ code, severity, path: code, message: code, lineId: null, size: null })

describe('send checks (the Send dialog: SAL-157, SAL-192)', () => {
  it('a complete draft with no rule broken is ready', () => {
    expect(sendChecks(facts())).toEqual({ ready: true, checks: [] })
  })

  it("B-W1-21's send blockers stop it, and the approval the rules need", () => {
    const result = sendChecks(facts({ issues: [issue('NO_CONTACT_EMAIL', 'BLOCKS_SEND'), issue('CERTIFICATE', 'WARNING')], approvalNeeded: true }))
    expect(result.ready).toBe(false)
    expect(result.checks.map((check) => [check.code, check.severity])).toEqual([
      ['NO_CONTACT_EMAIL', 'BLOCKS'],
      ['APPROVAL_NEEDED', 'BLOCKS'],
      ['CERTIFICATE', 'WARNING'],
    ])
    // Approved: the approval no longer stops it.
    expect(sendChecks(facts({ status: 'APPROVED', approvalNeeded: true })).ready).toBe(true)
  })

  it("the send's own checks: letterhead, addresses, SDI identity, VAT changed, a firm offer that stands, terms version", () => {
    const result = sendChecks(
      facts({
        companyLegal: [{ path: 'company/vatNumber', message: 'The company needs its VAT number (partita IVA).' }],
        billTo: { ...OFFICE, postalCode: ' ' },
        shipTo: { ...WORKSHOP, country: 'Italy' },
        identity: { taxMode: 'IT_B2B', sdiRecipientCode: null, pec: '' },
        vatChanged: true,
        standingFirmOffer: { revision: 1, validUntil: '2026-12-31' },
        termsText: 'Our terms.',
        termsVersion: null,
      }),
    )
    expect(result.ready).toBe(false)
    expect(result.checks.map((check) => check.code)).toEqual(['COMPANY_LEGAL', 'BILL_TO_INCOMPLETE', 'SHIP_TO_INCOMPLETE', 'SDI_IDENTITY', 'VAT_CHANGED', 'FIRM_OFFER_STANDS', 'TERMS_VERSION'])
    expect(result.checks[0]!.message).toContain('partita IVA')
    expect(result.checks[5]!.message).toBe('Version 1 is a firm offer until 2026-12-31 (c.c. art. 1329): it cannot be replaced before then.')
    // A PEC alone reaches an Italian business through SDI; a consumer needs neither.
    expect(sendChecks(facts({ identity: { taxMode: 'IT_B2B', sdiRecipientCode: null, pec: 'x@pec.example.com' } })).ready).toBe(true)
    expect(sendChecks(facts({ identity: { taxMode: 'IT_B2C', sdiRecipientCode: null, pec: null } })).ready).toBe(true)
  })

  it('a deposit without the company bank details is a warning, never a stop', () => {
    const result = sendChecks(facts({ bankDetailsKnown: false }))
    expect(result).toMatchObject({ ready: true, checks: [{ code: 'NO_BANK_DETAILS', severity: 'WARNING' }] })
    expect(sendChecks(facts({ bankDetailsKnown: false, depositAsked: false })).checks).toEqual([])
  })

  it('addresses: street, postal code, city and an ISO country', () => {
    expect(addressComplete(OFFICE)).toBe(true)
    expect(addressComplete({ ...OFFICE, city: '' })).toBe(false)
    expect(addressComplete({ ...OFFICE, country: 'it' })).toBe(false)
    expect(addressComplete(null)).toBe(false)
  })
})

describe('the frozen snapshots (QuoteVersion.billTo, shipTo)', () => {
  it('the buyer as sent: name, kind, identity in force, the VIES consultation, the invoice address; empty fields left out', () => {
    expect(
      billToSnapshot({
        legalName: ' Cliente Finto S.r.l. ',
        kind: 'ORGANISATION',
        identity: { country: 'DE', taxMode: 'EU_B2B', vatNumber: 'DE000000003', fiscalCode: null, sdiRecipientCode: null, pec: null },
        viesConsultationNumber: 'TESTVIES0000002',
        address: OFFICE,
      }),
    ).toEqual({
      legalName: 'Cliente Finto S.r.l.',
      kind: 'ORGANISATION',
      country: 'DE',
      taxMode: 'EU_B2B',
      vatNumber: 'DE000000003',
      viesConsultationNumber: 'TESTVIES0000002',
      address: { line1: 'Via Finta 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
    })
  })

  it('the delivery address as sent, with whom to ask for', () => {
    expect(shipToSnapshot(WORKSHOP)).toEqual({ name: 'Laboratorio', line1: 'Via Finta 9', line2: 'Capannone 2', postalCode: '20900', city: 'Monza', province: 'MB', country: 'IT', contactName: 'Mario Prova', phone: '+39 000 0000000' })
  })
})

describe('the accept link', () => {
  it('lives to the offer’s last day plus 14 days of grace, at most 90 days', () => {
    expect(acceptLinkDays('2026-10-29', '2026-11-28')).toBe(31 + 14)
    expect(acceptLinkDays('2026-10-29', '2026-10-29')).toBe(15)
    expect(acceptLinkDays('2026-10-29', '2027-06-30')).toBe(90)
  })

  it('belongs to the newest version sent at or before it was made', () => {
    const v1 = { revision: 1, sentAt: new Date('2026-10-01T10:00:00Z') }
    const v2 = { revision: 2, sentAt: new Date('2026-10-05T10:00:00Z') }
    const v3 = { revision: 3, sentAt: null }
    expect(versionOfLink([v1, v2, v3], new Date('2026-10-01T10:00:00Z'))).toBe(v1)
    expect(versionOfLink([v1, v2, v3], new Date('2026-10-04T00:00:00Z'))).toBe(v1)
    expect(versionOfLink([v1, v2, v3], new Date('2026-10-05T10:00:00Z'))).toBe(v2)
    expect(versionOfLink([v3], new Date('2026-10-05T10:00:00Z'))).toBeNull()
  })

  it('a new version is made from a sent or declined one only', () => {
    expect(reviseProblem('SENT')).toBeNull()
    expect(reviseProblem('DECLINED')).toBeNull()
    expect(reviseProblem('DRAFT')).toMatch(/change it as it is/)
    expect(reviseProblem('ACCEPTED')).toBe('The quote is accepted: it gets no new version.')
  })
})

describe('accept only the latest SENT version, open, as shown (A1 §2.5)', () => {
  const v2 = { id: 'v2', revision: 2, status: 'SENT' as const, validUntil: '2026-11-28', noWithdrawal: false }
  const open: LinkQuoteFacts = { quoteStatus: 'SENT', version: v2, sentRevisions: [2], currentRevision: 2, today: '2026-10-29' }
  const answer = (over: Partial<AnswerInput> = {}): AnswerInput => ({ ...open, action: 'accept', askedVersionId: 'v2', noWithdrawalAccepted: false, ...over })

  it('the latest SENT version of a SENT quote, before its last day, is OPEN', () => {
    expect(linkQuoteState(open)).toEqual({ state: 'OPEN', message: 'The offer stands until 2026-11-28.', canAnswer: true })
    expect(answerProblem(answer())).toBeNull()
    expect(linkQuoteState({ ...open, today: '2026-11-28' }).state).toBe('OPEN')
  })

  it('a version a newer one replaced is never answered', () => {
    const v1 = { ...v2, id: 'v1', revision: 1, status: 'SUPERSEDED' as const }
    expect(answerProblem(answer({ version: v1, askedVersionId: 'v1' }))).toMatchObject({ state: 'SUPERSEDED', message: expect.stringMatching(/^This is version 1: version 2 replaced it/) })
    // Still SENT but not the latest SENT one (never stored so; refused anyway).
    expect(answerProblem(answer({ version: { ...v1, status: 'SENT' }, askedVersionId: 'v1' }))?.state).toBe('SUPERSEDED')
  })

  it('a page that answers another version than its link’s is refused', () => {
    expect(answerProblem(answer({ askedVersionId: 'v1' }))).toMatchObject({ state: 'WRONG_VERSION', path: 'body/versionId' })
  })

  it('past its last day: EXPIRED, ask for a new one (no expiry job)', () => {
    expect(answerProblem(answer({ today: '2026-11-29' }))).toMatchObject({ state: 'EXPIRED', message: 'The offer ended on 2026-11-28. Ask for a new one.' })
  })

  it('while the office makes a new version, the sent one waits', () => {
    expect(answerProblem(answer({ quoteStatus: 'DRAFT', currentRevision: 3 }))).toMatchObject({ state: 'REVISING', message: expect.stringContaining('(version 3)') })
  })

  it('answered or withdrawn versions are final', () => {
    expect(answerProblem(answer({ version: { ...v2, status: 'ACCEPTED' } }))?.state).toBe('ACCEPTED')
    expect(answerProblem(answer({ version: { ...v2, status: 'DECLINED' } }))?.state).toBe('DECLINED')
    expect(answerProblem(answer({ quoteStatus: 'CANCELLED', version: { ...v2, status: 'CANCELLED' } }))?.state).toBe('CANCELLED')
  })

  it('a made-to-measure version for a consumer is accepted only with the no-withdrawal statement (art. 59(c))', () => {
    const mtm = { ...v2, noWithdrawal: true }
    expect(answerProblem(answer({ version: mtm }))).toMatchObject({ state: 'NO_WITHDRAWAL_STATEMENT', path: 'body/noWithdrawalAccepted' })
    expect(answerProblem(answer({ version: mtm, noWithdrawalAccepted: true }))).toBeNull()
    expect(answerProblem(answer({ version: mtm, action: 'decline' }))).toBeNull()
  })
})

const TERMS: TermsInput = {
  language: 'it',
  taxMode: 'IT_B2B',
  currency: 'EUR',
  validUntil: '2026-11-28',
  firmOffer: false,
  promiseDate: null,
  deposit: { pct: '30', kind: 'ACCONTO', amount: 228384 },
  noWithdrawal: false,
  termsText: null,
  termsVersion: null,
}

describe('terms by customer (SAL-194)', () => {
  it('a business: net prices, a revocable offer, the acconto, how to accept; the default set is the terms version', () => {
    const terms = quoteTerms(TERMS)
    expect(terms.kind).toBe('BUSINESS')
    expect(terms.termsVersion).toBe('default-business-1')
    expect(terms.clauses.map((clause) => clause.text)).toEqual([
      "Prezzi al netto dell'IVA.",
      'Offerta valida fino al 28/11/2026.',
      `Acconto all'accettazione: 30% del totale, € 2.283,84, da versare con bonifico bancario entro ${DEPOSIT_DUE_DAYS} giorni dall'accettazione.`,
      "Per accettare l'offerta apra il link personale ricevuto per e-mail e digiti nome e cognome, oppure ci restituisca una copia firmata.",
    ])
  })

  it('a consumer: VAT-inclusive prices, the delivery date, a caparra both ways, no withdrawal; a firm offer says so', () => {
    const terms = quoteTerms({ ...TERMS, language: 'en', taxMode: 'IT_B2C', firmOffer: true, promiseDate: '2026-12-18', deposit: { pct: '30', kind: 'CAPARRA', amount: 16470 }, noWithdrawal: true })
    expect(terms.clauses.map((clause) => clause.code)).toEqual(['PRICES', 'VALIDITY', 'DELIVERY', 'DEPOSIT', 'CAPARRA_BOTH_WAYS', 'NO_WITHDRAWAL', 'ACCEPTANCE'])
    expect(terms.clauses[1]!.text).toBe('Firm offer: we will not withdraw it before 28 Nov 2026 (Italian Civil Code, art. 1329).')
    expect(terms.clauses[3]!.text).toContain('€164.70')
    expect(terms.termsVersion).toBe('default-consumer-1')
  })

  it('an export says the duties are not included; the company’s own terms print with their version', () => {
    expect(termsKindOf('EXTRA_EU')).toBe('EXPORT')
    const terms = quoteTerms({ ...TERMS, taxMode: 'EXTRA_EU', deposit: null, termsText: 'Foro competente: Milano.', termsVersion: '2026-1' })
    expect(terms.termsVersion).toBe('2026-1')
    expect(terms.clauses.map((clause) => clause.code)).toEqual(['PRICES', 'VALIDITY', 'DUTIES', 'ACCEPTANCE', 'TERMS'])
    expect(terms.clauses.at(-1)!.text).toBe('Condizioni generali di vendita (versione 2026-1):\nForo competente: Milano.')
    expect(defaultTermsVersion('EXPORT')).toBe('default-export-1')
  })
})

const COMPANY: CompanyLegal = {
  legalName: 'Conceria Finta S.r.l.',
  address: { line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
  vatNumber: 'IT12345670009',
  fiscalCode: '12345670009',
  reaOffice: 'MI',
  reaNumber: '0000001',
  shareCapital: '10000.00',
  currency: 'EUR',
}

const QUOTE: CustomerQuote = {
  number: 'Q-2026-0001',
  revision: 2,
  date: '2026-10-29',
  language: 'it',
  currency: 'EUR',
  priceBasis: 'NET',
  taxMode: 'IT_B2B',
  customerRef: 'RFQ-0042',
  validUntil: '2026-11-28',
  firmOffer: false,
  promiseDate: null,
  paymentTerms: 'Acconto 30%, saldo alla consegna',
  billTo: { legalName: 'Cliente Finto S.r.l.', kind: 'ORGANISATION', country: 'IT', taxMode: 'IT_B2B', vatNumber: 'IT00000001016', address: { line1: 'Via Finta 1', postalCode: '20121', city: 'Milano', country: 'IT' } },
  shipTo: { line1: 'Via Finta 9', postalCode: '20900', city: 'Monza', country: 'IT' },
  contact: { name: 'Anna Finta', email: 'anna@example.com' },
  lines: [
    {
      seq: 10,
      code: 'JKT-01 BLK',
      description: 'Giacca finta — Nero',
      note: null,
      quantity: 8,
      unitPrice: '450',
      listUnitPrice: '500',
      discountPct: '10',
      netAmount: 360000,
      vatAmount: 79200,
      vatRatePct: '22.00',
      vatNature: null,
      sizes: [
        { size: '50', quantity: 2, unitPrice: null },
        { size: '52', quantity: 4, unitPrice: null },
        { size: '54', quantity: 2, unitPrice: null },
      ],
    },
  ],
  // 8 × 450 = 3600.00; VAT 22 % = 792.00; gross 4392.00.
  totals: { net: 360000, vat: [{ rate: '22.00', nature: null, taxable: 360000, vat: 79200 }], gross: 439200 },
  deposit: { pct: '30', kind: 'ACCONTO', amount: 131760 },
  noWithdrawal: false,
  terms: quoteTerms({ ...TERMS, deposit: { pct: '30', kind: 'ACCONTO', amount: 131760 } }),
}

describe('the quote document (SAL-192, GAP-008): one model for the PDF and the link page', () => {
  it('composes in the fixed QUOTE layout: number with its version, the size grid, totals that add up, the terms as notes', () => {
    const composed = composeDocument({ ...quoteDocument(QUOTE), company: COMPANY })
    expect(composed.identity).toEqual([
      { label: 'Numero', value: 'Q-2026-0001 v2' },
      { label: 'Data', value: '29/10/2026' },
    ])
    expect(composed.table.rows).toEqual([['JKT-01 BLK', 'Giacca finta — Nero — Taglie: 50×2 · 52×4 · 54×2', '8', 'pz', '450,00', '10%', '€ 3.600,00']])
    expect(composed.totals.map((row) => row.value)).toEqual(['€ 3.600,00', '€ 792,00', '€ 4.392,00'])
    expect(composed.notes?.value).toContain("Acconto all'accettazione: 30% del totale, € 1.317,60")
  })

  it('a consumer reads VAT-inclusive line amounts; a size price shows beside its size', () => {
    const consumer: CustomerQuote = {
      ...QUOTE,
      priceBasis: 'GROSS',
      taxMode: 'IT_B2C',
      lines: [{ ...QUOTE.lines[0]!, quantity: 1, unitPrice: '549', listUnitPrice: null, discountPct: null, netAmount: 45000, vatAmount: 9900, sizes: [{ size: '52', quantity: 1, unitPrice: null }] }],
      totals: { net: 45000, vat: [{ rate: '22.00', nature: null, taxable: 45000, vat: 9900 }], gross: 54900 },
    }
    expect(composeDocument({ ...quoteDocument(consumer), company: COMPANY }).table.rows[0]!.at(-1)).toBe('€ 549,00')
    expect(sizesText([{ size: '54', quantity: 2, unitPrice: '470' }], 'EUR', 'it')).toBe('54×2 (€ 470,00)')
  })
})

describe('the mail: the thread keeps it without the link', () => {
  it('the stored text never holds the link; the sent one does', () => {
    const mail = quoteMail({ language: 'it', number: 'Q-2026-0001 v2', validUntil: '2026-11-28', linkUntil: '2026-12-12', recipientName: 'Anna Finta', message: null, resend: false })
    const url = 'http://localhost:3200/l#token=secret-token'
    expect(mail.subject).toBe('Offerta Q-2026-0001 v2')
    expect(mail.stored).not.toContain('token')
    expect(mail.stored).toContain('valido fino al 12/12/2026')
    expect(mail.withLink(url).endsWith(`\n${url}`)).toBe(true)
    expect(mail.withLink(url).startsWith('Gentile Anna Finta,')).toBe(true)
    // The office's own words replace the greeting and the introduction.
    expect(quoteMail({ language: 'en', number: 'Q-1 v1', validUntil: '2026-11-28', linkUntil: '2026-12-12', recipientName: null, message: 'Hi Anna, as agreed.', resend: true }).stored.startsWith('Hi Anna, as agreed.\n\n')).toBe(true)
  })

  it('the acceptance is confirmed with the deposit instructions (art. 51)', () => {
    const mail = acceptanceMail({ language: 'en', number: 'Q-2026-0001 v2', acceptedAt: new Date('2026-10-29T14:30:00Z'), timeZone: 'Europe/Rome', signerName: 'Anna Finta', depositText: 'Pay it.' })
    expect(mail.subject).toBe('Acceptance of quotation Q-2026-0001 v2 confirmed')
    expect(mail.body).toBe('Dear Anna Finta,\n\nthank you: we received the acceptance of quotation Q-2026-0001 v2 on 29 Oct 2026, 15:30, in the name of Anna Finta. The accepted quotation and its terms are attached.\n\nPay it.')
  })
})
