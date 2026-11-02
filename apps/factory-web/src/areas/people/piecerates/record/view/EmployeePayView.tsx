'use client'

import Link from 'next/link'
import { Banner, Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { TIME_ZONE } from '../../../_shared/model'
import type { EmployeePublications, EmployeeStatements, Statement } from '../../api'
import { dayText, minutesText, moneyText, monthText, rateText, type Words } from '../../model'
import type { Read } from '../../view-model'
import { PieceMessages, ReadBlock, said, usePieceWords } from '../../view/parts'

export interface EmployeePayModel {
  prefix: string
  employeeId: string
  /** The right: people.earnings.records and the pay grain. */
  right: boolean
  /** people.piecerates.view: what was published to the person. */
  rates: boolean
  statements: Read<EmployeeStatements> | null
  publications: Read<EmployeePublications> | null
  /** This period's statement, once a person opened it (each opening is recorded). */
  opened: Read<Statement> | null
}

export interface EmployeePayActions {
  onOpen: (id: string) => void
  onRetry: () => void
}

/**
 * Employee › Pay & piece rates (design people.employees rec:Employee/pay): "Earnings this period" and "Rates published and read"
 * (c.c. art. 2101 c.3). Inside one record, for those with the right: the list of statements says states and totals; the
 * pieces per operation open only on the person's choice, because each opening is recorded. Without the right: said in words.
 */
export function EmployeePayView({ model, actions }: { model: EmployeePayModel; actions?: EmployeePayActions }) {
  return (
    <PieceMessages>
      <Tab model={model} actions={actions} />
    </PieceMessages>
  )
}

function Opened({ value }: { value: Statement }) {
  const t = usePieceWords()
  const locale = useLocale()
  const money = (minor: number | null | undefined) => moneyText(minor, value.currency, locale) ?? t('statement.noPay')
  return (
    <div className="fw-pr8-stack">
      <h3 className="fw-pr8-h3">{t('statement.title', { name: value.person.name })}</h3>
      <SummaryTable
        label={t('statement.pieces')}
        stackOnPhone
        columns={[t('rates.operation'), t('ledger.pieces'), t('statement.minutes'), t('ledger.rate'), t('ledger.amount')]}
        widths={['44%']}
        align={['left', 'right', 'right', 'right', 'right']}
        rows={value.lines.map((line, index) => ({ id: `${line.operationCode}-${index}`, cells: [`${line.operationCode} · ${line.operationName}`, line.pieces, minutesText(line.minutes, locale) ?? '—', rateText(line.rate, value.currency, locale) ?? '—', money(line.amount)] }))}
      />
      <KeyValue
        columns={3}
        items={[
          { label: t('statement.earnings'), value: money(value.earningsAmount) },
          { label: t('statement.makeUp'), value: money(value.makeUpAmount) },
          { label: t('statement.held'), value: t('statement.heldValue', value.held) },
        ]}
      />
    </div>
  )
}

function Tab({ model, actions }: { model: EmployeePayModel; actions?: EmployeePayActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const ds = useDsWords()
  return (
    <div className="fw-pp-two">
        <Card padded>
          <div className="fw-pr8-stack">
            <h2 className="fw-pr8-h2">{t('pay.period')}</h2>
            <PrivacyNote level="individual" variant="pill" text={t('statement.privacy')} whoMore={t('statement.whoMore')} labels={ds.privacyNote} />
            {!model.right ? (
              <EmptyState title={t('pay.hiddenTitle')} description={t('pay.hidden')} />
            ) : (
              <ReadBlock read={model.statements} onRetry={actions?.onRetry}>
                {(value) =>
                  value.statements.length === 0 ? (
                    <EmptyState title={t('pay.none')} description={t('pay.noneBody')} />
                  ) : (
                    <>
                      <SummaryTable
                        label={t('pay.period')}
                        density="roomy"
                        stackOnPhone
                        columns={[t('periods.month'), t('periods.status'), t('statement.earnings'), t('statement.makeUp'), '']}
                        align={['left', 'left', 'right', 'right', 'right']}
                        rows={value.statements.map((row) => ({
                          id: row.id,
                          cells: [
                            monthText(row.month, locale),
                            `${t(`statementStatus.${row.status}`)}${row.approvedOn ? ` · ${dayText(row.approvedOn, locale)}` : ''}`,
                            moneyText(row.earningsAmount, row.currency, locale) ?? '—',
                            moneyText(row.makeUpAmount, row.currency, locale) ?? '—',
                            <span key="open" className="fw-pp-actions">
                              <Button size="sm" onClick={() => actions?.onOpen(row.id)}>
                                {t('statement.open')}
                              </Button>
                              <a className="fw-pp-link" href={`${model.prefix}/people/piecerates/statement/${encodeURIComponent(row.id)}`} target="_blank" rel="noreferrer">
                                {t('statement.pdf')}
                              </a>
                              <Link className="fw-pp-link" href={`${model.prefix}/people/piecerates#ledger`}>
                                {t('pay.entries')}
                              </Link>
                            </span>,
                          ],
                        }))}
                      />
                      {model.opened?.status === 'loading' && (
                        <p className="fw-pr8-hint" role="status">
                          <Spinner size={12} /> {t('statement.opening')}
                        </p>
                      )}
                      {model.opened?.status === 'failed' && <Banner tone="danger" title={said(t, model.opened.problem as Words)} />}
                      {model.opened?.status === 'ready' && <Opened value={model.opened.value} />}
                    </>
                  )
                }
              </ReadBlock>
            )}
          </div>
        </Card>
        <Card padded>
          <div className="fw-pr8-stack">
            <h2 className="fw-pr8-h2">{t('pay.rates')}</h2>
            <p className="fw-pr8-hint">{t('pay.ratesHint')}</p>
            {!model.rates ? (
              <p className="fw-pr8-hint">{t('pay.ratesHidden')}</p>
            ) : (
              <ReadBlock read={model.publications} onRetry={actions?.onRetry}>
                {(value) =>
                  value.publications.length === 0 ? (
                    <p className="fw-pr8-hint">{t('pay.ratesNone')}</p>
                  ) : (
                    <SummaryTable
                      label={t('pay.rates')}
                      stackOnPhone
                      columns={[t('pay.sheet'), t('rates.published'), t('pay.read')]}
                      rows={value.publications.map((row) => ({
                        id: row.id,
                        cells: [`${row.table.code} · v${row.versionNo}`, formatDateTime(row.publishedAt, { locale, timeZone: TIME_ZONE }), row.read ? `${formatDateTime(row.read.at, { locale, timeZone: TIME_ZONE })} · ${row.read.device ?? t(`ack.${row.read.channel}`)}` : t('ack.notYet')],
                      }))}
                    />
                  )
                }
              </ReadBlock>
            )}
          </div>
        </Card>
    </div>
  )
}
