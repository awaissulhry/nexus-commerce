import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import type { GuestExportView, GuestFileView, GuestInvoiceView, GuestRegisterView } from '@nexus/factory-domain/accounting/guest/contracts'
import { formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { portalNavFor } from '../../shell/nav/portal-nav'
import type { PortalShellViewModel } from '../../shell/view/PortalShellView'
import type { ThreadViewModel } from '../../shell/view/ThreadView'
import type { Overview, PeriodRead } from './api'
import { NS } from './model'

/**
 * SCR-268's made-up world (B-W2b-201; PLAN §3.1): an invented maker (Officina Demo S.r.l., code DEMO, its finance person
 * Paola Esempio) and an invented accounting firm (Studio Esempio Commercialisti, its accountant Marta Esempio). Finance
 * handed over July to October 2026 by their numbered exports (EXP-2026-0009 … 0014; October's payments re-exported), with
 * made-up invoice numbers FT-2026-00141 … and suppliers (Conceria Prova, Minuteria Finta). Never a real company, person or
 * number; never an amount (the files hold them).
 */

const HOUR = 3_600_000
// One clock for the server render and the first client render.
export const NOW = Math.floor(Date.now() / HOUR) * HOUR
export const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
export const PREFIX = '/p/STUDIO-ESEMPIO'
export const words = (locale: Locale, namespace = NS) => createTranslator(locale, CATALOGUE[locale][namespace] ?? {})
const id = (n: number) => `0190f0e2-2680-7000-8000-${String(n).padStart(12, '0')}`
export const FIRM_ID = id(1)

const LEGAL = {
  it: { name: 'Officina Demo S.r.l.', lines: ['Sede legale: Via Fittizia 22, 20900 Monza (MB)', 'P. IVA IT00000000000 · C.F. 00000000000'] },
  en: { name: 'Officina Demo S.r.l.', lines: ['Registered office: Via Fittizia 22, 20900 Monza (MB)', 'VAT IT00000000000 · Tax code 00000000000'] },
} as const

/** The accountant's role: guest-accountant (files.read, portal.home.view, portal.search, threads.read, portal.accounting.view). */
export const ACCOUNTANT = (permission: string) => ['files.read', 'portal.home.view', 'portal.search', 'threads.read', 'portal.accounting.view'].includes(permission)
/** A person whose role does not open the room (an older guest role without it). */
export const NO_ROOM = (permission: string) => ['portal.home.view', 'threads.read'].includes(permission)

export function shellOf(locale: Locale, over: Partial<PortalShellViewModel> = {}, can: (permission: string) => boolean = ACCOUNTANT): PortalShellViewModel {
  return {
    brand: null,
    companyName: 'Officina Demo',
    partyName: 'Studio Esempio Commercialisti',
    person: { displayName: 'Marta Esempio', email: 'marta@studio-esempio.example' },
    nav: portalNavFor({ can, kinds: ['GUEST'] }),
    path: '/accounting',
    prefix: PREFIX,
    badges: null,
    bell: { unread: 0, complete: true },
    notice: null,
    band: null,
    live: 'live',
    legal: LEGAL[locale],
    privacyHref: '/privacy/00000000-0000-7000-8000-000000000001',
    termsHref: `${PREFIX}/terms`,
    freeForSuppliers: false,
    preview: false,
    canSearch: can('portal.search'),
    ...over,
  }
}

// ── the overview ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function overviewOf(over: { accessUntil?: string | null; endsSoon?: boolean; preview?: boolean; months?: Overview['months']; givenBy?: string | null } = {}): Overview {
  const months: Overview['months'] = over.months ?? [
    { month: '2026-10', lock: { level: 'SOFT', lockedAt: '2026-11-15T09:12:00.000Z' }, batches: 2 },
    { month: '2026-09', lock: { level: 'HARD', lockedAt: '2026-10-15T08:40:00.000Z' }, batches: 1 },
    { month: '2026-08', lock: { level: 'HARD', lockedAt: '2026-09-16T10:05:00.000Z' }, batches: 1 },
    { month: '2026-07', lock: { level: 'HARD', lockedAt: '2026-08-18T14:30:00.000Z' }, batches: 1 },
  ]
  const list = months.map((entry) => entry.month)
  return {
    access: {
      firm: { id: FIRM_ID, name: 'Studio Esempio Commercialisti' },
      company: { id: id(2), code: 'DEMO', name: 'Officina Demo' },
      givenBy: over.givenBy === undefined ? 'Paola Esempio' : over.givenBy,
      accessUntil: over.accessUntil === undefined ? at(24 * 80) : over.accessUntil,
      endsSoon: over.endsSoon ?? false,
      preview: over.preview ?? false,
    },
    months,
    choices: {
      months: list,
      quarters: [...new Set(list.map((month) => `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`))],
      years: [...new Set(list.map((month) => month.slice(0, 4)))],
    },
    latest: list[0] ?? null,
    asOf: at(0),
  }
}

// ── the files ────────────────────────────────────────────────────────────────────────────────────────────────────────
const file = (n: number, name: string, sizeBytes: number, contentType = 'text/csv'): GuestFileView => ({ id: id(n), name, contentType, sizeBytes, sha256: `${'9c2e4a7f1b3d'}${String(n).padStart(52, '0')}` })

const batch = (n: number, number: string, month: string, exportedAt: string, packages: readonly [GuestExportView['files'][number]['package'], number][], over: Partial<GuestExportView> = {}): GuestExportView => ({
  exportId: id(n),
  number,
  month,
  exportedAt,
  amends: null,
  amendedBy: null,
  files: packages.map(([pkg, rows], index) => ({ package: pkg, format: 'CSV', rowCount: rows, file: file(n * 10 + index, `DEMO_${month}_${pkg.toLowerCase().replace(/_/g, '-')}_${number.slice(-4)}.csv`, 2_400 + rows * 180) })),
  ...over,
})

export const EXPORTS: Readonly<Record<string, readonly GuestExportView[]>> = {
  '2026-10': [
    batch(100, 'EXP-2026-0012', '2026-10', '2026-11-05T10:20:00.000Z', [['SALES_JOURNAL', 46], ['PURCHASES_JOURNAL', 31], ['PAYMENTS', 58]], { amendedBy: 'EXP-2026-0014' }),
    batch(110, 'EXP-2026-0014', '2026-10', '2026-11-12T16:45:00.000Z', [['PAYMENTS', 3]], { amends: 'EXP-2026-0012' }),
  ],
  '2026-09': [batch(120, 'EXP-2026-0011', '2026-09', '2026-10-06T09:00:00.000Z', [['SALES_JOURNAL', 39], ['PURCHASES_JOURNAL', 27], ['PAYMENTS', 44]])],
  '2026-08': [batch(130, 'EXP-2026-0010', '2026-08', '2026-09-07T09:30:00.000Z', [['SALES_JOURNAL', 12], ['PURCHASES_JOURNAL', 9], ['PAYMENTS', 15]])],
  '2026-07': [batch(140, 'EXP-2026-0009', '2026-07', '2026-08-05T11:10:00.000Z', [['SALES_JOURNAL', 0], ['PURCHASES_JOURNAL', 0], ['PAYMENTS', 0]])],
}

const sale = (n: number, number: string, date: string, party: string, state: string, kind: GuestInvoiceView['kind'] = 'INVOICE', pdf = true): GuestInvoiceView => ({
  id: id(n),
  side: 'SALES',
  kind,
  number,
  date,
  party,
  state,
  xml: file(n * 10, `IT00000000000_${number.slice(-5)}.xml`, 7_800, 'application/xml'),
  pdf: pdf ? file(n * 10 + 1, `${number}.pdf`, 96_000, 'application/pdf') : null,
})

const purchase = (n: number, number: string, date: string, party: string, state: 'SDI' | 'EMAIL' | 'MANUAL', kind: GuestInvoiceView['kind'] = 'INVOICE'): GuestInvoiceView => ({
  id: id(n),
  side: 'PURCHASE',
  kind,
  number,
  date,
  party,
  state,
  xml: state === 'SDI' ? file(n * 10, `IT00000000001_${String(n).padStart(5, '0')}.xml`, 6_400, 'application/xml') : null,
  pdf: state === 'MANUAL' ? null : file(n * 10 + 1, `${number.replace(/\//g, '-')}.pdf`, 120_000, 'application/pdf'),
})

export const INVOICES: Readonly<Record<string, readonly GuestInvoiceView[]>> = {
  '2026-10': [
    sale(300, 'FT-2026-00141', '2026-10-02', 'Brand Alpha S.r.l.', 'DELIVERED'),
    sale(301, 'FT-2026-00142', '2026-10-06', 'Moda Beta S.p.A.', 'DELIVERED', 'DEPOSIT'),
    sale(302, 'FT-2026-00143', '2026-10-14', 'Boutique Gamma (made up)', 'NOT_DELIVERABLE'),
    sale(303, 'FT-2026-00144', '2026-10-21', 'Brand Alpha S.r.l.', 'REJECTED', 'INVOICE', false),
    sale(304, 'NC-2026-00012', '2026-10-28', 'Moda Beta S.p.A.', 'SENT', 'CREDIT_NOTE'),
    purchase(310, '2026/0412', '2026-10-09', 'Conceria Prova S.p.A.', 'SDI'),
    purchase(311, 'A-778', '2026-10-17', 'Minuteria Finta S.n.c.', 'EMAIL'),
    purchase(312, '15/2026', '2026-10-23', 'Trasporti Esempio', 'MANUAL'),
    purchase(313, '2026/0450', '2026-10-30', 'Conceria Prova S.p.A.', 'SDI', 'CREDIT_NOTE'),
  ],
  '2026-09': [sale(320, 'FT-2026-00131', '2026-09-11', 'Brand Alpha S.r.l.', 'DELIVERED'), purchase(321, '2026/0388', '2026-09-15', 'Conceria Prova S.p.A.', 'SDI')],
  '2026-08': [sale(330, 'FT-2026-00120', '2026-08-04', 'Moda Beta S.p.A.', 'DELIVERED')],
  '2026-07': [],
}

const register = (n: number, pkg: GuestRegisterView['package'], month: string, exportNumber: string, exportedAt: string, current: boolean, replacedBy: string | null = null): GuestRegisterView => ({
  package: pkg,
  month,
  exportNumber,
  exportedAt,
  current,
  replacedBy,
  format: pkg === 'INTRASTAT' ? 'TXT' : 'XLSX',
  file: file(n, `DEMO_${month}_${pkg.toLowerCase().replace(/_/g, '-')}_${exportNumber.slice(-4)}.${pkg === 'INTRASTAT' ? 'txt' : 'xlsx'}`, 3_900, pkg === 'INTRASTAT' ? 'text/plain' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
})

export const REGISTERS: Readonly<Record<string, readonly GuestRegisterView[]>> = {
  '2026-10': [
    register(500, 'INTRASTAT', '2026-10', 'EXP-2026-0014', '2026-11-12T16:45:00.000Z', true),
    register(501, 'INTRASTAT', '2026-10', 'EXP-2026-0012', '2026-11-05T10:20:00.000Z', false, 'EXP-2026-0014'),
  ],
  '2026-09': [register(510, 'INTRASTAT', '2026-09', 'EXP-2026-0011', '2026-10-06T09:00:00.000Z', true)],
  '2026-08': [],
  '2026-07': [],
}

const LOCKS: Readonly<Record<string, PeriodRead['period']['months'][number]['lock']>> = {
  '2026-10': { level: 'SOFT', lockedAt: '2026-11-15T09:12:00.000Z' },
  '2026-09': { level: 'HARD', lockedAt: '2026-10-15T08:40:00.000Z' },
  '2026-08': { level: 'HARD', lockedAt: '2026-09-16T10:05:00.000Z' },
  '2026-07': { level: 'HARD', lockedAt: '2026-08-18T14:30:00.000Z' },
}

const monthsOf = (key: string): string[] => {
  if (/^\d{4}-\d{2}$/.test(key)) return [key]
  const year = key.slice(0, 4)
  const quarter = /-Q([1-4])$/.exec(key)?.[1]
  const numbers = quarter ? [0, 1, 2].map((offset) => (Number(quarter) - 1) * 3 + 1 + offset) : Array.from({ length: 12 }, (_, index) => index + 1)
  return numbers.map((number) => `${year}-${String(number).padStart(2, '0')}`)
}

/** A period's answer as the API gives it (the handed-over months July … October 2026). */
export function periodOf(key: string, over: Partial<Pick<PeriodRead, 'exports' | 'invoices' | 'registers'>> = {}): PeriodRead {
  const months = monthsOf(key)
  const shared = months.filter((month) => month in EXPORTS)
  const exports = over.exports ?? shared.flatMap((month) => EXPORTS[month] ?? [])
  const invoices = over.invoices ?? shared.flatMap((month) => INVOICES[month] ?? [])
  const registers = over.registers ?? shared.flatMap((month) => REGISTERS[month] ?? [])
  const files = [...exports.flatMap((entry) => entry.files.map((one) => one.file)), ...registers.filter((row) => row.current).map((row) => row.file), ...invoices.flatMap((row) => [row.xml, row.pdf].filter((one): one is GuestFileView => one !== null))]
  return {
    period: {
      key,
      kind: months.length === 1 ? 'MONTH' : months.length === 3 ? 'QUARTER' : 'YEAR',
      start: `${months[0]}-01`,
      end: `${months[months.length - 1]}-${new Date(Date.UTC(Number(months[months.length - 1]!.slice(0, 4)), Number(months[months.length - 1]!.slice(5, 7)), 0)).getUTCDate()}`,
      months: months.map((month) => ({ month, shared: shared.includes(month), lock: LOCKS[month] ?? null })),
    },
    exports: [...exports],
    invoices: [...invoices],
    registers: [...registers],
    later: ['VAT_REGISTERS', 'VAT_SUMMARY'],
    counts: { files: files.length, xml: invoices.filter((row) => row.xml).length, sizeBytes: files.reduce((sum, one) => sum + one.sizeBytes, 0) },
    asOf: at(0),
  }
}

// ── Ask finance ──────────────────────────────────────────────────────────────────────────────────────────────────────
export function threadOf(locale: Locale, state: ThreadViewModel['state'] = 'ready'): ThreadViewModel {
  const t = words(locale)
  const portal = words(locale, 'portal')
  const messages: PartnerMessage[] = [
    {
      id: 'm1',
      side: 'partner',
      channel: 'portal',
      author: { name: 'Marta Esempio', mine: true },
      body: locale === 'it' ? 'Buongiorno, nel lotto di ottobre manca la fattura di Trasporti Esempio in XML: ce l’avete solo cartacea?' : 'Good morning, October’s batch has no XML for the Trasporti Esempio invoice: do you only have it on paper?',
      at: at(-30),
      atText: formatDateTime(at(-30), { locale }),
    },
    {
      id: 'm2',
      side: 'company',
      channel: 'email',
      author: { name: 'Paola Esempio', mine: false },
      body: locale === 'it' ? 'Sì, è arrivata per posta: l’abbiamo registrata a mano. Il PDF lo carichiamo domani.' : 'Yes, it came by post: we typed it in. We will add the PDF tomorrow.',
      at: at(-26),
      atText: formatDateTime(at(-26), { locale }),
    },
  ]
  return { state, title: t('ask.title'), record: null, companyName: 'Officina Demo', messages: state === 'ready' ? messages : [], composer: { value: '', busy: false, heldReason: null, hint: portal('thread.hint'), limit: 20_000 }, loadMore: null, accessLine: null, failed: null }
}
