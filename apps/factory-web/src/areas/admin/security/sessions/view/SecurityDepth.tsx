'use client'

import { WithMessages } from '../../../../../record-panels/i18n'
import type { StepUpModel } from '../../../shared/model'
import { SecurityEventsCard, type SecurityEventsActions, type SecurityEventsModel } from '../../events/view/SecurityEventsCard'
import { FreshCode } from '../../step-up/view/FreshCode'
import { StepUpActionsCard, type StepUpActionsActions, type StepUpActionsModel } from '../../step-up/view/StepUpActionsCard'
import { SessionLengthsCard, type SessionLengthsActions, type SessionLengthsModel } from './SessionLengthsCard'

/** Security & health in depth (B-W2b-413): the three W2b sections and their one fresh-code dialog. */
export interface SecurityDepthModel {
  lengths: SessionLengthsModel
  stepUp: StepUpActionsModel
  /** Null: the person does not hold security.events.view (the section is absent). */
  events: SecurityEventsModel | null
  freshCode: StepUpModel
}

export interface SecurityDepthActions {
  lengths?: SessionLengthsActions
  stepUp?: StepUpActionsActions
  events?: SecurityEventsActions
  onFreshSubmit?: (code: string) => void
  onFreshClose?: () => void
}

/**
 * SCR-166's W2b sections, in the design's order after Sign-in rules: Session lengths, Actions that ask for a fresh code,
 * Security events (absent without its right). Words `admin-security-depth` (added here). Fetches nothing.
 */
export function SecurityDepth({ model, actions }: { model: SecurityDepthModel; actions?: SecurityDepthActions }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <SessionLengthsCard model={model.lengths} actions={actions?.lengths} />
      <StepUpActionsCard model={model.stepUp} actions={actions?.stepUp} />
      {model.events && <SecurityEventsCard model={model.events} actions={actions?.events} />}
      <FreshCode model={model.freshCode} onSubmit={actions?.onFreshSubmit} onClose={actions?.onFreshClose} />
    </WithMessages>
  )
}
