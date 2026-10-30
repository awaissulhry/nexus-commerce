import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as reasonEditor } from '../../../_shared/reasons/fixtures'
import type { ReasonListsModel } from '../../../_shared/reasons/view/ReasonListsView'
import { ReasonListsView } from '../../../_shared/reasons/view/ReasonListsView'
import { base, inShell, WORKER_SITE, type Role } from '../fixtures'
import { FloorRulesView, type FloorRulesModel } from '../view/FloorRulesView'

/**
 * Design cases of SCR-088 — Production › Settings › Floor rules & codes › Reason codes (B-W2a-46; design
 * production.settings fr-reasons, fr-newcode): the page's Reason codes tab with the shared reason list editor (B-W2a-18,
 * SCR-242) mounted in it — pause, scrap, rework, downtime, help-call, adjustment, hold and cancel reasons, words per
 * language, icon and colour, active, used count, saved per cell; a used code is set inactive, never deleted. Made-up data
 * only (the editor's own design cases). Roles from factory-domain's templates: the production manager and the Owner keep
 * the lists (reasons.manage), the floor supervisor looks (reasons.view), a role without reasons.view is told so.
 */

interface CodesCase {
  role: Role
  page: FloorRulesModel
  editor: ReasonListsModel | null
}

const editorCase = (id: string): ReasonListsModel => {
  const found = reasonEditor.cases.find((entry) => entry.id === id)
  if (!found) throw new Error(`SCR-242 has no case ${id}`)
  return found.model
}

const codes = (role: Role, editor: string | null, over: Partial<FloorRulesModel> = {}): CodesCase => ({ role, page: base(role, WORKER_SITE, over, 'codes').model, editor: editor ? editorCase(editor) : null })

function CodesDesign({ model }: { model: CodesCase }) {
  const slot = model.editor ? createElement(ReasonListsView, { model: model.editor }) : null
  return inShell(createElement(FloorRulesView, { model: model.page, codes: slot }), model.role)
}

export const designScreen = defineDesignScreen<CodesCase>({
  screen: 'SCR-088',
  title: 'Reason codes (Production › Settings › Floor rules & codes)',
  view: CodesDesign,
  cases: [
    { id: 'pause', label: 'Production manager: the pause list — words per language, icon, colour, active, used count', model: codes('production', 'floor-rules'), note: 'The list switch holds pause, scrap, rework, downtime, help calls, adjustments, holds and cancellations. Break is inactive (never deleted).' },
    { id: 'saving', label: 'Saved per cell (its own mark)', model: codes('production', 'saving') },
    { id: 'selected', label: 'Rows selected: Set N inactive · Set N active · Move up · Move down', model: codes('production', 'selected') },
    { id: 'new-reason', label: 'New reason code (fr-newcode)', model: codes('owner', 'new-reason') },
    { id: 'new-reason-taken', label: 'New reason: a code already taken, in words', model: codes('owner', 'new-reason-taken') },
    { id: 'look', label: 'Icon and colour of one reason', model: codes('production', 'look') },
    { id: 'scrap', label: 'Scrap reasons of the operation screen: words only', model: codes('production', 'scrap') },
    { id: 'standard-missing', label: 'Standard reasons missing: Add N standard reasons', model: codes('production', 'standard-missing') },
    { id: 'empty', label: 'A list with no reason yet: Add the first reason', model: codes('production', 'empty') },
    { id: 'read-only', label: 'Floor supervisor: may only look (held with its reason)', model: codes('supervisor', 'read-only') },
    { id: 'changed-elsewhere', label: 'Changed by someone else: Reload', model: codes('production', 'changed-elsewhere') },
    { id: 'offline', label: 'Offline while saving: the value before is put back, in words', model: codes('production', 'offline') },
    { id: 'loading', label: 'Loading', model: codes('production', 'loading') },
    { id: 'error', label: 'The read failed: in words, Try again', model: codes('production', 'error') },
    { id: 'no-permission', label: 'No reasons.view: the page says so', model: codes('supervisor', null, { can: { view: true, manage: false, reasons: false, privacy: false } }) },
    { id: 'keys', label: 'The keys (the footer’s information icon)', model: codes('production', 'keys') },
  ],
})
