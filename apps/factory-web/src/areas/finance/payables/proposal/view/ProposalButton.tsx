'use client'

import { CalendarCheck2 } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useScopedT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { PAY_DEPTH_NAMESPACES } from '../../../payments/riba/depth'

/** Finance › Payables band's primary "Payment proposal" (design page.h, W2b): opens the week's proposal; held with why. */
export function ProposalButton({ held, onOpen }: { held: string | null; onOpen?: () => void }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Inner held={held} onOpen={onOpen} />
    </WithMessages>
  )
}

function Inner({ held, onOpen }: { held: string | null; onOpen?: () => void }) {
  const s = useScopedT('finance')
  return (
    <Button size="sm" variant="primary" heldReason={held ? s(held) : null} onClick={() => onOpen?.()}>
      <CalendarCheck2 size={14} aria-hidden /> {s('finance-payments-depth:proposal.band')}
    </Button>
  )
}
