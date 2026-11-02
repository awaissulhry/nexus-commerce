'use client'

import { Printer } from 'lucide-react'
import { EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { TIME_ZONE } from '../../../_shared/model'
import { dayText, minutesText, rateText } from '../../model'
import type { Read } from '../../view-model'
import { PieceMessages, ReadBlock, usePieceWords } from '../../view/parts'

export interface SheetTable {
  key: string
  title: string
  subtitle: string
  versionNo: number
  effectiveFrom: string
  effectiveTo: string | null
  provisionalUntil: string | null
  currency: string
  rates: readonly { id: string; operation: string; sizeBand: string; basis: string; standardMinutes: string | null; ratePerMinute: string | null; ratePerPiece: string | null }[]
}

export interface RateSheetModel {
  /** people.piecerates.view and the pay grain: a sheet without its rates is no sheet. */
  allowed: boolean
  company: string
  site: string
  printedAt: string
  sheet: Read<readonly SheetTable[]>
}

/**
 * tab:rate-sheet — "Rate sheet print" (design people.piecerates; c.c. art. 2101 c.3): per table, for publication and the notice
 * board: the operations, their standard minutes and the rate per piece, the first day and, for a provisional rate, the end of
 * its trial. No person on it, no reading. The browser prints it (or saves it as a PDF).
 */
export function RateSheetView({ model }: { model: RateSheetModel }) {
  return (
    <PieceMessages>
      <Sheet model={model} />
    </PieceMessages>
  )
}

function Sheet({ model }: { model: RateSheetModel }) {
  const t = usePieceWords()
  const locale = useLocale()
  if (!model.allowed) return <EmptyState title={t('sheet.noRight')} description={t('sheet.noRightBody', { permission: 'money.pay' })} />
  return (
    <div className="fw-pr8-sheet">
      <div className="fw-pp-head">
        <span>
          <h1 className="fw-pr8-h2">{t('sheet.title', { site: model.site })}</h1>
          <p className="fw-pr8-hint">
            {model.company} · {t('sheet.printed', { when: formatDateTime(model.printedAt, { locale, timeZone: TIME_ZONE }) })}
          </p>
        </span>
        <Button className="fw-pr8-noprint" size="sm" variant="primary" onClick={() => window.print()}>
          <Printer size={13} aria-hidden /> {t('sheet.print')}
        </Button>
      </div>
      <ReadBlock read={model.sheet}>
        {(tables) =>
          tables.length === 0 ? (
            <EmptyState title={t('sheet.empty')} description={t('sheet.emptyBody')} />
          ) : (
            <>
              {tables.map((table) => (
                <section key={table.key} className="fw-pr8-stack">
                  <span>
                    <h2 className="fw-pr8-h3">
                      {table.title} · v{table.versionNo}
                    </h2>
                    <p className="fw-pr8-hint">
                      {table.subtitle} · {t('sheet.from', { day: dayText(table.effectiveFrom, locale) ?? '' })}
                      {table.effectiveTo ? ` · ${t('sheet.to', { day: dayText(table.effectiveTo, locale) ?? '' })}` : ''}
                      {table.provisionalUntil ? ` · ${t('state.provisionalUntil', { day: dayText(table.provisionalUntil, locale) ?? '' })}` : ''}
                    </p>
                  </span>
                  <div className="fw-pr8-sheet-table">
                    <SummaryTable
                      label={table.title}
                      columns={[t('rates.operation'), t('rates.band'), t('rates.smv'), t('rates.perMinute'), t('rates.perPiece')]}
                      align={['left', 'left', 'right', 'right', 'right']}
                      rows={table.rates.map((rate) => ({ id: rate.id, cells: [rate.operation, rate.sizeBand === 'ALL' ? t('rates.allSizes') : rate.sizeBand, minutesText(rate.standardMinutes, locale) ?? '—', rate.basis === 'FIXED' ? t('basis.FIXED') : (rateText(rate.ratePerMinute, table.currency, locale) ?? '—'), rateText(rate.ratePerPiece, table.currency, locale) ?? '—'] }))}
                    />
                  </div>
                </section>
              ))}
              <p className="fw-pr8-hint">{t('sheet.law')}</p>
              <div className="fw-pr8-sheet-sign">
                <span>{t('sheet.signWorker')}</span>
                <span>{t('sheet.signDate')}</span>
              </div>
            </>
          )
        }
      </ReadBlock>
    </div>
  )
}

