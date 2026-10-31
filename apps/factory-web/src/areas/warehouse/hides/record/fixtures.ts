import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, NOW, PREFIX, PEOPLE, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { part } from '../../lots/shared/model'
import { HIDE_HOLDS, HIDE_ROWS, hideMoves, hideRecordOf, printDialog, printedDialog } from '../demo/fixtures'
import { dailyFor, HOLD_REASONS, reserveDialog, writeOffDialog } from '../../lots/demo/daily/fixtures'
import { reserveHides, scrapTarget } from '../../lots/shared/daily'
import type { HideRecordModel, HideTab } from '../model'
import { HideRecordView } from './view/HideRecordView'

/**
 * SCR-200-record — one hide with made-up data only: a hide partly cut at the cutting table (its area in one bar: cut,
 * at the work order; its cuts with one entered twice and reversed), a full hide ready to cut, a remnant, a consumed hide
 * (read only), a hide of a lot in quarantine (held with the lot's reason), a hide of a lot whose Cr VI failed; the Cuts
 * tab at a site that records stations only and at one that names workers (inside this one record only); the Moves tab;
 * the tag's print dialog and its job; the states. B-W2a-64: a hide reserved for a work order (the next step links it),
 * one whose reservation's work order is done (release it), one on hold by its own quality hold (the reason in words),
 * Reserve and Scrap from the band (each held with its reason), their dialogs. Roles: Owner, Warehouse, Quality, Read-only,
 * Sales (no inventory.stock.view).
 */

interface HideCase {
  role: RoleCase
  record: HideRecordModel
}

function hideCase(role: RoleCase, row = HIDE_ROWS[2]!, over: Partial<HideRecordModel> = {}, tab: HideTab = 'overview', record = hideRecordOf(row)): HideCase {
  const can = canFor(role)
  const daily = dailyFor(role)
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      daily,
      holds: daily.holdsView ? HIDE_HOLDS : {},
      holdReasons: HOLD_REASONS,
      reserve: null,
      writeOff: null,
      tab,
      record: can.stockView ? { status: 'ready', value: record } : { status: 'forbidden' },
      moves: part(hideMoves(row)),
      live: 'live',
      asOf: NOW,
      timeZone: TIME_ZONE,
      print: null,
      ...over,
    },
  }
}

function HideDesign({ model }: { model: HideCase }) {
  const value = model.record.record.status === 'ready' ? model.record.record.value : null
  return inShell(`/warehouse/hides/${value?.hide.id ?? 'x'}`, createElement(HideRecordView, { model: model.record }), model.role)
}

const [full, onHold, partly, remnant, consumed, staleRow, quarantined, , , failed] = HIDE_ROWS
const reservedRow = HIDE_ROWS[0]!
const freeFull = { ...full!, reservedFor: null }

export const designScreen = defineDesignScreen<HideCase>({
  screen: 'SCR-200-record',
  title: 'A hide (facts, area balance, cuts, moves, its tag)',
  view: HideDesign,
  cases: [
    { id: 'partly-cut', label: 'Partly cut at the cutting table: the area bar (cut · at the work order)', model: hideCase('warehouse') },
    { id: 'full', label: 'A full hide in stock: ready to cut (Reserve and Scrap allowed)', model: hideCase('warehouse', freeFull) },
    { id: 'reserved', label: 'B-W2a-64 — Reserved for WO-D-0031: the next step links the work order; Reserve held (reserved already)', model: hideCase('warehouse', reservedRow) },
    { id: 'reserved-stale', label: 'B-W2a-64 — Reserved for a work order that is done: release it', model: hideCase('warehouse', staleRow) },
    { id: 'on-hold', label: 'B-W2a-64 — On hold by its own quality hold: the reason in words, since when', model: hideCase('quality', onHold) },
    { id: 'reserve-dialog', label: 'B-W2a-64 — Reserve this hide to a work order', model: hideCase('warehouse', freeFull, { reserve: reserveDialog(reserveHides([freeFull], {}, HOLD_REASONS, 'it')) }) },
    { id: 'scrap-dialog', label: 'B-W2a-64 — Scrap this hide: the reason, a photo, the NCR option', model: hideCase('warehouse', freeFull, { writeOff: writeOffDialog(scrapTarget([freeFull], {}, null)) }) },
    { id: 'scrap-held-hold', label: 'B-W2a-64 — Scrap of a hide on hold: held, quality decides it', model: hideCase('quality', onHold, { writeOff: writeOffDialog(scrapTarget([onHold!], HIDE_HOLDS, null)) }) },
    { id: 'remnant', label: 'A remnant back in stock', model: hideCase('owner', remnant) },
    { id: 'consumed', label: 'Consumed: read only (Banner)', model: hideCase('warehouse', consumed) },
    { id: 'quarantine', label: 'Its lot is in quarantine: held, waits for the Cr VI result', model: hideCase('warehouse', quarantined) },
    { id: 'cr-vi-failed', label: 'Its lot failed Cr VI: blocked', model: hideCase('owner', failed) },
    { id: 'cuts', label: 'Cuts: the cut log at a site that records the station only', model: hideCase('warehouse', partly, {}, 'cuts') },
    {
      id: 'cuts-named',
      label: 'Cuts at a site that names workers (inside this one record only)',
      model: hideCase('owner', partly, {}, 'cuts', { ...hideRecordOf(partly), stationOnly: false, cuts: hideRecordOf(partly).cuts.map((cut) => ({ ...cut, cutBy: PEOPLE.marco })) }),
    },
    { id: 'cuts-none', label: 'Cuts: not cut yet', model: hideCase('warehouse', full, {}, 'cuts') },
    { id: 'moves', label: 'Moves of this hide with the running balance', model: hideCase('warehouse', partly, {}, 'moves') },
    { id: 'moves-error', label: "Moves couldn't be read", model: hideCase('warehouse', partly, { moves: { value: null, problem: 'problem.offline' } }, 'moves') },
    { id: 'print', label: 'Print its tag: printer, copies, the tag as it prints', model: hideCase('warehouse', full, { print: printDialog([full!.id]) }) },
    { id: 'print-sent', label: 'Its tag printed', model: hideCase('warehouse', full, { print: printedDialog([full!]) }) },
    { id: 'read-only', label: 'Read-only: Print tag held in words', model: hideCase('readOnly', full) },
    { id: 'loading', label: 'Loading', model: hideCase('warehouse', partly, { record: { status: 'loading' } }) },
    { id: 'not-found', label: 'Not found (or another company)', model: hideCase('warehouse', partly, { record: { status: 'not_found' } }) },
    { id: 'error', label: "The hide couldn't be read", model: hideCase('warehouse', partly, { record: { status: 'error', problem: 'problem.read' } }) },
    { id: 'sales', label: 'Sales: no inventory.stock.view', model: hideCase('sales') },
  ],
})
