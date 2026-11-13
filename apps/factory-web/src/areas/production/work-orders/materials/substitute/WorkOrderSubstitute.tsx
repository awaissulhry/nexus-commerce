'use client'

import { ArrowLeftRight } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Phrase } from '../../../../_shared/stock/model'
import type { SubCan } from '../../../../warehouse/picking/substitute/model'
import { SUB_NAMESPACE } from '../../../../warehouse/picking/substitute/model'
import type { SubstituteActions, SubstituteDialogModel } from '../../../../warehouse/picking/substitute/use-substitute'
import { SubstituteDialog, useSubWords } from '../../../../warehouse/picking/substitute/view/SubstituteDialog'

/**
 * B-W2b-320 — the work order's Materials › Planned materials "Substitute… (W2b)" (design production.workorders wo-materials):
 * the button in the card's head and THE "Use a substitute" dialog of Warehouse › Picking (B-W2b-298's API): first the BOM
 * line, then its choices. Held with why: no inventory.issue, or a work order not open (draft, done, closed, cancelled).
 */

export interface WorkOrderSubstituteModel {
  can: SubCan
  status: string
  dialog: SubstituteDialogModel | null
}
export interface WorkOrderSubstituteActions {
  onOpen?: () => void
  dialog?: SubstituteActions
}

const OPEN_STATUSES = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD']

/** Why Substitute… waits (B-W2b-298 asks it for an open work order only, by the pickers' inventory.issue). */
export function substituteHeld(model: Pick<WorkOrderSubstituteModel, 'can' | 'status'>): Phrase | null {
  if (!model.can.ask) return { key: 'sb.held.noRight' }
  if (!OPEN_STATUSES.includes(model.status)) return { key: 'sb.held.notOpen' }
  return null
}

/** The site's zone of the dates the dialog shows (Europe/Rome, as every office screen by default). */
export function WorkOrderSubstitute({ model, prefix, timeZone = 'Europe/Rome', actions }: { model: WorkOrderSubstituteModel; prefix: string; timeZone?: string; actions?: WorkOrderSubstituteActions }) {
  return (
    <WithMessages namespaces={[SUB_NAMESPACE]}>
      <Body model={model} prefix={prefix} timeZone={timeZone} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, prefix, timeZone, actions }: { model: WorkOrderSubstituteModel; prefix: string; timeZone: string; actions?: WorkOrderSubstituteActions }) {
  const { t, say } = useSubWords()
  return (
    <>
      <Button size="sm" heldReason={say(substituteHeld(model))} onClick={() => actions?.onOpen?.()}>
        <ArrowLeftRight size={13} aria-hidden /> {t('sb.woButton')}
      </Button>
      {model.dialog && <SubstituteDialog model={model.dialog} can={model.can} prefix={prefix} timeZone={timeZone} actions={actions?.dialog} />}
    </>
  )
}
