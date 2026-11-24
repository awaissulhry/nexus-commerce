'use client'

import { WithMessages } from '../../../../../record-panels/i18n'
import { ChangeLimitDialog } from '../../../../finance/receivables/credit/view/ChangeLimitDialog'
import { CREDIT_NAMESPACE } from '../../../../finance/receivables/credit/model'
import { RECEIVABLES_NAMESPACE } from '../../../../finance/receivables/model'
import { StatementDialog } from '../../../../finance/receivables/view/StatementDialog'
import type { LimitWindow, StatementWindow } from './use-account-windows'
import '../../../../finance/receivables/credit/credit.css' // the editor's own classes (fw-frc-*), as Finance's credit list loads them
import '../../../../finance/receivables/receivables.css' // fw-frv-* (the statement, the editor's muted lines), as Receivables loads them

/**
 * F-CM-301 / F-CM-302 (customer page › MONEY tab, cm-w3; 13-backend §4.2; Z12) — Finance's OWN windows opened in place on the customer's
 * tab, as Finance's pages open them: the credit limit's one editor (ChangeLimitDialog) and the statement (StatementDialog). They fetch
 * nothing: the drivers (use-account-windows.ts) hand what they show and do what they ask. Never copied, never edited.
 */
export function AccountWindowsView({ limit, statement, companyCode, prefix }: { limit: LimitWindow; statement: StatementWindow; companyCode: string; prefix: string }) {
  if (!limit.state && !statement.state) return null
  return (
    <WithMessages namespaces={[CREDIT_NAMESPACE, RECEIVABLES_NAMESPACE]}>
      {limit.state ? <ChangeLimitDialog state={limit.state} customers={limit.customers} companyId={limit.state.row?.company.id ?? limit.customers[0]?.companyId ?? null} companyCode={limit.state.row?.company.code ?? companyCode} busy={limit.busy} onClose={limit.onClose} onSubmit={limit.onSubmit} /> : null}
      {statement.state ? (
        <StatementDialog
          state={statement.state}
          ids={[]}
          can={statement.can}
          prefix={prefix}
          busy={statement.busy}
          onClose={statement.onClose}
          onRetry={statement.onRetry}
          onPeriod={statement.onPeriod}
          onPrint={() => statement.onPrint()}
          onSend={statement.onSend}
          onCurrency={statement.onCurrency}
        />
      ) : null}
    </WithMessages>
  )
}
