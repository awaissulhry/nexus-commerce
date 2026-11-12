import { DEMAND_LAYERS, DEMAND_KINDS, LAYER_WORDS, type DemandBucketKind, type DemandLayer } from '@nexus/factory-domain/planning/demand/rules'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { KIND_WORDS as SAMPLE_KIND_WORDS } from '@nexus/factory-domain/sales/samples/rules'
import { officeContextOf } from '../../../modules/planning/access'
import type { DemandSourceView } from '../../../modules/planning/demand/contract'
import { readDemandRows, type DemandRowsQuery } from '../../../modules/planning/demand/demand'
import { listSettings } from '../../../modules/planning/settings/settings'
import { defineExportSource } from '../source'

/**
 * Planning › Long range › Demand & forecast, its "Demand rows" (SCR-374 sec:list, `/planning/demand`, the page's second list
 * frame: listKey `planning.demand.2`; B-W2b-339 on B-W2b-319's read): the demand as a list with its source, through the module's
 * own readDemandRows (planning.view over the site, a source naming a customer only when the caller may see that customer), in
 * its order (day, then layer, document, line). The address is the page's (apps/factory-web areas/planning/demand model.ts):
 * `?site=` (a site of the screen's company the person plans, else the first by code, as the screen picks it from GET
 * /planning/settings), `?bucket=WEEK|MONTH`, `?weeks=`, and the list's own `?layer=` `?rq=` (a style or a document) `?style=`
 * `?colour=` (or `none`) `?size=` `?mtm=1` `?cell=` (one cell of the grid). The grid's `?layers=` and `?q=` are the grid's,
 * never the list's. Pieces only: no money, no person (a customer is a party).
 */

interface Query extends Omit<DemandRowsQuery, 'siteId' | 'cursor' | 'limit'> {
  readonly site: string | null
}

type Row = DemandSourceView

const STATUS_WORDS = {
  it: { CONFIRMED: 'Confermato', IN_PRODUCTION: 'In produzione', READY: 'Pronto per la spedizione', PARTLY_SHIPPED: 'Spedito in parte', SENT: 'Inviata al cliente', REQUESTED: 'Richiesto', IN_MAKING: 'In lavorazione', OPEN: 'Aperto', IN_PROGRESS: 'In corso', AUTHORISED: 'Reso autorizzato', RECEIVED: 'Reso ricevuto', INSPECTED: 'Reso controllato' },
  en: { CONFIRMED: 'Confirmed', IN_PRODUCTION: 'In production', READY: 'Ready to ship', PARTLY_SHIPPED: 'Partly shipped', SENT: 'Sent to the customer', REQUESTED: 'Requested', IN_MAKING: 'In making', OPEN: 'Open', IN_PROGRESS: 'In progress', AUTHORISED: 'Return authorised', RECEIVED: 'Return received', INSPECTED: 'Return inspected' },
} as const
const KIND_NAMES = {
  it: { ORDER_LINE: 'Riga d’ordine', QUOTE_LINE: 'Riga d’offerta', MTM_UNIT: 'Capo su misura', SAMPLE_ROUND: 'Giro campioni', REWORK: 'Rilavorazione', RECUT: 'Ritaglio', RETURN_REPLACEMENT: 'Sostituzione di un reso', RETURN_REMAKE: 'Rifacimento di un reso' },
  en: { ORDER_LINE: 'Order line', QUOTE_LINE: 'Quote line', MTM_UNIT: 'Made-to-measure unit', SAMPLE_ROUND: 'Sample round', REWORK: 'Rework', RECUT: 'Recut', RETURN_REPLACEMENT: 'Replacement for a return', RETURN_REMAKE: 'Remake for a return' },
} as const satisfies Record<'it' | 'en', Record<(typeof DEMAND_KINDS)[number], string>>

const prefixed = (prefix: string, words: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(words).map(([code, text]) => [`${prefix}.${code}`, text]))
const layerWords = (language: 'it' | 'en') => Object.fromEntries(Object.entries(LAYER_WORDS).map(([layer, words]) => [layer, words[language]]))
const sampleWords = (language: 'it' | 'en') => Object.fromEntries(Object.entries(SAMPLE_KIND_WORDS).map(([kind, words]) => [kind, words[language]]))
const isLayer = (value: string | null): value is DemandLayer => (DEMAND_LAYERS as readonly string[]).includes(value ?? '')
const fill = (template: string, params: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
const text = (value: string | null): string | undefined => (value && value.trim() ? value.trim().slice(0, 100) : undefined)

export const demandRows = defineExportSource<Query, Row>({
  listKey: 'planning.demand.2',
  page: '/planning/demand',
  permission: PLANNING_VIEW,
  query(address) {
    const weeks = Number(address.get('weeks'))
    const layer = address.get('layer')
    const size = text(address.get('size'))
    const mtm = address.get('mtm') === '1'
    return {
      site: address.get('site') || null,
      bucket: (address.get('bucket') === 'MONTH' ? 'MONTH' : 'WEEK') as DemandBucketKind,
      ...(Number.isInteger(weeks) && weeks >= 1 && weeks <= 104 ? { weeks } : {}),
      ...(isLayer(layer) ? { layer } : {}),
      ...(text(address.get('style')) ? { styleId: text(address.get('style')) } : {}),
      ...(text(address.get('colour')) ? { colourwayId: text(address.get('colour')) } : {}),
      ...(mtm ? { madeToMeasure: true } : size ? { size: size.slice(0, 20) } : {}),
      ...(text(address.get('cell')) ? { cell: text(address.get('cell'))!.slice(0, 20) } : {}),
      ...(text(address.get('rq')) ? { q: text(address.get('rq')) } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const context = officeContextOf(caller)
    // The screen's sites: the ones it plans, of its company, by code; the asked one, else the first.
    const sites = (await listSettings(caller, context.companyId ? { companyId: context.companyId } : {})).sites.map((entry) => entry.site).sort((a, b) => a.code.localeCompare(b.code))
    const siteId = sites.find((site) => site.id === query.site)?.id ?? sites[0]?.id ?? null
    if (!siteId) return { rows: [], next: null }
    const { site: _site, ...filter } = query
    const page = await readDemandRows(caller, { ...filter, siteId, ...(cursor ? { cursor } : {}), limit: Math.min(limit, 500) })
    return { rows: page.rows, next: page.nextCursor }
  },
  idOf: (row) => row.key,
  columns: {
    source: { value: (row, words) => [words(`kind.${row.kind}`), row.sampleKind ? words(`sample.${row.sampleKind}`) : row.part, words(`layer.${row.layer}`)].filter(Boolean).join(' · ') },
    document: {
      value: (row, words) =>
        [row.source.line !== null ? fill(words('doc.line'), { number: row.source.number, line: row.source.line }) : row.source.number, row.party ? `${row.party.code} ${row.party.name}` : null, row.origin ? fill(words('doc.from'), { origin: row.origin.number }) : null]
          .filter(Boolean)
          .join(' · '),
    },
    style: { value: (row, words) => `${row.style.code} · ${row.colourway ? row.colourway.name : words('any.colour')} · ${row.style.name}` },
    size: { value: (row, words) => row.size ?? words('size.mtm') },
    pieces: { value: (row) => row.pieces },
    date: { value: (row) => (row.date ? { day: row.date } : null) },
    status: { value: (row, words) => [Object.hasOwn(STATUS_WORDS.en, row.status) ? words(`status.${row.status}`) : row.status, row.planned ? words('plan.yes') : words('plan.no')].join(' · ') },
  },
  words: {
    it: {
      ...prefixed('kind', KIND_NAMES.it),
      ...prefixed('layer', layerWords('it')),
      ...prefixed('sample', sampleWords('it')),
      ...prefixed('status', STATUS_WORDS.it),
      'doc.line': '{number} · riga {line}',
      'doc.from': 'da {origin}',
      'any.colour': 'Qualsiasi colore',
      'size.mtm': 'Su misura',
      'plan.yes': 'coperta dal piano materiali',
      'plan.no': 'non nel piano materiali',
    },
    en: {
      ...prefixed('kind', KIND_NAMES.en),
      ...prefixed('layer', layerWords('en')),
      ...prefixed('sample', sampleWords('en')),
      ...prefixed('status', STATUS_WORDS.en),
      'doc.line': '{number} · line {line}',
      'doc.from': 'from {origin}',
      'any.colour': 'Any colour',
      'size.mtm': 'Made to measure',
      'plan.yes': 'bought for by the material plan',
      'plan.no': 'not in the material plan',
    },
  },
})
