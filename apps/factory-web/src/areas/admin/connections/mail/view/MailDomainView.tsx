'use client'

import type { StepUpModel } from '../../../shared/model'
import { ConnectionsMessages, ConnStepUp } from '../../view/parts'
import type { MailDomainModel } from '../model'
import { MailDomainSection, type MailDomainActions } from './MailDomainSection'

/**
 * SCR-015 on its own (the design index): the mail domain section of Connections & API, with its step-up dialog, in the
 * page's words. In the Office it is drawn inside ConnectionsView (`/admin/connections#mail`). Fetches nothing.
 */
export function MailDomainView({ model, prefix, stepUp, actions }: { model: MailDomainModel; prefix: string; stepUp?: StepUpModel; actions?: MailDomainActions }) {
  return (
    <ConnectionsMessages>
      <div className="fw-adm">
        <MailDomainSection model={model} prefix={prefix} actions={actions} />
        <ConnStepUp model={stepUp} />
      </div>
    </ConnectionsMessages>
  )
}
