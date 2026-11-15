'use client'

import Link from 'next/link'
import { Factory } from 'lucide-react'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES } from '../../riba/depth'

/**
 * "Deposit paid unlocks production" (design finance.payments pop:record "… and 'Deposit paid unlocks production' (W2b)",
 * page.conn "Production — Deposit paid unlocks the order"; B-W2b-402 FIN-128): in Record a payment, when the payment pays an
 * order's deposit in full, the words that say what follows — the order's work orders may be released (the work orders'
 * deposit gate reads the request paid at once; the planners are told). Words only: nothing more is written.
 */
export function DepositUnlockNote({ orderNumber }: { orderNumber: string | null }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Note orderNumber={orderNumber} />
    </WithMessages>
  )
}

function Note({ orderNumber }: { orderNumber: string | null }) {
  const p = useT(PAY_DEPTH)
  return (
    <p className="fw-fin-hint">
      <Factory size={13} aria-hidden /> {orderNumber ? p('unlock.note', { order: orderNumber }) : p('unlock.notePlain')}
    </p>
  )
}

/**
 * The recorded payment's line when it paid a deposit (page.conn "Production — Deposit paid unlocks the order"): production of
 * the order is unlocked, with its work orders one click away for a person who may see them.
 */
export function DepositUnlocked({ prefix, orderNumber, workOrders }: { prefix: string; orderNumber: string | null; workOrders: boolean }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Unlocked prefix={prefix} orderNumber={orderNumber} workOrders={workOrders} />
    </WithMessages>
  )
}

function Unlocked({ prefix, orderNumber, workOrders }: { prefix: string; orderNumber: string | null; workOrders: boolean }) {
  const p = useT(PAY_DEPTH)
  return (
    <span className="fw-fin-stack-tight">
      <span>{orderNumber ? p('unlock.done', { order: orderNumber }) : p('unlock.donePlain')}</span>
      {workOrders && orderNumber && (
        <Link className="fw-fin-link" href={`${prefix}/production/work-orders?q=${encodeURIComponent(orderNumber)}`}>
          {p('unlock.openWorkOrders')}
        </Link>
      )}
    </span>
  )
}
