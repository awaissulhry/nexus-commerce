'use client'

import { WithMessages } from '../../../../../record-panels/i18n'
import type { RefundTarget } from '../../../../finance/payments/refunds/model'
import { RefundDialog, RefundMoveDialog } from '../../../../finance/payments/refunds/view/RefundDialogs'
import type { RefundWindows } from './use-money-windows'
import '../../../../finance/_shared/finance.css' // the refund windows' own classes (fw-fin-*), as Finance's pages load them

/**
 * F-CM-203 (customer page › MONEY tab, cm-w2 W2.3; 13-backend §4.2; 18-lead-settles Z7, Z12) — Finance's OWN refund windows, opened in
 * place on the customer's tab exactly as Finance › Payments and a payment's record open them (RefundDialogs.tsx: they fetch nothing; the
 * host hands what they show and does what they ask): Refund… on a credit note with money left or on the money on account (the targets
 * of THIS customer: its credit notes to refund, its payments' unplaced money), Mark made… · Cancel… · Void… on a refund. Each only with
 * its right (the tab offers it only then); no "Change…" (no such window exists).
 */
export function RefundWindowsView({ windows, targets, today }: { windows: RefundWindows; targets: readonly RefundTarget[] | null; today: string }) {
  if (!windows.dialog && !windows.move) return null
  return (
    <WithMessages namespaces={['finance', 'finance-daily']}>
      {windows.dialog ? (
        <RefundDialog
          model={{ targets: targets ? [...targets] : null, targetsProblem: null, start: windows.dialog.start, can: windows.can, today, busy: windows.busy, problem: windows.problem }}
          onRecord={(target, draft) => windows.onRecord(target, draft)}
          onClose={windows.onClose}
        />
      ) : null}
      {windows.move ? (
        <RefundMoveDialog
          key={`${windows.move.refund.id}-${windows.move.move}`}
          refund={windows.move.refund}
          move={windows.move.move}
          can={windows.can}
          today={today}
          busy={windows.busy}
          problem={windows.problem}
          onMove={(input) => windows.onDoMove(input)}
          onClose={windows.onClose}
        />
      ) : null}
    </WithMessages>
  )
}
