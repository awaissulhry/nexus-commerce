import { createElement, useMemo } from 'react'
import { Button } from '@nexus/ui/primitives'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { inShell, listModel, rowOf, SUPPLIERS, useDesignList } from '../../parties/_shared/fixtures'
import { blankNewParty, failed, loaded, loading, partyName, SIDES, type PartiesListModel } from '../../parties/_shared/model'
import { SuppliersView } from './view/SuppliersView'
// B-W2b-334: the list's W2b parts (made-up data in depth/demo.ts).
import type { SupplierDocuments } from './depth/api'
import { ALL_CAN, READ_CAN, summaryOf, supplierRowsOf, TODAY } from './depth/demo'
import { failedRead, LOADING, NS, ready, requestHeld, type DepthCan, type Read } from './depth/model'
import { useDocumentsColumn } from './list/columns'
import { ExpiringSection } from './list/view/ExpiringSection'
import { ImportButton } from './list/view/ImportButton'
import { RequestDialog, type RequestRun } from './list/view/RequestDialog'
import './depth/depth.css'

/**
 * SCR-056 Suppliers — made-up suppliers only (a "Conceria Demo", a "Tessitura Esempio", a subcontractor, a carrier, two
 * EU tanneries; example.com mail, VAT numbers of zeros and ones). Each case is one state the Owner reviews.
 */

const rows = SUPPLIERS.map(rowOf)
const list = (over: Partial<PartiesListModel> = {}) => listModel('suppliers', over)
const pick = (...codes: string[]) => rows.filter((row) => codes.includes(row.code)).map((row) => row.id)

/** B-W2b-334: a list case's W2b parts (the documents summary, the expiring view, a selection's Request documents). */
interface ListDepthCase {
  summary: Read<ReturnType<typeof summaryOf>>
  expiring?: boolean
  expiringSelected?: readonly string[]
  run?: RequestRun | null
  can?: DepthCan
}
type SuppliersCase = PartiesListModel & { w2b?: ListDepthCase }

function SuppliersDesign({ model }: { model: SuppliersCase }) {
  const { w2b, ...list } = model
  const designed = useDesignList(list)
  if (!w2b) return inShell('/purchasing/suppliers', createElement(SuppliersView, designed))
  return inShell('/purchasing/suppliers', createElement(WithMessages, { namespaces: [NS] }, createElement(DepthList, { list: designed, w2b })))
}

function DepthList({ list, w2b }: { list: ReturnType<typeof useDesignList>; w2b: ListDepthCase }) {
  const t = useT(NS)
  const summary = w2b.summary.status === 'ready' ? w2b.summary.value : null
  const byParty = useMemo(() => (summary ? new Map<string, SupplierDocuments>(summary.suppliers.map((row) => [row.partyId, row])) : null), [summary])
  const columns = useDocumentsColumn(byParty, w2b.summary.status === 'error' ? w2b.summary.problem : null)
  const can = w2b.can ?? ALL_CAN
  const selected = (list.model.rows.items ?? []).filter((row) => list.model.selected.includes(row.id))
  const held = requestHeld(can, selected.length)
  return createElement(
    'div',
    null,
    createElement(SuppliersView, {
      ...list,
      columns,
      headActions: createElement(ImportButton, { label: t('import.suppliers'), held: can.manage ? null : t('held.manage') }),
      depth: {
        tiles: [{ label: t('tile.expiring'), value: summary ? String(summary.expiringIn30Days) : w2b.summary.status === 'loading' ? '…' : '—', hint: w2b.summary.status === 'error' ? t('tile.unknown') : t('tile.expiringHint'), active: w2b.expiring === true }],
        body: w2b.expiring
          ? createElement(ExpiringSection, {
              model: { summary: summary ? ready(summary.suppliers) : w2b.summary.status === 'error' ? failedRead(w2b.summary.problem) : LOADING, suppliers: ready(supplierRowsOf(SUPPLIERS)), can, prefix: '/w/DEMO', ...(w2b.expiringSelected ? { selected: w2b.expiringSelected } : {}) },
            })
          : null,
        bulk: createElement(Button, { size: 'sm', heldReason: held ? t(held.key, held.params) : null }, t('list.request', { count: selected.length })),
      },
    }),
    createElement(RequestDialog, { run: w2b.run ?? null, today: TODAY }),
  )
}

const euDraft = () => {
  const draft = blankNewParty(SIDES.suppliers)
  return {
    ...draft,
    party: { ...draft.party, country: 'PT', language: 'pt', legalName: 'Couros Exemplo Lda', code: 'COUROS-EXEMPLO' },
    identity: { ...draft.identity, country: 'PT', taxMode: 'EU_B2B' as const, vatNumber: 'PT111111111' },
  }
}

const SUMMARY = summaryOf(rows)
const w2b = (depth: Partial<ListDepthCase> = {}, over: Partial<PartiesListModel> = {}): SuppliersCase => ({ ...list(over), w2b: { summary: ready(SUMMARY), ...depth } })
const expiringIds = SUMMARY.suppliers.filter((row) => row.expiring > 0).map((row) => row.partyId)
const run = (over: Partial<RequestRun> = {}): RequestRun => ({ targets: SUPPLIERS.filter((item) => expiringIds.includes(item.id)).map((item) => ({ id: item.id, name: partyName(item) })), due: '2026-11-30', tried: false, sending: false, results: [], done: false, ...over })

export const designScreen = defineDesignScreen<SuppliersCase>({
  screen: 'SCR-056',
  title: 'Suppliers',
  view: SuppliersDesign,
  cases: [
    { id: 'list', label: 'The list: roles, VAT number with its VIES mark', model: list(), note: 'Pelletteria Doppia is also a customer: one party record, both lists.' },
    { id: 'view-subcontractors', label: 'Rows ▾ Subcontractors', model: list({ view: 'subcontractors', rows: loaded(rows.filter((row) => row.roles.includes('SUBCONTRACTOR'))), total: 1 }) },
    { id: 'tile-prospects', label: 'Tile pressed: prospects (no POs until approved)', model: list({ view: 'prospects', rows: loaded(rows.filter((row) => row.status === 'PROSPECT')), total: 1 }) },
    { id: 'search', label: 'Search', model: list({ query: 'conceria', rows: loaded(rows.filter((row) => /conceria/i.test(row.legalName))), total: 1 }) },
    { id: 'filtered-empty', label: 'No rows match these filters', model: list({ query: 'zzz', rows: loaded([]), total: 0 }) },
    { id: 'empty', label: 'First day: no supplier yet', model: list({ rows: loaded([]), total: 0, tiles: { active: 0, prospects: 0, blocked: 0 } }) },
    { id: 'loading', label: 'Loading', model: list({ rows: loading(), total: null, tiles: {}, asOf: null, live: 'connecting' }) },
    {
      id: 'error',
      label: "The API didn't answer",
      model: list({ rows: failed('problem.unavailable'), total: null, tiles: { active: null, prospects: null, blocked: null }, asOf: null, live: 'offline' }),
    },
    { id: 'no-access', label: 'No permission', model: list({ can: { view: false, manage: false, block: false, vies: false } }) },
    { id: 'read-only', label: 'Read-only rights: actions held with their reason', model: list({ can: { view: true, manage: false, block: false, vies: false }, selected: pick('DE-LEDER') }) },
    { id: 'selection', label: 'Selection: reach said before the click', model: list({ selected: pick('DE-LEDER', 'PT-EXEMPLO', 'CONCERIA-DEMO', 'FORN-BLOCCATO') }) },
    { id: 'live-updates', label: 'Live: 2 updates waiting', model: list({ updates: 2 }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows', model: list({ focusRow: 1 }) },
    { id: 'new', label: 'New supplier (opens as a prospect)', model: list({ dialog: { kind: 'new' } }) },
    { id: 'new-eu', label: 'New supplier: an EU tannery', model: list({ dialog: { kind: 'new' }, newDraft: euDraft() }) },
    {
      id: 'new-duplicate',
      label: 'New supplier: already a customer',
      model: list({ dialog: { kind: 'new' }, dialogProblem: 'new.conflictNumber', duplicates: [rowOf(SUPPLIERS.find((item) => item.code === 'PELLETTERIA-DOPPIA')!)] }),
    },
    { id: 'block', label: 'Block a supplier', model: list({ dialog: { kind: 'block', partyIds: pick('TESSITURA-ESEMPIO') } }) },
    { id: 'all-selected', label: 'Every loaded row selected (header box)', model: list({ selected: rows.map((row) => row.id) }) },
    { id: 'archive', label: 'Archive a supplier', model: list({ dialog: { kind: 'archive', partyIds: pick('PROTEZIONI-PROVA') } }) },
    { id: 'shortcuts', label: 'Keyboard shortcuts (?)', model: list({ dialog: { kind: 'shortcuts' } }) },
    { id: 'w2b-334-list', label: 'W2b: Import, the Documents column, Documents expiring in 30 days', model: w2b(), note: 'The tile is a saved view; the column says valid · expiring · expired · missing per supplier.' },
    { id: 'w2b-334-selection', label: 'W2b: a selection — Request documents (N)', model: w2b({}, { selected: pick('CONCERIA-DEMO', 'TESSITURA-ESEMPIO', 'TERZISTA-DEMO') }) },
    { id: 'w2b-334-selection-held', label: 'W2b: Request documents held (no right to ask partners)', model: w2b({ can: READ_CAN }, { selected: pick('CONCERIA-DEMO'), can: { view: true, manage: false, block: false, vies: false } }) },
    { id: 'w2b-334-expiring', label: 'W2b: the tile pressed — suppliers with documents expiring in 30 days', model: w2b({ expiring: true }) },
    { id: 'w2b-334-expiring-selection', label: 'W2b: the expiring view, rows picked (Request documents, Export)', model: w2b({ expiring: true, expiringSelected: expiringIds.slice(0, 2) }) },
    { id: 'w2b-334-expiring-empty', label: 'W2b: no document expires in 30 days', model: w2b({ expiring: true, summary: ready({ suppliers: SUMMARY.suppliers.map((row) => ({ ...row, expiring: 0 })), expiringIn30Days: 0 }) }) },
    { id: 'w2b-334-request', label: 'W2b: Request documents from 3 suppliers (a due day)', model: w2b({ run: run() }) },
    { id: 'w2b-334-request-done', label: 'W2b: Request documents — asked, one waiting already, one refused', model: w2b({ run: run({ sending: false, done: true, results: run().targets.map((target, index) => ({ id: target.id, name: target.name, outcome: index === 0 ? ('asked' as const) : index === 1 ? ('already' as const) : ('refused' as const), ...(index > 1 ? { problem: 'problem.forbidden' } : {}) })) }) }) },
    { id: 'w2b-334-docs-loading', label: 'W2b: the documents summary loading', model: w2b({ summary: LOADING }) },
    { id: 'w2b-334-docs-error', label: "W2b: the documents summary couldn't load ('—' with why)", model: w2b({ summary: failedRead('problem.offline') }) },
  ],
})
