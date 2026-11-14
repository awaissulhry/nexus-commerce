'use client'

import { ChevronDown } from 'lucide-react'
import { Menu } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { FinanceAbilities } from '../../../_shared/model'
import { DEPTH, DEPTH_NAMESPACES } from '../../test-mode/depth'
import { newHeld, type NewKind } from '../model'

/**
 * New ▾ on Invoices (design finance.invoices page.h: "New ▾ (credit note · debit note W2b · deposit invoice)", secondary):
 * a credit note or a debit note of an issued invoice (picked next), and the deposit invoice — made when a deposit's payment
 * is recorded, so it opens Payments' Record a payment. An item a person may not use stays in the menu and says why.
 */
export function NewMenu({ can, paymentsHref, onNew }: { can: FinanceAbilities; paymentsHref: string; onNew?: (kind: NewKind) => void }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Items can={can} paymentsHref={paymentsHref} onNew={onNew} />
    </WithMessages>
  )
}

function Items({ can, paymentsHref, onNew }: { can: FinanceAbilities; paymentsHref: string; onNew?: (kind: NewKind) => void }) {
  const w = useT(DEPTH)
  const held = newHeld(can)
  const reason = held ? w(held.key) : undefined
  return (
    <Menu
      label={
        <>
          {w('new.label')} <ChevronDown size={14} aria-hidden />
        </>
      }
      align="right"
      triggerProps={{ 'aria-label': w('new.aria') }}
      items={[
        { id: 'credit', label: w('new.credit'), disabled: !!held, description: reason, onSelect: () => onNew?.('credit') },
        { id: 'debit', label: w('new.debit'), disabled: !!held, description: reason, onSelect: () => onNew?.('debit') },
        can.recordPayments
          ? { id: 'deposit', label: w('new.deposit'), description: w('new.depositHint'), href: paymentsHref }
          : { id: 'deposit', label: w('new.deposit'), disabled: true, description: w('held.noRecord') },
      ]}
    />
  )
}
