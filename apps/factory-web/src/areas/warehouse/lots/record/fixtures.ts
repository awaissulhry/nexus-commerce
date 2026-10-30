import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import { canFor, COMPANY, inShell, NOW, PREFIX, SITE, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { CHECKLIST_DONE, CHECKLIST_OPEN, CHECKLIST_RELEASED, LOT_ROWS, lotMoves, lotRecordOf } from '../demo/fixtures'
import type { LotRecordModel, LotTab } from '../model'
import { part } from '../shared/model'
import { LotRecordView } from './view/LotRecordView'

/**
 * SCR-201-record — a lot with made-up data only: the released nappa lot (its checklist, stock in two places, hides, used
 * by two work orders, one shipped to a customer), a lot in quarantine waiting for its Cr VI result (checklist open), a
 * suede lot whose Cr VI failed (blocked), an opening-stock lot (no receipt), a rejected lot (read only), the Moves tab with
 * the running balance, the Activity tab and the thread docked; the states (loading, not found, failed, no right). Roles:
 * Owner, Warehouse (sees the checklist read-only), Quality, Read-only, Sales (no inventory.stock.view).
 */

interface LotCase {
  role: RoleCase
  record: LotRecordModel
}

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

function lotCase(role: RoleCase, row = LOT_ROWS[0]!, over: Partial<LotRecordModel> = {}, tab: LotTab = 'overview'): LotCase {
  const can = canFor(role)
  const checklist = row.qualityStatus === 'RELEASED' ? CHECKLIST_RELEASED : row.crVi.status === 'PENDING' ? CHECKLIST_OPEN : CHECKLIST_DONE
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      tab,
      record: can.stockView ? { status: 'ready', value: lotRecordOf(row) } : { status: 'forbidden' },
      checklist: can.lotsView ? part(checklist) : null,
      moves: part(lotMoves(row)),
      live: 'live',
      asOf: NOW,
      changed: null,
      dockOpen: false,
      timeZone: TIME_ZONE,
      panelsPreview: { ...conversation, record: { type: 'Lot', id: row.id, companyId: COMPANY, siteId: SITE.id }, title: row.code, party: null },
      ...over,
    },
  }
}

function LotDesign({ model }: { model: LotCase }) {
  const value = model.record.record.status === 'ready' ? model.record.record.value : null
  return inShell(`/warehouse/lots/${value?.lot.id ?? 'x'}`, createElement(LotRecordView, { model: model.record }), model.role)
}

const [released, quarantine, failed, , , opening, rejected] = LOT_ROWS

export const designScreen = defineDesignScreen<LotCase>({
  screen: 'SCR-201-record',
  title: 'A lot (release checklist, where it is, trace both ways, moves)',
  view: LotDesign,
  cases: [
    { id: 'released', label: 'Released nappa lot: checklist done, stock in two places, hides', model: lotCase('owner') },
    { id: 'quarantine', label: 'In quarantine: waits for its Cr VI result (checklist open)', model: lotCase('quality', quarantine), note: 'Release checklist in Tests & substances opens the one place where the lot is released.' },
    { id: 'cr-vi-failed', label: 'Cr VI failed: blocked, can never be issued', model: lotCase('owner', failed) },
    { id: 'opening', label: 'Opening stock (no receipt): came from says so', model: lotCase('warehouse', opening) },
    { id: 'rejected', label: 'Rejected: nothing left, read only', model: lotCase('owner', rejected) },
    { id: 'warehouse', label: 'Warehouse: sees the checklist read-only', model: lotCase('warehouse') },
    { id: 'read-only', label: 'Read-only', model: lotCase('readOnly') },
    { id: 'no-quality', label: 'A role without quality.lots.view: the checklist link is held in words', model: lotCase('owner', released, { can: { ...canFor('owner'), lotsView: false }, checklist: null }) },
    { id: 'trace', label: 'Trace: from the supplier and receipt to two work orders, one shipment, one customer', model: lotCase('owner', released, {}, 'trace') },
    { id: 'trace-empty', label: 'Trace: not used yet', model: lotCase('quality', quarantine, {}, 'trace') },
    { id: 'trace-opening', label: 'Trace of opening stock', model: lotCase('warehouse', opening, {}, 'trace') },
    { id: 'moves', label: 'Moves: the ledger of the lot with the running balance', model: lotCase('warehouse', released, {}, 'moves') },
    { id: 'moves-loading', label: 'Moves loading', model: lotCase('warehouse', released, { moves: { value: null, problem: null } }, 'moves') },
    { id: 'moves-error', label: "Moves couldn't be read", model: lotCase('warehouse', released, { moves: { value: null, problem: 'problem.offline' } }, 'moves') },
    { id: 'activity', label: 'Activity: thread, files and history', model: lotCase('owner', released, {}, 'activity') },
    { id: 'docked', label: 'Thread beside the overview (wide screen, ⌘J)', model: lotCase('owner', released, { dockOpen: true }) },
    { id: 'checklist-error', label: "The checklist couldn't be read", model: lotCase('quality', quarantine, { checklist: { value: null, problem: 'problem.read' } }) },
    { id: 'changed', label: 'Changed by someone else meanwhile', model: lotCase('owner', released, { changed: { at: NOW } }) },
    { id: 'loading', label: 'Loading', model: lotCase('owner', released, { record: { status: 'loading' } }) },
    { id: 'not-found', label: 'Not found (or another company)', model: lotCase('owner', released, { record: { status: 'not_found' } }) },
    { id: 'error', label: "The lot couldn't be read", model: lotCase('owner', released, { record: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'sales', label: 'Sales: no inventory.stock.view', model: lotCase('sales') },
  ],
})
