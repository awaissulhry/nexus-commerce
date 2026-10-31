import { CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import { listCertificates } from '../../../modules/compliance/certificates/certificates'
import { listReviews } from '../../../modules/compliance/type-changes/reviews'
import { defineExportSource } from '../source'

/**
 * Compliance › Certificates (SCR-050, `/compliance/certificates`): the export of the register as the screen shows it.
 * The screen reads the whole register (the module's listCertificates: compliance.certificates.view, its companies and
 * holders, by last valid day, at most 500) and filters it in the browser; this source does the same with the screen's
 * address terms (apps/factory-web areas/compliance/certificates model.ts filtersFromAddress, inView, matchesQuery):
 * `?view=all|valid|expiring|suspended|drafts|expired|changes` (nothing: all), `?kind=GARMENT|PROTECTOR|GLOVE|OTHER`,
 * `?q=` (every word in the number, standard, class, notified body or model reference). The changes waiting for the
 * notified body (the `changes` view and column) come from the type-change reviews still WAITING (listReviews), counted
 * as the screen counts them (OPEN or NOTIFIED). No money. The holder is our company's or a brand's name.
 */

type Certificate = Awaited<ReturnType<typeof listCertificates>>['certificates'][number]
type Row = Certificate & { readonly holderName: string | null; readonly waiting: number | null }

const VIEWS = ['all', 'valid', 'expiring', 'suspended', 'drafts', 'expired', 'changes'] as const
type View = (typeof VIEWS)[number]
const KINDS = ['GARMENT', 'PROTECTOR', 'GLOVE', 'OTHER'] as const
type Kind = (typeof KINDS)[number]

interface Query {
  readonly view: View
  readonly kind: Kind | 'all'
  readonly q: string
}

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))

/** What the standard certifies (the screen's kindOf). */
function kindOf(standard: string): Kind {
  const text = standard.trim().toUpperCase().replace(/\s+/g, ' ')
  if (/^EN ?17092\b/.test(text)) return 'GARMENT'
  if (/^EN ?1621\b/.test(text)) return 'PROTECTOR'
  if (/^EN ?13594\b/.test(text)) return 'GLOVE'
  return 'OTHER'
}

/** The screen's views (inView). */
function inView(row: Row, view: View): boolean {
  const past = row.daysToExpiry < 0
  switch (view) {
    case 'changes':
      return (row.waiting ?? 0) > 0
    case 'all':
      return true
    case 'valid':
      return row.status === 'VALID' && !past
    case 'expiring':
      return row.status === 'VALID' && row.daysToExpiry >= 0 && row.daysToExpiry <= 180
    case 'suspended':
      return row.status === 'SUSPENDED' || row.status === 'WITHDRAWN'
    case 'drafts':
      return row.status === 'DRAFT'
    case 'expired':
      return row.status === 'EXPIRED' || ((row.status === 'VALID' || row.status === 'SUSPENDED') && past)
  }
}

/** The screen's search (matchesQuery). */
function matches(row: Row, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = [row.number, row.standard, row.ppeClass, row.notifiedBodyName, row.notifiedBodyNumber, row.modelReference].filter(Boolean).join(' ').toLowerCase()
  return words.every((word) => text.includes(word))
}

export const certificates = defineExportSource<Query, Row>({
  listKey: 'compliance.certificates',
  permission: CERTIFICATES_VIEW,
  query(address) {
    const view = address.get('view') ?? ''
    const kind = address.get('kind') ?? ''
    return {
      view: (VIEWS as readonly string[]).includes(view) ? (view as View) : 'all',
      kind: (KINDS as readonly string[]).includes(kind) ? (kind as Kind) : 'all',
      q: address.get('q') ?? '',
    }
  },
  async read(caller, query) {
    const register = await listCertificates(caller, {})
    // The changes waiting for the notified body: an unreadable answer leaves the column empty, as the screen's "—".
    let waiting: Map<string, number> | null = null
    try {
      const reviews = (await listReviews(caller, { state: 'WAITING' })).reviews
      waiting = new Map()
      for (const review of reviews) if (review.status === 'OPEN' || review.status === 'NOTIFIED') waiting.set(review.certificate.id, (waiting.get(review.certificate.id) ?? 0) + 1)
    } catch {
      waiting = null
    }
    const companyIds = [...new Set(register.certificates.flatMap((row) => (row.holderPartyId ? [] : row.companyId ? [row.companyId] : [])))]
    const partyIds = [...new Set(register.certificates.flatMap((row) => (row.holderPartyId ? [row.holderPartyId] : [])))]
    const names = await caller.withClient(async (client) => {
      const companies = companyIds.length === 0 ? [] : await client.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, legalName: true, tradeName: true } })
      const parties = partyIds.length === 0 ? [] : await client.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, legalName: true, tradeName: true } })
      return new Map([...companies, ...parties].map((row) => [row.id, row.tradeName ?? row.legalName]))
    })
    const rows: Row[] = register.certificates.map((row) => ({
      ...row,
      holderName: (row.holderPartyId ? names.get(row.holderPartyId) : row.companyId ? names.get(row.companyId) : undefined) ?? null,
      waiting: waiting ? (waiting.get(row.id) ?? 0) : null,
    }))
    return { rows: rows.filter((row) => inView(row, query.view) && (query.kind === 'all' || kindOf(row.standard) === query.kind) && matches(row, query.q)), next: null }
  },
  columns: {
    number: { value: (row) => (row.modelReference ? `${row.number} · ${row.modelReference}` : row.number) },
    standard: {
      value: (row, words) => {
        const kind = kindOf(row.standard)
        return [row.standard, words(`kind.${kind}`), row.ppeClass ? fill(words(kind === 'PROTECTOR' ? 'list.level' : 'list.class'), { class: row.ppeClass }) : null].filter(Boolean).join(' · ')
      },
    },
    holder: { value: (row, words) => [row.holderName, words(row.holderPartyId ? 'holder.brand' : 'holder.company')].filter(Boolean).join(' · ') },
    body: { value: (row) => [row.notifiedBodyNumber, row.notifiedBodyName].filter(Boolean).join(' · ') },
    covers: { value: (row, words) => fill(words(`list.covers_${row.coverageCount === 1 ? 'one' : 'other'}`), { count: row.coverageCount }) },
    valid: { value: (row, words) => fill(words('list.validRange'), { from: row.validFrom, to: row.validTo }) },
    status: { value: (row, words) => words(`status.${row.status}`) },
    changes: { value: (row, words) => (row.waiting === null ? null : row.waiting === 0 ? words('list.changesNone') : fill(words(`list.changesWaiting_${row.waiting === 1 ? 'one' : 'other'}`), { count: row.waiting })) },
  },
  words: {
    it: {
      'status.DRAFT': 'Bozza',
      'status.VALID': 'Valido',
      'status.SUSPENDED': 'Sospeso',
      'status.WITHDRAWN': 'Ritirato',
      'status.EXPIRED': 'Scaduto',
      'kind.GARMENT': 'Capo EN 17092',
      'kind.PROTECTOR': 'Protettore EN 1621',
      'kind.GLOVE': 'Guanto EN 13594',
      'kind.OTHER': 'Altra norma',
      'holder.company': 'Nostra azienda',
      'holder.brand': 'Marchio (private label)',
      'list.class': 'classe {class}',
      'list.level': 'livello {class}',
      'list.covers_one': '{count} modello o parte',
      'list.covers_other': '{count} modelli o parti',
      'list.validRange': '{from} – {to}',
      'list.changesNone': 'Nessuna',
      'list.changesWaiting_one': '{count} in attesa',
      'list.changesWaiting_other': '{count} in attesa',
    },
    en: {
      'status.DRAFT': 'Draft',
      'status.VALID': 'Valid',
      'status.SUSPENDED': 'Suspended',
      'status.WITHDRAWN': 'Withdrawn',
      'status.EXPIRED': 'Expired',
      'kind.GARMENT': 'EN 17092 garment',
      'kind.PROTECTOR': 'EN 1621 protector',
      'kind.GLOVE': 'EN 13594 glove',
      'kind.OTHER': 'Other standard',
      'holder.company': 'Our company',
      'holder.brand': 'Brand (private label)',
      'list.class': 'class {class}',
      'list.level': 'level {class}',
      'list.covers_one': '{count} style or part',
      'list.covers_other': '{count} styles or parts',
      'list.validRange': '{from} – {to}',
      'list.changesNone': 'None',
      'list.changesWaiting_one': '{count} waiting',
      'list.changesWaiting_other': '{count} waiting',
    },
  },
})
