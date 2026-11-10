import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { ANSWER_V2, ANSWER_V3, inShell, MEDIA_SRC, RECORD } from '../demo/fixtures'
import { failed, ready, reading } from '../model'
import { PreviewView, type PreviewModel } from './view/PreviewView'

/**
 * SCR-285-preview — Floor preview (design production.instructions tab:wi-tab-preview, a new tab), made-up data only: the
 * version in force at the tablet's size and density in Italian, in Romanian (a step not written in it falls back, marked),
 * the draft (its banner), loading, no version yet, a failed read, no access.
 */

const base: PreviewModel = { allowed: true, record: ready(RECORD), version: ready(ANSWER_V2), language: 'it', mediaSrc: MEDIA_SRC }

export const designScreen = defineDesignScreen<PreviewModel>({
  screen: 'SCR-285-preview',
  title: 'Work instruction · floor preview',
  view: ({ model }: { model: PreviewModel }) => inShell('/production/instructions', createElement(PreviewView, { model })),
  cases: [
    { id: 'italian', label: 'v2 in force, Italian', model: base, note: 'Picture-first steps, icon, critical point, safety box, the tick before Finish, Read aloud; Seen is the operator\'s (held here).' },
    { id: 'romanian', label: 'v2, Romanian (falls back)', model: { ...base, language: 'ro' }, note: 'Two steps are not written in Romanian: shown in Italian, marked as the tablet marks them.' },
    { id: 'english', label: 'v2, English', model: { ...base, language: 'en' } },
    { id: 'draft', label: 'Draft v3', model: { ...base, version: ready(ANSWER_V3) }, note: 'The draft\'s banner: the floor does not see it until it is approved; the new-version ask as the tablet shows it.' },
    { id: 'loading', label: 'Loading', model: { ...base, version: reading() } },
    { id: 'no-version', label: 'No version yet', model: { ...base, version: null } },
    { id: 'error', label: 'Could not read', model: { ...base, version: failed('problem.unavailable') } },
    { id: 'no-permission', label: 'No access', model: { ...base, allowed: false } },
  ],
})
