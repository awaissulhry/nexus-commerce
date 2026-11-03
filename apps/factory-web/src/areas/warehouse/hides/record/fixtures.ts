import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { HideRow } from '../../../_shared/stock/api'
import { canFor, inShell, NOW, PREFIX, PEOPLE, ROLE_PERMISSIONS, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { phrase } from '../../../_shared/stock/model'
import { PART_LOADING, part } from '../../lots/shared/model'
import { HIDE_HOLDS, HIDE_ROWS, hideMoves, hideRecordOf, printDialog, printedDialog } from '../demo/fixtures'
import { dailyFor, HOLD_REASONS, reserveDialog, writeOffDialog } from '../../lots/demo/daily/fixtures'
import { reserveHides, scrapTarget } from '../../lots/shared/daily'
import type { HideRecordModel, HideTab } from '../model'
import { HIDE_PHOTOS, lightboxOn, recordPhotos, UPLOADING } from '../photos/fixtures'
import { gradingModel, gradingOf, GRADES, measuresOf } from './grading/fixtures'
import { draftOf, EMPTY_MEASURE } from './grading/grading-model'
import { HideRecordView } from './view/HideRecordView'

/**
 * SCR-200-record — one hide with made-up data only: a hide partly cut at the cutting table (its area in one bar: cut,
 * at the work order; its cuts with one entered twice and reversed), a full hide ready to cut, a remnant, a consumed hide
 * (read only), a hide of a lot in quarantine (held with the lot's reason), a hide of a lot whose Cr VI failed; the Cuts
 * tab at a site that records stations only and at one that names workers (inside this one record only); the Moves tab;
 * the tag's print dialog and its job; the states. B-W2a-64: a hide reserved for a work order (the next step links it),
 * one whose reservation's work order is done (release it), one on hold by its own quality hold (the reason in words),
 * Reserve and Scrap from the band (each held with its reason), their dialogs. Roles: Owner, Warehouse, Quality, Read-only,
 * Sales (no inventory.stock.view). B-W2b-131: Measurements & grade (the form with the usable area per grade, a change
 * waiting with Apply, a reason asked after a cut, a stale version refused, read only for a consumed hide or a role without
 * the right, an ungraded hide, the measures with Measure again… and Correct the area…, each held with its reason) and
 * Defects & photos (the defects, three photos from the cutting table, an inspection and the office, none yet, no files.read,
 * the Lightbox on photo 2 of 3, photos being added).
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
      grading: gradingModel(ROLE_PERMISSIONS[role], row),
      photos: recordPhotos(row.id),
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
const withDefects = { ...HIDE_ROWS[5]!, reservedFor: null }
const WAREHOUSE = ROLE_PERMISSIONS.warehouse
/** B-W2b-131: the grade tab with what differs in the form (a draft, a dialog, a refusal). */
const gradeCase = (role: RoleCase, row: HideRow = freeFull, grading: Parameters<typeof gradingModel>[2] = {}, view = gradingOf(row)) =>
  hideCase(role, row, { grading: gradingModel(ROLE_PERMISSIONS[role], row, grading, view) }, 'grade')
const viewOfFull = gradingOf(freeFull)
const partlyView = gradingOf(partly!)
const ungraded = gradingOf(freeFull, { grade: null, gradeText: null, usable: null, estimates: gradingOf(freeFull).estimates.map((entry) => ({ ...entry, current: false })), changes: [] })

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
    { id: 'grade', label: 'B-W2b-131 — Measurements & grade: grade B, shade 1, thickness; the usable area per grade; changes; measures', model: gradeCase('warehouse') },
    { id: 'grade-dirty', label: 'B-W2b-131 — Grade changed to A: 1 change waiting, Apply ready (⌘S)', model: gradeCase('warehouse', freeFull, { gradeDraft: { ...draftOf(viewOfFull, 'it'), gradeId: GRADES[0]!.id } }) },
    {
      id: 'grade-reason',
      label: 'B-W2b-131 — A hide cut already: the change asks why (Apply held until it is said)',
      model: gradeCase('warehouse', partly, { gradeDraft: { ...draftOf(partlyView, 'it'), gradeId: GRADES[2]!.id } }, partlyView),
    },
    {
      id: 'grade-refused',
      label: 'B-W2b-131 — Refused: someone changed the hide meanwhile (our words, read again)',
      model: gradeCase('warehouse', freeFull, { gradeDraft: { ...draftOf(viewOfFull, 'it'), thicknessMm: '1,30' }, problem: { tab: 'grade', phrase: phrase('hd.grading.refused.stale') }, changedMeanwhile: true }),
    },
    { id: 'grade-read-only', label: 'B-W2b-131 — Consumed: read only (Banner), no Measure again', model: gradeCase('warehouse', consumed, {}, gradingOf(consumed!)) },
    { id: 'grade-no-manage', label: 'B-W2b-131 — Read-only role: grade and shade as text, Measure again held in words', model: gradeCase('readOnly') },
    { id: 'grade-ungraded', label: 'B-W2b-131 — Ungraded: its usable area is unknown; the estimate at each grade it may be given', model: gradeCase('warehouse', freeFull, {}, ungraded) },
    { id: 'measures', label: 'B-W2b-131 — Owner: measures (short beyond the 5 % tolerance, within), Correct the area… open', model: gradeCase('owner') },
    {
      id: 'remeasure-dialog',
      label: 'B-W2b-131 — Measure again: measured and tannery area in ft², a note',
      model: gradeCase('warehouse', freeFull, { measure: { correcting: false, draft: { ...EMPTY_MEASURE, measuredArea: '51,2', declaredArea: '52' }, posting: false, problem: null, done: null } }),
    },
    {
      id: 'correct-area',
      label: 'B-W2b-131 — Correct the area…: the measure with the stock corrected (an adjustment move)',
      model: gradeCase('owner', freeFull, { measure: { correcting: true, draft: { ...EMPTY_MEASURE, measuredArea: '48', correctStock: true, correctNote: 'Rimisurata al pantografo' }, posting: false, problem: null, done: null } }),
    },
    {
      id: 'remeasure-done',
      label: 'B-W2b-131 — Measured: 7.69 % short, the stock corrected by 4 ft² out',
      model: gradeCase('owner', freeFull, { measure: { correcting: true, draft: { ...EMPTY_MEASURE, measuredArea: '48', correctStock: true }, posting: false, problem: null, done: { measure: measuresOf(freeFull).measures[0]!, move: { id: freeFull.id, direction: 'OUT', quantity: '4.0000', uom: 'FT2' } } } }),
    },
    { id: 'remeasure-held', label: 'B-W2b-131 — A hide cut already: Measure again and Correct the area held (only a whole hide is measured)', model: gradeCase('warehouse', partly, {}, partlyView) },
    { id: 'quality-no-adjust', label: 'B-W2b-131 — Quality: measures again, Correct the area held (no inventory.adjust)', model: gradeCase('quality') },
    { id: 'defects', label: 'B-W2b-131 — Defects & photos: the defects in words; photos from the cutting table, an inspection and the office', model: hideCase('warehouse', withDefects, {}, 'defects') },
    {
      id: 'defects-dirty',
      label: 'B-W2b-131 — Defects being written: Apply ready',
      model: hideCase('warehouse', withDefects, { grading: gradingModel(WAREHOUSE, withDefects, { defectsDraft: { ...draftOf(gradingOf(withDefects), 'it'), defects: 'Due fori di zecca vicino alla schiena; vena sul collo; graffio sul fianco destro' } }) }, 'defects'),
    },
    { id: 'defects-empty', label: 'B-W2b-131 — No photos yet: Add a photo', model: hideCase('warehouse', freeFull, { photos: recordPhotos(freeFull.id, {}, []) }, 'defects') },
    { id: 'defects-no-files', label: 'B-W2b-131 — Without files.read: the photos say why', model: hideCase('warehouse', withDefects, { grading: gradingModel(WAREHOUSE.filter((permission) => permission !== 'files.read'), withDefects) }, 'defects') },
    { id: 'defects-read-only', label: 'B-W2b-131 — Read-only role: defects as text, Add a photo held in words', model: hideCase('readOnly', withDefects, {}, 'defects') },
    { id: 'photo-lightbox', label: 'B-W2b-131 — Hide photo: the Lightbox on photo 2 of 3 (where and when)', model: hideCase('warehouse', withDefects, { photos: recordPhotos(withDefects.id, { lightbox: lightboxOn(withDefects.id, withDefects.code, 1) }) }, 'defects') },
    { id: 'photo-uploading', label: 'B-W2b-131 — Photos being added: one sending, one refused (not an image)', model: hideCase('owner', withDefects, { photos: recordPhotos(withDefects.id, { uploads: UPLOADING }, HIDE_PHOTOS.slice(0, 1)) }, 'defects') },
    { id: 'grade-loading', label: 'B-W2b-131 — Measurements & grade: loading', model: gradeCase('warehouse', freeFull, { view: PART_LOADING, measures: PART_LOADING, gradeDraft: null, defectsDraft: null }) },
    { id: 'grade-error', label: "B-W2b-131 — Measurements & grade couldn't be read", model: gradeCase('warehouse', freeFull, { view: { value: null, problem: 'problem.offline' }, gradeDraft: null, defectsDraft: null }) },
  ],
})
