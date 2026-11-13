'use client'

import Link from 'next/link'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { WORDS_NS } from '../model'
import type { HeldActions, HeldModel } from '../use-held-receipt'
import { CancelHeldDialog, HeldBanner } from './HeldBanner'

/**
 * Right after Post receipt answered 202 (B-W2b-382; SCR-061-held): the receipt is recorded and WAITS — never "posted". Which
 * lines wait and why, who is asked, Cancel; Open the receipt (it is posted there after the last yes, live); once cancelled,
 * Receive again. When the receipt is posted meanwhile, the page draws W1's posted result instead.
 */
export function HeldResult({ model, actions, onAnother }: { model: HeldModel; actions?: HeldActions; onAnother?: () => void }) {
  return (
    <WithMessages namespaces={[WORDS_NS]}>
      <Result model={model} actions={actions} onAnother={onAnother} />
    </WithMessages>
  )
}

function Result({ model, actions, onAnother }: { model: HeldModel; actions?: HeldActions | undefined; onAnother?: (() => void) | undefined }) {
  const t = useT(WORDS_NS)
  const receipt = model.receipt
  const cancelled = receipt.status === 'CANCELLED'
  return (
    <div className="fw-rch" role="status">
      <HeldBanner model={model} actions={actions} numbered />
      <div className="fw-rch-actions">
        {!cancelled && (
          <Button size="sm" variant="primary" asChild>
            <Link href={`${model.prefix}/warehouse/receipts/${receipt.id}`}>{t('held.result.open')}</Link>
          </Button>
        )}
        {cancelled && receipt.purchaseOrder && (
          <Button size="sm" variant="primary" onClick={() => onAnother?.()}>
            {t('held.result.again', { number: receipt.purchaseOrder.number })}
          </Button>
        )}
        <Button size="sm" variant="quiet" asChild>
          <Link href={`${model.prefix}/warehouse/receipts`}>{t('held.result.back')}</Link>
        </Button>
      </div>
      <CancelHeldDialog model={model} actions={actions} />
    </div>
  )
}
