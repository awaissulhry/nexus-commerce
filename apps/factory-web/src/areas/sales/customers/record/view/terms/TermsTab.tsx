'use client'

import { WithMessages } from '../../../../../../record-panels/i18n'
import { HoldDialogView, type HoldCardActions, type HoldCardModel } from '../../../depth/view/HoldCard'
import { RequirementWindows, type RequirementsActions, type RequirementsModel } from '../../../depth/view/RequirementsTab' // F-CT-507 (W2.1)
import type { TermsChipId } from '../../terms/answer'
import { TERMS_TAB_NAMESPACES } from '../../terms/model'
import type { TermsTabActions, TermsTabModel } from '../../terms/tab'
import { ChangeTermsDialog } from './ChangeTermsDialog'
import { CommercialSection } from './CommercialSection'
import { CompanyEndDialog, CompanyTermsDialog } from './CompanyTermsDialog'
import { DeliveryDialog } from './DeliveryDialog'
import { HoldSection } from './HoldSection'
import { IdentitySection } from './IdentitySection' // F-CT-518 (W2.2)
import { RequirementsSection } from './RequirementsSection' // F-CT-507 (W2.1)
import { TermsAnswer } from './TermsAnswer'
import { CustomerStructurePart } from '../../../../../production/order-structures/parts/CustomerStructurePart' // owb-b5 (w5.5): S3's slot (owb-ss8)
import './terms.css'

/**
 * F-CT-309 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §1, §2, §8; 18-lead-settles Z10, Z21) — the tab's LAYOUT, and
 * only that. Its root is the Production kit's size container and ours (`fw-pt fw-ctr`: every part chooses its columns by the ROOM it
 * has, never the screen, so the thread dock re-lays it at once). The answer line on top, then the sections STACK at every room: Hold
 * (#party-hold, ALWAYS first) · Commercial terms (#party-commercial) — today's Requirements and Tax identity cards stand under them
 * until ct-w2. The windows open here in place: the depth provider's hold window (HoldDialogView, the one Money opens — mounted as it
 * is, never copied) and the four NEW ones. Draws its model; reads nothing.
 */

export interface TermsTabProps {
  /** null: the party is still read (the answer line reads). */
  readonly model: TermsTabModel | null
  readonly actions?: TermsTabActions | undefined
  /** The depth provider's hold window (its model and acts, as they are); null: not mounted. */
  readonly hold?: { readonly model: HoldCardModel; readonly actions?: HoldCardActions | undefined } | null | undefined
  /** F-CT-507: the depth provider's requirement windows (their model and acts, as they are); null: not mounted. */
  readonly requirements?: { readonly model: RequirementsModel; readonly actions?: RequirementsActions | undefined } | null | undefined
  /** owb-b5 (w5.5): the company the page works in (the session's), for S3's slot "How its orders are handled"; null: the slot waits. */
  readonly companyId?: string | null | undefined
}

export function TermsTab(props: TermsTabProps) {
  return (
    <WithMessages namespaces={TERMS_TAB_NAMESPACES}>
      <TermsTabBody {...props} />
    </WithMessages>
  )
}

function TermsTabBody({ model, actions, hold, requirements, companyId }: TermsTabProps) {
  if (!model)
    return (
      <div className="fw-pt fw-ctr">
        <TermsAnswer answer={null} chip={null} reading />
      </div>
    )
  // A chip opens its section at once and marks exactly its rows (pressed again: the mark leaves); a door chip leaves the tab.
  const onChip = (chip: TermsChipId | null) => {
    actions?.onChip?.(chip)
    const found = chip ? model.answer.chips.find((entry) => entry.id === chip) : null
    // Its first row, else its section (today's identity card has no rows of its own until ct-w2).
    if (found && !found.door && typeof document !== 'undefined') requestAnimationFrame(() => (document.getElementById(found.rows[0] ?? '') ?? document.getElementById(found.section))?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }
  const open = model.windows.window
  return (
    <div className="fw-pt fw-ctr">
      <TermsAnswer answer={model.answer} chip={model.chip} reading={model.answerReading} onChip={onChip} />
      <HoldSection model={model} actions={actions} />
      <CommercialSection model={model} actions={actions} />
      <RequirementsSection model={model} actions={actions} />
      <IdentitySection model={model} actions={actions} />
      {/* owb-b5 (w5.5; design rec.js customer › terms): "How its orders are handled", last (S3 fills it; nothing until then). */}
      {companyId ? <CustomerStructurePart companyId={companyId} partyId={model.partyId} /> : null}
      {hold ? <HoldDialogView model={hold.model} actions={hold.actions} /> : null}
      {requirements ? <RequirementWindows model={requirements.model} actions={requirements.actions} /> : null}
      {open?.kind === 'terms' ? <ChangeTermsDialog window={open} windows={model.windows} actions={actions} /> : null}
      {open?.kind === 'delivery' ? <DeliveryDialog window={open} windows={model.windows} actions={actions} /> : null}
      {open?.kind === 'company' ? <CompanyTermsDialog window={open} windows={model.windows} actions={actions} /> : null}
      {open?.kind === 'end' ? <CompanyEndDialog window={open} windows={model.windows} actions={actions} /> : null}
    </div>
  )
}
