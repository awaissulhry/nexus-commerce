import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { NOW, PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../../quality/_shared/fixtures'
import { failedRead, ready, reading } from '../../../quality/_shared/model'
import { demoAskReview, demoList, PROFILES, REQUESTS, LEATHER, MEMBRANE } from '../substances/_demo/fixtures'
import { DeclarationsDesign, type DeclarationsCase } from '../substances/_demo/designs/fixtures'
import { toAsk } from '../profiles/model'
import { blankAsk, declarationsAddressOf, declarationsCan, type DeclarationsAddress } from './model'
import type { AskModel, DeclarationsViewModel } from './view-model'

/**
 * SCR-054-declarations — Compliance › Tests & substances › Supplier declarations (B-W2b-267; design compliance.tests
 * sec:ts-decl, sec:ts-views, sec:ts-metrics, pop:ts-request). Made-up suppliers, materials and DEMO-SD-… numbers only. Each case
 * is one state the Owner reviews: the list with the tiles and the view switch, a tile pressed, filters, nothing yet, nothing
 * matching, loading, a failed read, offline, live updates, a selection (Remind N, CSV N), the role cases (quality inspector,
 * read-only with every verb held and why, production manager reads, sales without the right), and the dialogs: Request
 * declarations (form, review per supplier, the result, a refusal), Cancel, Re-request, the keys. The record is SCR-054-declaration.
 */

const TODAY = '2026-10-29'
const address = (over: Partial<DeclarationsAddress> = {}): DeclarationsAddress => ({ ...declarationsAddressOf(null), ...over })
const OPTIONS = PROFILES.map((row) => ({ itemId: row.material.id, code: row.material.code, name: row.material.name, kind: row.material.kind, supplier: row.supplier, missing: toAsk(row) }))

export function declarationsModel(over: Partial<Omit<DeclarationsViewModel, 'frame'>> = {}, role: RoleCase = 'owner', active: DeclarationsCase['active'] = null): DeclarationsCase {
  return {
    role,
    active,
    model: {
      prefix: PREFIX,
      can: declarationsCan([...ROLE_PERMISSIONS[role]]),
      online: true,
      today: TODAY,
      address: address(),
      list: ready(demoList()),
      asOf: NOW,
      live: 'live',
      updates: 0,
      selected: [],
      notice: null,
      record: null,
      ask: null,
      dialog: null,
      busy: false,
      ...over,
    },
  }
}

const ask = (over: Partial<AskModel> = {}): AskModel => ({
  draft: { ...blankAsk(TODAY, [LEATHER.id, MEMBRANE.id], ['REACH_SVHC', 'PFAS']), reminderEveryDays: '7' },
  options: ready(OPTIONS),
  review: null,
  result: null,
  today: TODAY,
  problem: null,
  ...over,
})

const only = (shown: string) => REQUESTS.filter((row) => row.shown === shown)

export const designScreen = defineDesignScreen<DeclarationsCase>({
  screen: 'SCR-054-declarations',
  title: 'Tests & substances › Supplier declarations',
  view: DeclarationsDesign,
  cases: [
    { id: 'list', label: 'Owner: the tiles, the view switch and every request', model: declarationsModel(), note: 'Status is a word with its colour; Due counts down while it waits, or says how late; the file opens on the record’s Answer tab.' },
    { id: 'tile-overdue', label: 'Tile pressed: supplier declarations overdue', model: declarationsModel({ address: address({ shown: 'OVERDUE' }), list: ready(demoList(only('OVERDUE'))) }, 'owner', 'declarationsOverdue') },
    { id: 'tile-rerequest', label: 'Tile pressed: to ask again — the SVHC list grew', model: declarationsModel({ address: address({ shown: 'REREQUEST_NEEDED' }), list: ready(demoList(only('REREQUEST_NEEDED'))) }, 'owner', 'rerequest') },
    { id: 'filter-kind', label: 'Kind ▾ PFAS-free and a search', model: declarationsModel({ address: address({ kind: 'PFAS', q: 'membrane' }), list: ready(demoList(REQUESTS.filter((row) => row.kind === 'PFAS'))) }) },
    { id: 'filtered-empty', label: 'No request matches these filters', model: declarationsModel({ address: address({ q: 'zzz' }), list: ready(demoList([])) }) },
    { id: 'empty', label: 'First day: no declaration requested yet', model: declarationsModel({ list: ready(demoList([], { open: 0, overdue: 0, answered: 0, rerequest: 0, expired: 0 })) }) },
    { id: 'loading', label: 'Loading', model: declarationsModel({ list: reading(), asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer", model: declarationsModel({ list: failedRead('problem.unavailable'), asOf: null, live: 'offline' }), note: 'Never drawn as an empty list: the problem in words with Try again.' },
    { id: 'offline', label: 'Offline: rows stay readable, every write held with why', model: declarationsModel({ online: false, live: 'offline', selected: [REQUESTS[1]!.id] }) },
    { id: 'live-updates', label: 'Live: an answer came in the portal — 1 update behind Show', model: declarationsModel({ updates: 1 }), note: 'compliance_material_tests.declaration_answered (portal) → the rows; they never move under the cursor.' },
    { id: 'selected', label: 'Selection: Remind 1 of 3 (only the waiting one) and CSV of 3', model: declarationsModel({ selected: [REQUESTS[1]!.id, REQUESTS[2]!.id, REQUESTS[4]!.id] }) },
    { id: 'notice', label: 'A receipt after a reminder', model: declarationsModel({ notice: { key: 'done.reminded', params: { count: 1 }, tone: 'success' } }) },
    { id: 'keyboard', label: 'Keyboard: j / k, x, c Request declarations, 1–4 switch the view', model: declarationsModel({ focusRow: 1 }) },
    { id: 'inspector', label: 'Quality inspector: asks, reminds, decides', model: declarationsModel({}, 'inspector') },
    { id: 'read-only', label: 'Read-only: sees every request, every verb held with its reason', model: declarationsModel({ selected: [REQUESTS[1]!.id] }, 'readOnly') },
    { id: 'production', label: 'Production manager: reads (no lot tiles: no quality.lots.view)', model: declarationsModel({}, 'production') },
    { id: 'no-permission', label: 'Sales: no permission (says which one and who gives it)', model: declarationsModel({}, 'sales') },
    { id: 'ask-form', label: 'Request declarations: materials, kinds, due day, cadence, channel', model: declarationsModel({ ask: ask() }) },
    { id: 'ask-empty', label: 'Request declarations: nothing chosen yet (Review held with why)', model: declarationsModel({ ask: ask({ draft: blankAsk(TODAY) }) }) },
    { id: 'ask-loading', label: 'Request declarations: the materials still reading', model: declarationsModel({ ask: ask({ options: reading() }) }) },
    { id: 'ask-review', label: 'Review per supplier: send, add to a waiting one, skip with why', model: declarationsModel({ ask: ask({ draft: { ...ask().draft, step: 'review' }, review: ready(demoAskReview()) }) }), note: 'Nothing has gone out yet: the review is a dry run.' },
    { id: 'ask-review-nothing', label: 'Review: everything skipped (Send held)', model: declarationsModel({ ask: ask({ draft: { ...ask().draft, step: 'review' }, review: ready({ ...demoAskReview(), counts: { send: 0, add: 0, skip: 1 }, groups: demoAskReview().groups.slice(3) }) }) }) },
    { id: 'ask-done', label: 'Sent: a result per supplier with the new numbers', model: declarationsModel({ ask: ask({ draft: { ...ask().draft, step: 'done' }, review: ready(demoAskReview()), result: demoAskReview(true) }) }) },
    { id: 'ask-refused', label: 'Send refused: nothing went out', model: declarationsModel({ ask: ask({ draft: { ...ask().draft, step: 'review' }, review: ready(demoAskReview()), problem: 'problem.ask.failed' }) }) },
    { id: 'ask-read-only', label: 'Request declarations held for a read-only person', model: declarationsModel({ ask: ask() }, 'readOnly') },
    { id: 'cancel', label: 'Cancel a waiting request: the reason', model: declarationsModel({ dialog: { kind: 'cancel', id: REQUESTS[1]!.id, reason: 'Supplier changed.' } }) },
    { id: 'ask-again', label: 'Re-request after the Candidate List grew', model: declarationsModel({ dialog: { kind: 'askAgain', id: REQUESTS[4]!.id, dueOn: '2026-11-30', reminderEveryDays: '7', message: '' } }) },
    { id: 'keys', label: 'The keys (?)', model: declarationsModel({ dialog: { kind: 'keys' } }) },
  ],
})
