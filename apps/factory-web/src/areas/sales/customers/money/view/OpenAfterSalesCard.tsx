'use client'

import Link from 'next/link'
import { Card, SummaryTable } from '@nexus/ui/components'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { CustomerComplaint, CustomerReturn } from '../api'
import { CUSTOMER_MONEY_NAMESPACE, type CustomerMoneyCan } from '../model'
import '../money.css'

export interface OpenAfterSalesModel {
  readonly prefix: string
  readonly can: CustomerMoneyCan
  /** Open returns, newest first (null: not read yet; absent: no permission). */
  readonly returns: { readonly items: readonly CustomerReturn[] | null; readonly problem: string | null } | null
  readonly complaints: { readonly items: readonly CustomerComplaint[] | null; readonly problem: string | null } | null
  /** Finance › Receivables & credit filtered to the customer (design page.conn), with receivables.view. */
  readonly receivablesHref: string | null
}

const BUILT = new Set(OFFICE_PAGES)
const SHOWN = 5

/**
 * "Open returns and claims (W2a)" of the customer's Now (design customer.ov.now): the open returns (number, state, units,
 * requested) and the open complaints (number, state, answer due), each row a link to its record, "See all N" when there
 * are more; and the connection to Finance › Receivables & credit. Fetches nothing.
 */
export function OpenAfterSalesCard({ model }: { model: OpenAfterSalesModel }) {
  const t = useT(CUSTOMER_MONEY_NAMESPACE)
  const locale = useLocale()
  const returns = model.returns?.items ?? []
  const complaints = model.complaints?.items ?? []
  const reading = (model.returns && model.returns.items === null && !model.returns.problem) || (model.complaints && model.complaints.items === null && !model.complaints.problem)
  const problem = model.returns?.problem ?? model.complaints?.problem ?? null
  const href = (type: string, id: string) => `${model.prefix}${recordAddress({ type, id }, BUILT)}`
  const rows = [
    ...returns.slice(0, SHOWN).map((entry) => ({
      id: `r-${entry.id}`,
      cells: [
        t('now.return'),
        <Link key="n" className="fw-cmo-link" href={href('ReturnAuthorisation', entry.id)}>
          {entry.number}
        </Link>,
        `${t(`returnStatus.${entry.status}`)}${entry.late ? ` · ${t('now.late')}` : ''}`,
        t('now.requested', { date: formatDate(entry.requestedAt, { locale }), units: entry.units }),
      ],
    })),
    ...complaints.slice(0, SHOWN).map((entry) => ({
      id: `c-${entry.id}`,
      cells: [
        t('now.complaint'),
        <Link key="n" className="fw-cmo-link" href={href('Complaint', entry.id)}>
          {entry.number}
        </Link>,
        t(`complaintStatus.${entry.status}`),
        entry.answerDueOn ? t('now.answerDue', { date: formatDate(`${entry.answerDueOn}T12:00:00Z`, { locale }) }) : t('now.received', { date: formatDate(entry.receivedAt, { locale }) }),
      ],
    })),
  ]
  const more = Math.max(0, returns.length - SHOWN) + Math.max(0, complaints.length - SHOWN)
  return (
    <Card padded>
      <div className="fw-cmo-card">
        <h3 className="fw-cmo-h3">{t('now.title')}</h3>
        {problem ? (
          <p className="fw-cmo-muted">{t(problem)}</p>
        ) : reading ? (
          <p className="fw-cmo-muted" role="status">
            {t('now.reading')}
          </p>
        ) : !model.returns && !model.complaints ? null : rows.length === 0 ? (
          <p className="fw-cmo-muted">{t('now.nothingOpen')}</p>
        ) : (
          <SummaryTable
            label={t('now.title')}
            stackOnPhone
            columns={[t('now.col.type'), t('now.col.number'), t('now.col.state'), t('now.col.when')]}
            align={['left', 'left', 'left', 'left']}
            rows={rows}
          />
        )}
        {more > 0 && <p className="fw-cmo-muted">{t('now.more', { count: more })}</p>}
        {model.receivablesHref && (
          <p className="fw-cmo-muted">
            {t('now.owes')}{' '}
            <Link className="fw-cmo-link" href={model.receivablesHref}>
              {t('now.receivables')}
            </Link>
          </p>
        )}
      </div>
    </Card>
  )
}
