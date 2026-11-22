import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { onFloor } from '../../../frame/fixtures'
import type { FloorAsk } from './model'
import { FilesAskedView, type FilesAskedModel } from './view/FilesAskedView'

/**
 * T.1 (order FILES tab, 15-steps; F-OF-204) — the tablet's "Files asked" on My work, made up: photos of step 3 of WO-0041, two days late,
 * asked again once and chased; photos for the work order itself; offline (the camera waits); sent; closed meanwhile; failed. Never a
 * worker's name, never "seen"; the customer by its floor code only.
 */

const ask = (askId: string, over: Partial<FloorAsk>): FloorAsk => ({
  askId,
  words: 'Photos of the collar seam, front and back, before pressing',
  dueOn: '2026-11-20',
  lateDays: 0,
  workOrder: { id: 'wo-41', number: 'WO-0041' },
  step: { id: 'op-3', seq: 3, name: 'Cucitura' },
  customer: 'C-017',
  askedAgain: null,
  chasedAt: null,
  ...over,
})
const ASKS: readonly FloorAsk[] = [
  ask('ask-late', { lateDays: 2, askedAgain: 'The back is missing: one photo of the back seam, please.', chasedAt: '2026-11-21T08:30:00Z' }),
  ask('ask-cutter', { words: 'Photo of the cut panels for size 52 on the table', dueOn: '2026-11-25', step: null }),
]
const model = (over: Partial<FilesAskedModel> = {}): FilesAskedModel => ({ asks: ASKS, online: true, capture: null, busy: false, outcome: null, ...over })

export const designScreen = defineDesignScreen<FilesAskedModel>({
  screen: 'SCR-089-asked',
  title: 'Floor My work › Files asked (order FILES tab, F-OF-204)',
  view: onFloor(FilesAskedView),
  cases: [
    { id: 'asked', label: 'Files asked (2): photos for step 3 of WO-0041 — 2 days late, asked again, an update asked; photos for the work order, due 25 Nov', model: model(), note: 'The most late first; the big "Photo for this ask" on each card; no worker named, no "seen".' },
    { id: 'asked-offline', label: 'Offline: the camera waits (said), the cards stay', model: model({ online: false }) },
    { id: 'asked-sent', label: 'Sent to the office (one card left)', model: model({ asks: ASKS.slice(1), outcome: { askId: 'ask-late', outcome: 'sent' } }) },
    { id: 'asked-closed', label: 'The ask was closed meanwhile: the photo goes on the work order as a note', model: model({ asks: ASKS.slice(1), outcome: { askId: 'ask-late', outcome: 'closed' } }) },
    { id: 'asked-failed', label: 'The photo did not go: try again', model: model({ outcome: { askId: 'ask-late', outcome: 'failed' } }) },
  ],
})
