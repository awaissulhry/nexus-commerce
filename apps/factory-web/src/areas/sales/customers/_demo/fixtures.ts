import { createElement, type ReactNode } from 'react'
import type { ImportJob, ImportRow, Importer } from '../../../admin/import/api'
import { blankDraft, emptyWizard } from '../../../admin/import/model'
import type { SheetImport } from '../../../products/styles/import/sheet-import'
import { EVERY_COMPANY } from '../../../products/styles/import/sheet-import'
import { LIST_ROWS } from '../../pricelists/_demo/fixtures'
import type { CommercialTerms, PaymentTermsRow } from '../terms/api'
import { termsAbilitiesOf, termsDraftOf, type TermsAbilities, type TermsDraft } from '../terms/model'
import { CommercialTermsCard, type CommercialTermsModel } from '../terms/view/CommercialTermsCard'
import { CustomersImportView, type CustomersImportModel } from '../import/view/CustomersImportView'

/**
 * Made-up data for the B-W2a-49 cases of SCR-032 (Import) and SCR-033 (Tax & terms › Commercial terms): "Demo",
 * "Esempio" names, invented codes, terms and amounts. Nothing here is a real customer, list or term. Design-only (a
 * fixtures file: only fixtures and tests import it); it exports no `designScreen`, so the design index skips it.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()

// ---- Customers › Import ----------------------------------------------------------------------------------------------

const IMPORTER: Importer = { key: 'parties.parties', label: 'Customers and suppliers', description: null, columns: [], keyColumns: ['code'], maxRows: 10000 }

/** The customers import at one step: the sheet, the dry run (changes and refused rows) or the result. */
export function demoCustomersImport(step: 'upload' | 'planned' | 'applied', rights: { run: boolean; apply: boolean } = { run: true, apply: true }): SheetImport {
  const draft = blankDraft('parties.parties', EVERY_COMPANY, 'it')
  const job: ImportJob = {
    id: uid('4901', 1),
    companyId: null,
    importerKey: 'parties.parties',
    importerLabel: 'Customers and suppliers',
    fileId: uid('4901', 11),
    fileName: 'clienti-demo.xlsx',
    fileStatus: 'AVAILABLE',
    sheetName: 'Clienti',
    encoding: 'utf-8',
    numberFormat: 'it',
    mapping: null,
    layout: {
      format: 'xlsx',
      sheet: 'Clienti',
      sheets: ['Clienti'],
      encoding: 'utf-8',
      delimiter: ';',
      headers: ['Codice', 'Ragione sociale', 'Ruoli', 'Paese', 'Partita IVA', 'Codice destinatario', 'Note interne'],
      columns: [
        { index: 0, header: 'Codice', column: 'code' },
        { index: 1, header: 'Ragione sociale', column: 'legalName' },
        { index: 2, header: 'Ruoli', column: 'roles' },
        { index: 3, header: 'Paese', column: 'country' },
        { index: 4, header: 'Partita IVA', column: 'vatNumber' },
        { index: 5, header: 'Codice destinatario', column: 'sdiRecipientCode' },
      ],
      ignored: [{ index: 6, header: 'Note interne', reason: 'Not a column of this import (ignored).' }],
    },
    status: step === 'applied' ? 'APPLIED' : 'PLANNED',
    mode: step === 'applied' ? 'APPLY' : 'DRY_RUN',
    rowCount: 6,
    createCount: 2,
    updateCount: 1,
    unchangedCount: 2,
    errorCount: 1,
    appliedCount: step === 'applied' ? 3 : 0,
    skippedCount: 0,
    issues: null,
    error: null,
    plannedAt: at(30, 9, 2),
    applyRequestedAt: step === 'applied' ? at(30, 9, 4) : null,
    appliedAt: step === 'applied' ? at(30, 9, 5) : null,
    cancelledAt: null,
    version: step === 'applied' ? 5 : 3,
    createdAt: at(30, 9, 1),
    updatedAt: at(30, 9, 5),
    createdById: null,
  }
  const changes: ImportRow[] = [
    { rowNumber: 2, action: 'CREATE', key: '["NUOVO-DEMO"]', recordId: null, errors: null, after: { legalName: 'Nuovo Demo S.r.l.', roles: 'cliente', country: 'IT', vatNumber: 'IT01111111111' }, outcome: null, note: null, appliedAt: null },
    { rowNumber: 3, action: 'UPDATE', key: '["MODA-DEMO"]', recordId: uid('6110', 1), errors: null, before: { sdiRecipientCode: null }, after: { sdiRecipientCode: 'DEMO000' }, outcome: null, note: null, appliedAt: null },
    { rowNumber: 5, action: 'CREATE', key: '["ESEMPIO-MOTO"]', recordId: null, errors: null, after: { legalName: 'Esempio Moto S.n.c.', roles: 'cliente; marchio', country: 'IT' }, outcome: null, note: null, appliedAt: null },
  ]
  const refused: ImportRow[] = [{ rowNumber: 6, action: 'ERROR', key: '["SENZA-RUOLO"]', recordId: null, errors: [{ column: 'roles', message: 'Roles is needed for a new party.' }], outcome: null, note: null, appliedAt: null }]
  const wizard = step === 'upload' ? emptyWizard({ ...draft, file: { name: job.fileName, size: 8192 } }) : { ...emptyWizard(draft, job), refused: { items: refused, problem: null }, changes: { items: step === 'planned' ? changes : [], problem: null } }
  return { wizard, importers: [IMPORTER], rights: { view: true, run: rights.run, apply: rights.apply, people: false }, companies: [{ id: EVERY_COMPANY, name: 'Every company' }, { id: '0190f0e2-1111-7000-8000-000000000001', name: 'Officina Demo S.r.l.' }] }
}

export function importButton(model: CustomersImportModel): ReactNode {
  return createElement(CustomersImportView, { model: { ...model, inline: false } })
}

/** The import wizard drawn in place (design cases: a dialog opens only in a browser). */
export function importInline(model: CustomersImportModel): ReactNode {
  return createElement(CustomersImportView, { model: { ...model, inline: true } })
}

// ---- Commercial terms ---------------------------------------------------------------------------------------------

export const PAYMENT_TERMS: PaymentTermsRow[] = [
  { id: uid('6120', 1), companyId: null, code: 'DEP30', name: 'Acconto 30% all’ordine, saldo a 30 gg d.f.f.m.', nameI18n: { en: '30% deposit with the order, balance 30 days end of month' }, method: 'MP05', deposit: { sharePct: '30', days: 0 }, summary: { it: '30 % all’ordine (subito), 70 % a 30 giorni fine mese dalla fattura, bonifico', en: '30 % with the order (at once), 70 % 30 days end of month from the invoice, bank transfer' }, status: 'ACTIVE', customers: 3, version: 1 },
  { id: uid('6120', 2), companyId: null, code: 'BB60', name: 'Bonifico 60 gg', nameI18n: { en: 'Bank transfer 60 days' }, method: 'MP05', deposit: null, summary: { it: '100 % a 60 giorni dalla fattura, bonifico', en: '100 % 60 days from the invoice, bank transfer' }, status: 'ACTIVE', customers: 5, version: 1 },
  { id: uid('6120', 3), companyId: null, code: 'CONSEGNA', name: 'Contanti alla consegna', nameI18n: null, method: 'MP01', deposit: null, summary: { it: '100 % alla consegna, contanti', en: '100 % on delivery, cash' }, status: 'ACTIVE', customers: 1, version: 1 },
]

export const TERMS: CommercialTerms = {
  partyId: uid('6110', 1),
  code: 'MODA-DEMO',
  companyId: null,
  currency: 'EUR',
  language: 'it',
  paymentTermsId: PAYMENT_TERMS[0]!.id,
  paymentTerms: { id: PAYMENT_TERMS[0]!.id, code: 'DEP30', name: PAYMENT_TERMS[0]!.name, companyId: null, status: 'ACTIVE', summary: PAYMENT_TERMS[0]!.summary, deposit: { sharePct: '30', days: 0 } },
  paymentTermsText: null,
  priceListId: LIST_ROWS[1]!.id,
  priceList: { id: LIST_ROWS[1]!.id, code: 'MODA-DEMO', name: 'Moda Demo S.r.l. — 2026', kind: 'CUSTOMER', currency: 'EUR', status: 'ACTIVE', companyId: LIST_ROWS[1]!.companyId },
  discountGroup: null,
  priceChain: [
    { id: LIST_ROWS[1]!.id, code: 'MODA-DEMO', name: 'Moda Demo S.r.l. — 2026', kind: 'CUSTOMER', currency: 'EUR', status: 'ACTIVE', companyId: LIST_ROWS[1]!.companyId },
    { id: LIST_ROWS[0]!.id, code: 'BASE-EUR', name: 'Listino base Demo 2026', kind: 'BASE', currency: 'EUR', status: 'ACTIVE', companyId: null },
  ],
  defaultDepositPct: null,
  invoiceTiming: 'MONTHLY',
  invoiceTypePreset: 'TD24',
  incoterm: 'DAP',
  preferredCarrierCode: 'BRT',
  minimumOrderAmount: 50000,
  version: 5,
}

/** A customer of a dealer group: priced from the group's list, so the group is its discount group. */
export const GROUP_TERMS: CommercialTerms = {
  ...TERMS,
  code: 'DEALER-ESEMPIO',
  paymentTermsId: PAYMENT_TERMS[1]!.id,
  paymentTerms: { id: PAYMENT_TERMS[1]!.id, code: 'BB60', name: PAYMENT_TERMS[1]!.name, companyId: null, status: 'ACTIVE', summary: PAYMENT_TERMS[1]!.summary, deposit: null },
  priceListId: LIST_ROWS[2]!.id,
  priceList: { id: LIST_ROWS[2]!.id, code: 'GRUPPO-DEALER', name: 'Gruppo rivenditori Esempio', kind: 'GROUP', currency: 'EUR', status: 'ACTIVE', companyId: LIST_ROWS[2]!.companyId },
  discountGroup: { id: LIST_ROWS[2]!.id, code: 'GRUPPO-DEALER', name: 'Gruppo rivenditori Esempio' },
  priceChain: [{ id: LIST_ROWS[2]!.id, code: 'GRUPPO-DEALER', name: 'Gruppo rivenditori Esempio', kind: 'GROUP', currency: 'EUR', status: 'ACTIVE', companyId: LIST_ROWS[2]!.companyId }],
  invoiceTiming: 'PER_SHIPMENT',
  invoiceTypePreset: 'TD01',
  incoterm: null,
  preferredCarrierCode: null,
  minimumOrderAmount: null,
}

/** A customer without any terms yet (the W1 typed text only). */
export const BLANK_TERMS: CommercialTerms = { ...TERMS, code: 'NUOVO-PROVA', paymentTermsId: null, paymentTerms: null, paymentTermsText: 'Bonifico 30 gg', priceListId: null, priceList: null, priceChain: [], invoiceTiming: 'PER_SHIPMENT', invoiceTypePreset: 'TD01', incoterm: null, preferredCarrierCode: null, minimumOrderAmount: null, defaultDepositPct: null }

const OWNER: TermsAbilities = { view: true, manage: true, terms: true, lists: true, listsManage: true, price: true }
export const TERMS_CAN = {
  owner: OWNER,
  sales: termsAbilitiesOf(['parties.view', 'parties.manage', 'paymentterms.view', 'pricelists.view', 'pricelists.manage', 'money.price']),
  finance: termsAbilitiesOf(['parties.view', 'paymentterms.view', 'pricelists.view', 'money.price']),
  noPrice: { ...OWNER, price: false },
  noLists: { ...OWNER, listsManage: false },
}

export function termsModel(over: Partial<CommercialTermsModel> = {}): CommercialTermsModel {
  return { prefix: '/w/DEMO', can: OWNER, terms: TERMS, problem: null, held: null, draft: null, library: null, lists: null, choicesProblem: null, busy: false, saveProblem: null, saved: false, ...over }
}

/** The card in edit mode with the choices read, and an edit of its own. */
export function editing(terms: CommercialTerms, change: Partial<TermsDraft> = {}, over: Partial<CommercialTermsModel> = {}): CommercialTermsModel {
  return termsModel({ terms, draft: { ...termsDraftOf(terms), ...change }, library: PAYMENT_TERMS, lists: LIST_ROWS, ...over })
}

export const termsCard = (model: CommercialTermsModel): ReactNode => createElement(CommercialTermsCard, { model })
