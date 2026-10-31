import { defineDesignScreen } from '../../design/design-screen'
import { DsWordsLab, type DsWordsLabModel } from './view/DsWordsLab'

/**
 * The DS words lab (`/design/ds-words`, B-W2b-04): every design-system part that speaks, in the gallery's language
 * through `useDsLabels()` (the `ds-words` catalogue as each part's `labels`). Each case opens one dialog; the page's
 * buttons open the rest. Light and dark, 1440 and 390, Italian and English are the gallery's own switches. Made-up data.
 */
export const designScreen = defineDesignScreen<DsWordsLabModel>({
  screen: 'ds-words',
  title: 'DS words in the person’s language (every part that speaks)',
  view: DsWordsLab,
  cases: [
    { id: 'parts', label: 'Every part', model: {}, note: 'Fields, times, files, tags and the edit bar; open the dialogs from their buttons. Drop a .txt on the zone for the refusal.' },
    { id: 'review', label: 'Review: Save held', model: { open: 'review' }, note: 'A change that lets automation do more: Save is held until the box is ticked.' },
    { id: 'review-reading', label: 'Review: reading', model: { open: 'review-reading' }, note: 'Today’s values are re-read before Save.' },
    { id: 'review-done', label: 'Review: done', model: { open: 'review-done' }, note: 'One saved, one refused: the Done line and the results.' },
    { id: 'detail', label: 'Row detail', model: { open: 'detail' }, note: 'Prev held at the first row; J / K move.' },
    { id: 'step-up', label: 'Two-factor code', model: { open: 'step-up' } },
    { id: 'step-up-refused', label: 'Two-factor code: refused', model: { open: 'step-up-refused' } },
    { id: 'confirm', label: 'Typed confirmation', model: { open: 'confirm' }, note: 'Type DEMO-7 and tick the box to arm the button.' },
    { id: 'preferences', label: 'Customise columns', model: { open: 'preferences' }, note: 'Columns, grouping and display tabs.' },
    { id: 'modal', label: 'Plain dialog', model: { open: 'modal' }, note: 'The close button’s name.' },
  ],
})
