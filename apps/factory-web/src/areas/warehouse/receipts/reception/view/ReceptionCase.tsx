'use client'

import { WithMessages } from '../../../../../record-panels/i18n'
import { NAMESPACE } from '../model'
import { ReceptionDialog, type ReceptionDialogModel } from './ReceptionDialog'
import { WaitingBanner, WaitingDialogs, type WaitingModel } from './WaitingPanel'

/**
 * SCR-379's design case (B-W2b-300): the reception report dialog over a posted receipt, or goods without a PO on their receipt
 * (the banner, with the naming or send-back dialog open). The real page mounts the same parts through the record's slot
 * (useReceiptDepth).
 */

export type ReceptionCaseModel = { readonly kind: 'report'; readonly number: string; readonly model: ReceptionDialogModel } | { readonly kind: 'waiting'; readonly model: WaitingModel }

export function ReceptionCase({ model }: { model: ReceptionCaseModel }) {
  return (
    <WithMessages namespaces={['lists', 'records', NAMESPACE]}>
      {model.kind === 'report' ? (
        <ReceptionDialog number={model.number} model={model.model} />
      ) : (
        <div className="fw-rc">
          <WaitingBanner model={model.model} />
          <WaitingDialogs model={model.model} />
        </div>
      )}
    </WithMessages>
  )
}
