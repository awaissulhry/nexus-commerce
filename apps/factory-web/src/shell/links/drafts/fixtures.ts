import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../design-data'
import { LinkFrameView } from '../view/LinkFrameView'
import { idleBand, type LinkDraftBand as Band } from './model'
import { LinkDraftBand } from './view/LinkDraftBand'

/**
 * SCR-028-drafts — the link frame's "Finish later" band (design links.frame sec:drafts; B-W2b-169), made-up data only:
 * a long form's link (measurements, the supplier questionnaire, a claim) open until 12 Nov 2026, its draft kept with
 * the sender. Each case is one state of the band; the form itself is the purpose page's (SCR-195, SCR-197 …).
 */

interface DraftCase {
  band: Band
  worthKeeping: boolean
  tooBig?: boolean
}

const UNTIL = '2026-11-12T17:00:00.000Z'
const band = (over: Partial<Band> = {}): Band => ({ ...idleBand(), until: UNTIL, ...over })

function DraftBandDemo({ model }: { model: DraftCase }) {
  return createElement(
    LinkFrameView,
    { model: { sender: { name: DEMO_COMPANIES[0].name }, title: null, body: { kind: 'task' } } },
    createElement(LinkDraftBand, { band: model.band, worthKeeping: model.worthKeeping, tooBig: model.tooBig }),
  )
}

export const designScreen = defineDesignScreen<DraftCase>({
  screen: 'SCR-028-drafts',
  title: 'Link frame: Finish later (a long form’s draft kept with the sender)',
  view: DraftBandDemo,
  cases: [
    { id: 'fresh', label: 'Nothing typed yet: Finish later held with why', model: { band: band(), worthKeeping: false } },
    { id: 'unsaved', label: 'A change not saved yet', model: { band: band({ status: { kind: 'unsaved' } }), worthKeeping: true } },
    { id: 'saving', label: 'Saving with the sender', model: { band: band({ status: { kind: 'saving' } }), worthKeeping: true } },
    { id: 'saved', label: 'Saved 10:42 — finish later from the same link until 12 Nov', model: { band: band({ status: { kind: 'saved', at: '2026-11-09T09:42:00.000Z' } }), worthKeeping: true } },
    { id: 'later', label: 'Finish later pressed: saved, the page may be closed', model: { band: band({ status: { kind: 'saved', at: '2026-11-09T09:42:00.000Z' }, later: true }), worthKeeping: true } },
    {
      id: 'restored',
      label: 'Opened again: the draft restored (Go on · Start again)',
      model: { band: band({ status: { kind: 'saved', at: '2026-11-08T16:05:00.000Z' }, restoredAt: '2026-11-08T16:05:00.000Z' }), worthKeeping: true },
      note: 'GET /link/draft on arrival; the purpose page decides whether its form takes the draft.',
    },
    { id: 'failed', label: 'The save did not reach us: Retry', model: { band: band({ status: { kind: 'failed', count: 1 } }), worthKeeping: true } },
    { id: 'too-big', label: 'The form is larger than a draft may be (180 KiB)', model: { band: band({ status: { kind: 'unsaved' } }), worthKeeping: true, tooBig: true } },
    { id: 'dead', label: 'The link stopped taking drafts (used, expired or withdrawn meanwhile)', model: { band: band({ status: { kind: 'failed', count: 1 }, dead: true }), worthKeeping: true } },
  ],
})
