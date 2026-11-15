import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell } from '../../shared/fixtures'
import { MATERIAL_PAIRS, PARTY_PAIRS, PREFIX, PREVIEW_IN_USE, PREVIEW_OK } from './demo'
import { DuplicatesSection, type DuplicatesSectionModel } from './view/DuplicatesSection'

/**
 * SCR-620 — Possible duplicates on Admin › Import & export (B-W2b-427; PLT-178; design admin.import "duplicate checks"),
 * with made-up records: the pairs of customers and suppliers or of materials that look alike, the older one first; Merge…
 * per pair (SCR-621) and Merge N after one confirm; every state.
 */

const base = (extra: Partial<DuplicatesSectionModel> = {}): DuplicatesSectionModel => ({
  recordType: 'PARTY',
  types: ['PARTY', 'MATERIAL'],
  scan: { recordType: 'PARTY', pairs: PARTY_PAIRS, more: false, compared: 248 },
  problem: null,
  loading: false,
  prefix: PREFIX,
  canMerge: true,
  selected: [],
  bulk: null,
  notice: null,
  ...extra,
})

function SectionDesign({ model }: { model: DuplicatesSectionModel }) {
  return inShell('/admin/import', createElement('div', { className: 'fw-dup-section' }, createElement(DuplicatesSection, { model })))
}

const [first, second, third] = PARTY_PAIRS

export const designScreen = defineDesignScreen<DuplicatesSectionModel>({
  screen: 'SCR-620',
  title: 'Possible duplicates (Admin › Import & export)',
  view: SectionDesign,
  cases: [
    { id: 'parties', label: 'Customers and suppliers that look alike', model: base(), note: 'The older record first (it usually stays); the reasons in words; Very likely before Possible; a blocked duplicate cannot be ticked and says why. Merge… opens SCR-621.' },
    { id: 'materials', label: 'Materials that look alike', model: base({ recordType: 'MATERIAL', scan: { recordType: 'MATERIAL', pairs: MATERIAL_PAIRS, more: false, compared: 412 } }) },
    { id: 'selected', label: 'Two pairs ticked: Merge 2', model: base({ selected: [first!.key, second!.key] }) },
    {
      id: 'bulk-confirm',
      label: 'Merge 3: one confirm, one left out',
      model: base({
        selected: [first!.key, second!.key, third!.key],
        bulk: {
          pairs: [first!, second!, third!],
          previews: { [first!.key]: PREVIEW_OK, [second!.key]: { ...PREVIEW_OK, kept: { ...PREVIEW_OK.kept, code: 'F-0007' }, dropped: { ...PREVIEW_OK.dropped, code: 'F-0031' } }, [third!.key]: { ...PREVIEW_IN_USE, kept: { ...PREVIEW_IN_USE.kept, code: 'C-0014' }, dropped: { ...PREVIEW_IN_USE.dropped, code: 'C-0120' } } },
          busy: false,
          problem: null,
        },
      }),
      note: 'Each pair previewed; the pair whose duplicate already has orders is left out with why; one reason for all.',
    },
    { id: 'bulk-loading', label: 'Merge 2: reading what each would do', model: base({ selected: [first!.key, second!.key], bulk: { pairs: [first!, second!], previews: { [first!.key]: PREVIEW_OK }, busy: false, problem: null } }) },
    { id: 'merged', label: 'After a merge: the notice', model: base({ notice: { merged: 2, refused: 0, tone: 'success' }, scan: { recordType: 'PARTY', pairs: PARTY_PAIRS.slice(2), more: false, compared: 246 } }) },
    { id: 'partial', label: 'After a merge: some changed meanwhile', model: base({ notice: { merged: 1, refused: 1, tone: 'warning' } }) },
    { id: 'more', label: 'Only the likeliest pairs shown', model: base({ scan: { recordType: 'PARTY', pairs: PARTY_PAIRS, more: true, compared: 5120 } }) },
    { id: 'no-merge-right', label: 'May see, not merge', model: base({ canMerge: false }), note: 'Merge… and the bulk action are held with the reason; no row can be ticked for a merge.' },
    { id: 'parties-only', label: 'Sees customers and suppliers only', model: base({ types: ['PARTY'] }) },
    { id: 'empty', label: 'Nothing looks alike', model: base({ scan: { recordType: 'PARTY', pairs: [], more: false, compared: 248 } }) },
    { id: 'loading', label: 'Loading', model: base({ scan: null, loading: true }) },
    { id: 'error', label: 'Could not be read', model: base({ scan: null, problem: 'dup.problem.busy' }) },
  ],
})
