import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { PREFIX } from '../../../library/demo'
import { canOf, NOW, SUIT, SUIT_RULES } from '../demo/fixtures'
import { draftsOf, newPointDraft, type PointDraft } from '../model'
import { TemplateRecordView, type TemplateRecordModel } from './view/TemplateRecordView'

/**
 * SCR-049-template — a measurement template (B-W1-17, B-W2b-362) — made-up data only: an invented race suit's 10 points in
 * measuring order (one archived), its made-to-measure rules (off as built: GATE-MTM), where it is used. Role cases: the Owner
 * (may start made-to-measure), a product developer (keeps the points; the switch held with why), sales (reads).
 */

const base: TemplateRecordModel = {
  prefix: PREFIX,
  can: canOf('owner'),
  tab: 'points',
  template: { status: 'ready', value: SUIT },
  rules: { value: SUIT_RULES, problem: null },
  edit: null,
  dialog: null,
  notice: null,
  changed: null,
  busy: false,
}

const drafts = draftsOf(SUIT)
const edited: PointDraft[] = [...drafts.slice(0, 8), { ...newPointDraft(), key: 'new-design-1', code: 'shoulder', name: 'Shoulder', nameIt: 'Spalla', min: '35', max: '60' }, drafts[9]!]
const broken: PointDraft[] = [...drafts.slice(0, 3), { ...drafts[3]!, min: '150', max: '70' }, { ...newPointDraft(), key: 'new-design-2', code: 'chest', name: '' }, ...drafts.slice(4)]
const off = { ...SUIT_RULES, template: { ...SUIT_RULES.template, rulesOn: false } }
const on = { ...SUIT_RULES, template: { ...SUIT_RULES.template, rulesOn: true } }

export const designScreen = defineDesignScreen<TemplateRecordModel>({
  screen: 'SCR-049-template',
  title: 'Measurement template',
  view: TemplateRecordView,
  cases: [
    { id: 'points', label: 'Points (Owner)', model: base, note: '10 points in measuring order, their Italian and English names, units (the wrist in mm), plausible ranges, how to measure; one archived point said under the table.' },
    { id: 'points-edit', label: 'Points: editing', model: { ...base, edit: { drafts: edited, busy: false, refused: {} } }, note: 'A new point added (its code may change), the knee taken out (Save says it is archived, kept), ↑ ↓ held at the ends; the DS EditModeBar with the count.' },
    { id: 'points-edit-held', label: 'Points: Save held', model: { ...base, edit: { drafts: broken, busy: false, refused: {} } }, note: 'Hips min above max, a new point named "chest" (twice) without a name: Save held with how many points need a fix.' },
    { id: 'points-refused', label: 'Points: refused by the rules', model: { ...base, edit: { drafts: edited, busy: false, refused: {} }, notice: { key: 'problem.rulesNeedPoints', tone: 'danger' } }, note: 'The template\'s made-to-measure rules still need a point as it was.' },
    { id: 'preview', label: 'Preview as the fitter\'s form', model: { ...base, preview: { values: { height: '182', chest: '160', waist: '84' }, confirmed: [] } }, note: 'Sales › Made-to-measure\'s own form: chest 160 asked again ("check it") until "I checked it".' },
    { id: 'read-only', label: 'Points: sales (reads)', model: { ...base, can: canOf('sales') }, note: 'Edit held with its reason; the info banner says why.' },
    { id: 'mtm-off-owner', label: 'Made-to-measure off (Owner)', model: { ...base, tab: 'mtm', rules: { value: off, problem: null } }, note: 'Off in words, Start made-to-measure offered; the rules read in the reader\'s language.' },
    { id: 'mtm-off-no-right', label: 'Made-to-measure off (product developer)', model: { ...base, can: canOf('developer'), tab: 'mtm', rules: { value: { ...off, switchable: false }, problem: null } }, note: 'Start held: only the Owner starts made-to-measure.' },
    { id: 'mtm-on', label: 'Made-to-measure on', model: { ...base, template: { status: 'ready', value: { ...SUIT, rulesOn: true } }, tab: 'mtm', rules: { value: on, problem: null } } },
    { id: 'mtm-switch', label: 'Start made-to-measure: the question', model: { ...base, tab: 'mtm', rules: { value: off, problem: null }, dialog: { kind: 'switch', on: true, reason: 'First made-to-measure order of the race suit.', problem: null } } },
    { id: 'mtm-loading', label: 'Made-to-measure: loading', model: { ...base, tab: 'mtm', rules: { value: null, problem: null } } },
    { id: 'mtm-error', label: 'Made-to-measure: could not load', model: { ...base, tab: 'mtm', rules: { value: null, problem: 'problem.unavailable' } } },
    { id: 'whereused', label: 'Where used', model: { ...base, tab: 'whereused' } },
    { id: 'whereused-empty', label: 'Where used: not yet', model: { ...base, tab: 'whereused', template: { status: 'ready', value: { ...SUIT, styles: { measured: 0, madeToMeasure: 0 }, profiles: 0 } } } },
    { id: 'archive', label: 'Archive: held', model: { ...base, dialog: { kind: 'archive', problem: null } }, note: '3 styles are measured with it: Archive held with why.' },
    { id: 'archived', label: 'Archived', model: { ...base, template: { status: 'ready', value: { ...SUIT, status: 'ARCHIVED', styles: { measured: 0, madeToMeasure: 0 } } } }, note: 'Edit held (restore it first); ⋯ Restore.' },
    { id: 'rename', label: 'Rename', model: { ...base, dialog: { kind: 'rename', name: 'Race suit (one piece)', problem: null } } },
    { id: 'saved', label: 'Just saved', model: { ...base, notice: { key: 'points.done', tone: 'success' } } },
    { id: 'changed', label: 'Changed meanwhile', model: { ...base, changed: { at: NOW } } },
    { id: 'loading', label: 'Loading', model: { ...base, template: { status: 'loading' } } },
    { id: 'error', label: 'Could not load', model: { ...base, template: { status: 'error', problem: 'problem.unavailable' } } },
    { id: 'not-found', label: 'Not found', model: { ...base, template: { status: 'notFound' } } },
    { id: 'no-permission', label: 'No access', model: { ...base, can: { view: false, manage: false, switch: false }, template: { status: 'forbidden' } } },
  ],
})
