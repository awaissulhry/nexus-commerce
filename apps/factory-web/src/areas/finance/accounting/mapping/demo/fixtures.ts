import { MAPPING_KEYS } from '@nexus/factory-domain/accounting/mapping/keys'
import { COMPANY } from '../../demo/fixtures'
import type { JournalsSettings, MappingAnswer, MappingKey, MappingKind, MappingRow } from '../api'

/**
 * Made-up account mapping for the design cases of SCR-480: the invented "Officina Demo S.r.l." on 30 October 2026, a
 * made-up chart (4001 sales of garments, 6101 leather bought, 6801 cost of goods sold …; never a real firm's chart), the
 * key words as Nexus posts them (factory-domain's own), people "Fiona Conti" and "Alex Demo". Leather moves to 6105 from 1
 * December; transport charged to customers, EU customers, the scrap variance and the tax withheld have no account; a row
 * for the key "22" (a rate typed before the tax codes) is kept apart: Nexus does not post it. Design-only.
 */

export const MAPPING_TODAY = '2026-10-30'
const uid = (n: number) => `0190f0e2-4263-7000-8000-${String(n).padStart(12, '0')}`
const FIONA = { id: '0190f0e2-3333-7000-8000-000000000007', name: 'Fiona Conti' }
const ALEX = { id: '0190f0e2-3333-7000-8000-000000000001', name: 'Alex Demo' }

let next = 1
const row = (kind: MappingKind, key: string, accountCode: string, validFrom: string, over: Partial<MappingRow> = {}): MappingRow => ({
  id: uid(next++),
  kind,
  key,
  accountCode,
  validFrom,
  note: null,
  fixed: validFrom <= MAPPING_TODAY,
  createdAt: `${validFrom < MAPPING_TODAY ? validFrom : '2026-10-28'}T09:30:00.000Z`,
  createdBy: FIONA,
  version: 1,
  ...over,
})

/** The company's own tax codes (made up): the API says them by their label. */
const TAX_CODE_WORDS: Readonly<Record<string, { en: string; it: string }>> = {
  V22: { en: 'Output VAT: 22% standard rate', it: 'IVA a debito: 22% ordinaria' },
  'N3.2': { en: 'Output VAT: N3.2 supply within the EU', it: 'IVA a debito: N3.2 cessione intracomunitaria' },
}
const words = (kind: MappingKind, key: string) => MAPPING_KEYS[kind][key] ?? TAX_CODE_WORDS[key] ?? null

const key = (kind: MappingKind, code: string, rows: { current?: MappingRow; upcoming?: MappingRow[]; earlier?: MappingRow[] } = {}, posted = true): MappingKey => ({
  kind,
  key: code,
  words: posted ? words(kind, code) : null,
  posted,
  current: rows.current ?? null,
  upcoming: rows.upcoming ?? [],
  earlier: rows.earlier ?? [],
})

const Y = '2026-01-01'

export const LEATHER: MappingKey = key('ITEM_GROUP', 'LEATHER', {
  current: row('ITEM_GROUP', 'LEATHER', '6101', '2026-04-01', { note: 'Conto unico pelli dal secondo trimestre.', createdBy: ALEX }),
  upcoming: [row('ITEM_GROUP', 'LEATHER', '6105', '2026-12-01', { note: 'Nuovo sottoconto chiesto dallo studio.' })],
  earlier: [row('ITEM_GROUP', 'LEATHER', '6100', Y, { createdBy: ALEX })],
})
export const SALES_FREIGHT: MappingKey = key('ITEM_GROUP', 'SALES_FREIGHT')
export const OLD_RATE: MappingKey = key('TAX_CODE', '22', { current: row('TAX_CODE', '22', '2201', Y, { createdBy: ALEX }) }, false)

export const MAPPING_KEYS_DEMO: MappingKey[] = [
  key('ITEM_GROUP', 'SALES_GARMENTS', { current: row('ITEM_GROUP', 'SALES_GARMENTS', '4001', Y) }),
  key('ITEM_GROUP', 'SALES_SERVICES', { current: row('ITEM_GROUP', 'SALES_SERVICES', '4002', Y) }),
  SALES_FREIGHT,
  key('ITEM_GROUP', 'CUSTOMER_DEPOSITS', { current: row('ITEM_GROUP', 'CUSTOMER_DEPOSITS', '2401', Y) }),
  LEATHER,
  key('ITEM_GROUP', 'TEXTILE', { current: row('ITEM_GROUP', 'TEXTILE', '6102', Y) }),
  key('ITEM_GROUP', 'LINING', { current: row('ITEM_GROUP', 'LINING', '6102', Y) }),
  key('ITEM_GROUP', 'HARDWARE', { current: row('ITEM_GROUP', 'HARDWARE', '6104', Y) }),
  key('TAX_CODE', 'V22', { current: row('TAX_CODE', 'V22', '2201', Y) }),
  key('TAX_CODE', 'N3.2', { current: row('TAX_CODE', 'N3.2', '2205', Y) }),
  key('TAX_CODE', 'VAT_INPUT', { current: row('TAX_CODE', 'VAT_INPUT', '1501', Y) }),
  key('TAX_CODE', 'WITHHOLDING'),
  key('COST_CATEGORY', 'SUBCONTRACT', { current: row('COST_CATEGORY', 'SUBCONTRACT', '6301', Y) }),
  key('COST_CATEGORY', 'COST_OF_SALES', { current: row('COST_CATEGORY', 'COST_OF_SALES', '6801', Y) }),
  key('COST_CATEGORY', 'FINISHED_GOODS', { current: row('COST_CATEGORY', 'FINISHED_GOODS', '1402', Y) }),
  key('COST_CATEGORY', 'WIP', { current: row('COST_CATEGORY', 'WIP', '1403', Y), upcoming: [row('COST_CATEGORY', 'WIP', '1404', '2027-01-01')] }),
  key('COST_CATEGORY', 'PPV', { current: row('COST_CATEGORY', 'PPV', '6811', Y) }),
  key('COST_CATEGORY', 'VARIANCE_SCRAP'),
  key('PAYMENT_METHOD', 'BANK_TRANSFER', { current: row('PAYMENT_METHOD', 'BANK_TRANSFER', '1801', Y) }),
  key('PAYMENT_METHOD', 'CARD', { current: row('PAYMENT_METHOD', 'CARD', '1802', Y) }),
  key('PARTY_GROUP', 'CUSTOMERS_IT', { current: row('PARTY_GROUP', 'CUSTOMERS_IT', '1201', Y) }),
  key('PARTY_GROUP', 'CUSTOMERS_EU'),
  key('PARTY_GROUP', 'SUPPLIERS_IT', { current: row('PARTY_GROUP', 'SUPPLIERS_IT', '2101', Y) }),
  OLD_RATE,
]

export const JOURNALS_OFF: JournalsSettings = { companyId: COMPANY.id, settingsId: null, version: null, journalsOn: false, from: 'DEFAULT', can: { switch: true } }
export const JOURNALS_ON: JournalsSettings = { companyId: COMPANY.id, settingsId: COMPANY.id, version: 2, journalsOn: true, from: 'COMPANY', can: { switch: true } }

/** 23 keys Nexus posts, 4 without an account (transport charged, tax withheld, the scrap variance, EU customers), 1 apart. */
export const MAPPING_ANSWER: MappingAnswer = {
  company: COMPANY,
  today: MAPPING_TODAY,
  keys: MAPPING_KEYS_DEMO,
  unmapped: MAPPING_KEYS_DEMO.filter((entry) => entry.posted && !entry.current).length,
  journals: JOURNALS_OFF,
  can: { manage: true },
}

/** What a person without the mapping's rights is answered (read only). */
export const MAPPING_READ_ONLY: MappingAnswer = { ...MAPPING_ANSWER, can: { manage: false }, journals: { ...JOURNALS_OFF, can: { switch: false } } }
