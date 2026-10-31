import { LABELS_VIEW } from '@nexus/factory-domain/compliance/labels/permissions'
import { classificationOf } from '@nexus/factory-domain/product/compliance/rules'
import type { PpeCategory } from '@nexus/factory-domain/product/styles/rules'
import { listTemplates } from '../../../modules/compliance/labels/templates'
import { defineExportSource } from '../source'

/**
 * Compliance › Labels & marking (SCR-053, `/compliance/labels`): the export of the list as the screen shows it. The screen
 * reads every label template (the module's listTemplates: the certificate register's view permission, its companies,
 * by code and revision, at most 500) and filters in the browser; this source does the same with the screen's address
 * terms (apps/factory-web areas/compliance/labels model.ts viewOf and viewRows): `?view=all|active|drafts|retired`
 * (nothing: all), `?q=` (in the code, name, style code or name, maker). No money.
 */

type Row = Awaited<ReturnType<typeof listTemplates>>['templates'][number]

const VIEWS = ['all', 'active', 'drafts', 'retired'] as const
type View = (typeof VIEWS)[number]
const VIEW_STATUS: Readonly<Record<Exclude<View, 'all'>, string>> = { active: 'ACTIVE', drafts: 'DRAFT', retired: 'RETIRED' }

interface Query {
  readonly view: View
  readonly q: string
}

const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all))
/** Millimetres as the screen writes them (mmWords): "100", "45.5". */
const mm = (value: string): string => value.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')

/** The style's PPE standard and class in words (the screen's classWords), or null when it is not PPE. */
function classWords(style: NonNullable<Row['style']>): string | null {
  if (style.ppeCategory === 'NOT_PPE') return null
  const facts = classificationOf({ id: style.id, code: style.code, productType: 'JACKET', ppeCategory: style.ppeCategory as PpeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass, brandPartyId: null })
  return [style.ppeStandard, facts.ppeClass ?? facts.partClass].filter(Boolean).join(' · ') || null
}

export const labels = defineExportSource<Query, Row>({
  listKey: 'compliance.labels',
  permission: LABELS_VIEW,
  query(address) {
    const view = address.get('view') ?? ''
    return { view: (VIEWS as readonly string[]).includes(view) ? (view as View) : 'all', q: address.get('q') ?? '' }
  },
  async read(caller, query) {
    const { templates } = await listTemplates(caller, {})
    const words = query.q.trim().toLowerCase()
    const rows = templates.filter((row) => {
      if (query.view !== 'all' && row.status !== VIEW_STATUS[query.view]) return false
      if (!words) return true
      return [row.code, row.name, row.style?.code ?? '', row.style?.name ?? '', row.makerName].some((text) => text.toLowerCase().includes(words))
    })
    return { rows, next: null }
  },
  columns: {
    label: { value: (row, words) => `${fill(words('list.codeRevision'), { code: row.code, revision: row.revision })} · ${row.name}` },
    style: { value: (row, words) => (row.style ? `${row.style.code} · ${classWords(row.style) ?? words('list.notPpe')}` : words('list.shared')) },
    languages: { value: (row) => row.languages.join(' · ') || null },
    maker: { value: (row, words) => [row.makerName || null, words(row.makerPartyId ? 'list.makerBrand' : 'list.makerCompany')].filter(Boolean).join(' · ') },
    status: { value: (row, words) => words(`status.${row.status}`) },
    size: { value: (row, words) => fill(words('list.size'), { width: mm(row.widthMm), height: mm(row.heightMm) }) },
    checks: {
      value: (row, words) =>
        row.status !== 'DRAFT' ? words(row.status === 'ACTIVE' ? 'list.frozen' : 'list.retiredHint') : row.problems.length === 0 ? words('list.ready') : fill(words(`list.problems_${row.problems.length === 1 ? 'one' : 'other'}`), { count: row.problems.length }),
    },
  },
  words: {
    it: {
      'status.DRAFT': 'Bozza',
      'status.ACTIVE': 'Attiva',
      'status.RETIRED': 'Ritirata',
      'list.codeRevision': '{code} r{revision}',
      'list.shared': 'Condivisa',
      'list.notPpe': 'Non DPI',
      'list.makerBrand': 'Il marchio',
      'list.makerCompany': 'La nostra azienda',
      'list.size': '{width} × {height} mm',
      'list.ready': 'Pronta da attivare',
      'list.problems_one': '{count} cosa da sistemare',
      'list.problems_other': '{count} cose da sistemare',
      'list.frozen': 'Bloccata',
      'list.retiredHint': 'Conservata com’era',
    },
    en: {
      'status.DRAFT': 'Draft',
      'status.ACTIVE': 'Active',
      'status.RETIRED': 'Retired',
      'list.codeRevision': '{code} r{revision}',
      'list.shared': 'Shared',
      'list.notPpe': 'Not PPE',
      'list.makerBrand': 'The brand',
      'list.makerCompany': 'Our company',
      'list.size': '{width} × {height} mm',
      'list.ready': 'Ready to activate',
      'list.problems_one': '{count} thing to fix',
      'list.problems_other': '{count} things to fix',
      'list.frozen': 'Frozen',
      'list.retiredHint': 'Kept as it was',
    },
  },
})
