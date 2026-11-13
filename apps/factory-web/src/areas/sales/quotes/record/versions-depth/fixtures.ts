import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { COMPARED, VERSIONS } from '../lines-depth/fixtures'
import { CompareVersions, type CompareVersionsModel } from './view/CompareVersions'

/**
 * SCR-415 — Compare versions (design pop:quotes.compare, SAL-158; B-W2b-316 on B-W2b-302's compare), made-up data only: version 1
 * (sent) against version 2 (a draft that adds the red colourway, a delivery and a target price). Each case is one state: the
 * Owner with prices, a role without prices, the note used, a sent current version (the note held), two equal versions,
 * loading, an error.
 */

const VERSION_HEADS = VERSIONS.map((entry) => ({ revision: entry.revision, status: entry.status, sentAt: entry.sentAt }))
const model = (extra: Partial<CompareVersionsModel> = {}): CompareVersionsModel => ({ from: 1, to: 2, versions: VERSION_HEADS, state: { status: 'ready', value: COMPARED }, noteHeld: null, noteSaving: false, noteDone: false, ...extra })
const same = { ...COMPARED, sections: COMPARED.sections.map((section) => ({ ...section, lines: section.lines.map((line) => ({ ...line, after: line.before })).filter((line) => line.before), totals: section.totals.map((total) => ({ ...total, after: total.before })), summary: { added: 0, removed: 0, changed: 0, unchanged: 1 } })), prices: undefined, differs: [] }

export const designScreen = defineDesignScreen<CompareVersionsModel>({
  screen: 'SCR-415',
  title: 'Compare versions (quote): terms, lines per size, prices, use as change note',
  view: CompareVersions,
  cases: [
    { id: 'owner', label: 'Owner · Version 1 → 2: terms, lines, prices', model: model(), note: 'One VersionCompare per section that differs; totals before → after; Use as change note fills the draft\'s What changed.' },
    { id: 'no-prices', label: 'A role without prices: pieces and terms only', model: model({ state: { status: 'ready', value: { ...COMPARED, prices: undefined } } }) },
    { id: 'note-done', label: 'The note went into the draft', model: model({ noteDone: true }) },
    { id: 'note-held', label: 'The current version is sent: the note is held', model: model({ noteHeld: { key: 'compare.held.notDraft', params: { next: 3 } } }) },
    { id: 'same', label: 'Two versions that are the same', model: model({ state: { status: 'ready', value: same } }) },
    { id: 'pick-two', label: 'The same version picked twice', model: model({ from: 2, to: 2 }) },
    { id: 'loading', label: 'Comparing', model: model({ state: { status: 'loading' } }) },
    { id: 'error', label: 'The compare could not be read', model: model({ state: { status: 'error', problem: 'problem.read.unavailable' } }) },
  ],
})
