import { defineDesignScreen } from '../design-screen'
import { DsQualityLab, type DsQualityLabModel } from './view/DsQualityLab'

/**
 * The quality and floor parts lab (`/design/ds-quality-parts`, B-W2b-78): GateExplainer (full, compact, popover, list),
 * SignOffPanel, LimitMeter and ToleranceCell at the console's size; FloorChecklist, a gate line and a PIN sign-off on the
 * floor tier — in the gallery's language through `useDsLabels()`. Light and dark, 1440 and 390, Italian and English are
 * the gallery's own switches. Made-up data.
 */
export const designScreen = defineDesignScreen<DsQualityLabModel>({
  screen: 'ds-quality-parts',
  title: 'Quality and floor DS parts (B-W2b-78)',
  view: DsQualityLab,
  cases: [
    { id: 'parts', label: 'Every part', model: {}, note: 'Every part working: answer the checklist (Fail asks a reason, then a photo), open the gate’s popover, release as the second person, sign on the floor with the PIN 246810.' },
    { id: 'gate-unknown', label: 'Gate: a result not in yet', model: { show: 'office', gate: 'unknown' }, note: 'Held too: the gate never lets through what it cannot see.' },
    { id: 'gate-open', label: 'Gate: clear', model: { show: 'office', gate: 'open', signoff: 'other' }, note: 'Every check met; nothing blocking; the release may be signed.' },
    { id: 'gate-frozen', label: 'Gate: as it stood at release', model: { show: 'office', gate: 'frozen', signoff: 'done' }, note: 'The frozen answer: no override, the time it was true.' },
    { id: 'gate-none', label: 'Gate: nothing listed', model: { show: 'office', gate: 'none' }, note: 'No checks listed is never a free pass.' },
    { id: 'signoff-rejected', label: 'Sign-off: rejected', model: { show: 'office', signoff: 'rejected' } },
    { id: 'checklist-partly', label: 'Checklist: part answered', model: { show: 'floor', checklist: 'partly' }, note: 'A failed check with its reason and photo; the main action held with what is left.' },
    { id: 'checklist-done', label: 'Checklist: every check answered', model: { show: 'floor', checklist: 'done' } },
    { id: 'checklist-held', label: 'Checklist: held', model: { show: 'floor', checklist: 'held' }, note: 'Every button held, the reason on screen.' },
    { id: 'checklist-empty', label: 'Checklist: no checks', model: { show: 'floor', checklist: 'empty' } },
  ],
})
