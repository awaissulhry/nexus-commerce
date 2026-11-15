import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../../lib/design/design-screen'
import { inShell } from '../../../../shared/fixtures'
import { ASK, PREFIX, PREVIEW_ARCHIVED, PREVIEW_BOTH_USED, PREVIEW_IN_USE, PREVIEW_MATERIAL, PREVIEW_NOTHING, PREVIEW_OK } from '../../demo'
import type { MergeDialogModel } from '../../model'
import { MergeDialog } from '../../view/MergeDialog'

/**
 * SCR-621 — Merge two records (B-W2b-427; PLT-178): which stays and which is archived, what moves and what stays, why a
 * merge cannot go ahead (and "Keep … instead" when the other way works), the reason; every state. Made-up records.
 */

const model = (extra: Partial<MergeDialogModel> = {}): MergeDialogModel => ({ ask: ASK, preview: PREVIEW_OK, problem: null, busy: false, canMerge: true, prefix: PREFIX, ...extra })

function MergeDesign({ model: given }: { model: MergeDialogModel }) {
  return inShell('/admin/import', createElement(MergeDialog, { model: given }))
}

export const designScreen = defineDesignScreen<MergeDialogModel>({
  screen: 'SCR-621',
  title: 'Merge two records',
  view: MergeDesign,
  cases: [
    { id: 'party', label: 'A customer typed twice: what moves, what stays', model: model(), note: 'Two contacts, the address and the tax identity move; one contact (its e-mail is on the other already) stays on the archived record; the reason is required; Merge is held until it is given.' },
    { id: 'material', label: 'A material typed twice: its colours', model: model({ ask: { recordType: 'MATERIAL', kept: { id: PREVIEW_MATERIAL.kept.id, code: PREVIEW_MATERIAL.kept.code }, dropped: { id: PREVIEW_MATERIAL.dropped.id, code: PREVIEW_MATERIAL.dropped.code } }, preview: PREVIEW_MATERIAL }) },
    { id: 'nothing-moves', label: 'Nothing of its own to move', model: model({ preview: PREVIEW_NOTHING }) },
    { id: 'in-use', label: 'Refused: the duplicate already has orders (keep it instead)', model: model({ preview: PREVIEW_IN_USE }), note: 'Orders and invoices keep the record they were made for: what uses it by kind; the other way works, so "Keep C-0102 instead".' },
    { id: 'both-used', label: 'Refused: both are used (open the other one)', model: model({ preview: PREVIEW_BOTH_USED }), note: 'No swap: the person opens either record (links in a new tab) and keeps using one of them.' },
    { id: 'archived', label: 'Refused: archived, another company', model: model({ preview: PREVIEW_ARCHIVED }) },
    { id: 'no-right', label: 'May see, not merge', model: model({ canMerge: false }), note: 'Merge is held with the reason (the merge right and the right to change both).' },
    { id: 'loading', label: 'Reading what the merge would do', model: model({ preview: null }) },
    { id: 'busy', label: 'Merging', model: model({ busy: true }) },
    { id: 'changed', label: 'Refused at the merge: one changed meanwhile', model: model({ problem: 'dup.problem.conflict' }) },
    { id: 'error', label: 'The preview could not be read', model: model({ preview: null, problem: 'dup.problem.notFound' }) },
  ],
})
