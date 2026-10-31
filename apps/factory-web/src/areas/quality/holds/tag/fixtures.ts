import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { failedRead, ready, reading } from '../../_shared/model'
import { inShell, ME, NOW, PREFIX } from '../../_shared/fixtures'
import { HOLDS, REASON_WORDS } from '../demo/fixtures'
import { HoldTagsView, type HoldTagsModel } from './view/HoldTagsView'

/** SCR-078-tag — the hold tags on paper (design quality.holds/tab:qh-tag), made-up data only. */

const tags = (over: Partial<HoldTagsModel> = {}): HoldTagsModel => ({
  me: ME,
  person: 'Demo Planner',
  at: NOW,
  addressOf: Object.fromEntries(HOLDS.map((hold) => [hold.id, `https://factory.example${PREFIX}/quality/holds?open=${hold.id}`])),
  holds: ready(HOLDS.slice(0, 1)),
  reasons: REASON_WORDS,
  ...over,
})

function TagsDesign({ model }: { model: HoldTagsModel }) {
  return inShell('/quality/holds', createElement(HoldTagsView, { model }))
}

export const designScreen = defineDesignScreen<HoldTagsModel>({
  screen: 'SCR-078-tag',
  title: 'Hold tag (print page)',
  view: TagsDesign,
  cases: [
    { id: 'one', label: 'One hold: its tag with the QR, the reason, since when, the owner', model: tags(), note: 'A print page stands in for the label PDF (the API has none for a hold yet). Print hides the shell.' },
    { id: 'several', label: 'Several holds (Print tags of the selection)', model: tags({ holds: ready(HOLDS) }) },
    // B-W2b-17: the hold's number on the tag (and in the QR's code line); an older hold says "—".
    { id: 'w2b-number', label: 'W2b The tag says the hold’s number', model: tags({ holds: ready([HOLDS[1]!]) }) },
    { id: 'w2b-number-older', label: 'W2b A hold placed before holds were numbered: "—" on its tag', model: tags({ holds: ready(HOLDS.filter((hold) => hold.number === null)) }) },
    { id: 'loading', label: 'Reading the holds', model: tags({ holds: reading() }) },
    { id: 'error', label: 'The holds could not be read', model: tags({ holds: failedRead('problem.unavailable') }) },
    { id: 'empty', label: 'Nothing to print', model: tags({ holds: ready([]) }) },
  ],
})
