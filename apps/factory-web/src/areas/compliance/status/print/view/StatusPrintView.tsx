'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useValidityWords } from '../../../_shared/validity/ValidityBar'
import type { Actions, Board, Expiries, Feed } from '../../api'
import { marketName, rowsShown, TILE_KEYS, type StatusAddress } from '../../model'
import { cellOfLine, cellWord, lineHead, monthLabel } from '../../view/Panels'
import '../../status.css'

/** SCR-314 — the status board on paper or as a PDF (design tab:cs-print "for a management review; filters written at the top"). */
export interface StatusPrintModel {
  person: string
  at: string
  company: string
  can: boolean
  /** The board's filters, as on the page that opened it. */
  address: StatusAddress
  /** Today in Rome (what is left of each validity). */
  today: string
  /** The board's page (the strip's way back). */
  back: string
  board: Board | null
  actions: Actions | null
  feed: Feed | null
  expiries: Expiries | null
  /** A message key (namespace quality) of the first part that failed. */
  problem: string | null
  /** The brand's name when one is picked (its code · name). */
  brandName: string | null
}

/**
 * The board for a management review (design tab:cs-print): the company, the day and who printed it, the filters written at the
 * top; then the readiness tiles, every blocker of "Needs action" with who clears it, the style × market matrix in words, the
 * gate refusals of the last 7 days and what expires in the next 12 months. The browser prints it or saves it as a PDF.
 */
export function StatusPrintView({ model }: { model: StatusPrintModel }) {
  return (
    <WithMessages namespaces={['compliance-status', 'quality']}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: StatusPrintModel }) {
  const t = useT('compliance-status')
  const quality = useT('quality')
  const locale = useLocale()
  const ds = useDsWords()
  const validity = useValidityWords()
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const { board, actions, feed, expiries } = model
  const ready = !!board && !!actions && !!feed && !!expiries
  const address = model.address
  const filters = [
    { label: t('print.markets'), value: address.markets.length > 0 ? address.markets.join(', ') : t('scope.marketsAll') },
    { label: t('print.brand'), value: model.brandName ?? t('scope.allBrands') },
    { label: t('print.gap'), value: address.gap ? t(`gap.${address.gap}`) : t('print.none') },
    { label: t('print.status'), value: address.status ? t(`matrix.status.${address.status}`) : t('matrix.statusAll') },
    ...(address.q.trim() ? [{ label: t('print.search'), value: address.q.trim() }] : []),
    { label: t('print.scope'), value: t('scope.every') },
  ]
  const rows = board ? rowsShown(board.rows, address.status) : []
  const markets = board?.markets ?? []
  return (
    <PrintView
      title={t('print.title')}
      meta={[model.company]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={filters}
      printHeld={ready ? null : t('print.held')}
      back={{ href: model.back, label: t('print.back') }}
      labels={ds.printView}
    >
      {!model.can ? (
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      ) : model.problem ? (
        <Banner tone="danger" title={t('print.failed')}>
          {quality(model.problem)}
        </Banner>
      ) : !ready ? (
        <p className="fw-cs-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <>
          <p className="fw-cs-hint">{t('print.note', { at: formatDateTime(board!.asOf, { locale }) })}</p>
          <PrintSection title={t('section.kpi')}>
            <SummaryTable
              label={t('section.kpi')}
              columns={[t('print.figure'), t('print.value')]}
              align={[undefined, 'right']}
              rows={TILE_KEYS.map((key) => ({ id: key, cells: [t(`tile.${key}`), board!.tiles[key] === null ? t('tile.notInRole') : String(board!.tiles[key])] }))}
            />
          </PrintSection>
          <PrintSection title={t('print.actionsTitle', { count: actions!.count })}>
            {actions!.lines.length === 0 ? (
              <p>{t('actions.empty')}</p>
            ) : (
              <SummaryTable
                label={t('section.actions')}
                columns={[t('all.col.severity'), t('all.col.line'), t('all.col.who')]}
                rows={actions!.lines.map((line) => {
                  const cell = cellOfLine(board, line)
                  const sentence = cell?.first?.code === line.requirementCode ? `${line.requirementCode} · ${cell.first.message}` : line.requirementCode
                  return { id: `${line.styleId}|${line.marketCode}`, cells: [t(`severity.${line.severity}`), `${lineHead(t, line, cell, marketName(line.marketCode, markets, locale))}: ${sentence}`, t(`who.${line.who}`)] }
                })}
              />
            )}
          </PrintSection>
          <PrintSection title={t('section.matrix')}>
            {rows.length === 0 ? (
              <p>{t('matrix.empty.title')}</p>
            ) : (
              <SummaryTable
                label={t('section.matrix')}
                columns={[t('matrix.col.style'), ...markets.map((market) => `${market.code} · ${marketName(market.code, markets, locale)}`)]}
                rows={rows.map((row) => ({
                  id: row.style.id,
                  cells: [
                    `${row.style.code} · ${row.style.name}${row.style.brand ? ` (${row.style.brand.code})` : ''}`,
                    ...markets.map((market) => {
                      const cell = row.cells.find((entry) => entry.marketCode === market.code)
                      return cell ? `${cellWord(t, cell.state, cell.missing)}${cell.first ? ` · ${cell.first.code}` : ''}` : '—'
                    }),
                  ],
                }))}
              />
            )}
            {board!.more ? <p className="fw-cs-hint">{t('matrix.more', { count: board!.rows.length })}</p> : null}
          </PrintSection>
          <PrintSection title={t('print.gatesTitle', { count: feed!.days })}>
            {feed!.events.length === 0 ? (
              <p>{t('feed.empty', { count: feed!.days })}</p>
            ) : (
              <SummaryTable
                label={t('section.gates')}
                columns={[t('feed.col.when'), t('feed.col.where'), t('feed.col.what'), t('feed.col.reason'), t('feed.col.state')]}
                rows={feed!.events.map((event) => ({
                  id: event.id,
                  cells: [
                    formatDateTime(event.at, { locale }),
                    `${t(`gate.${event.gate}`)} · ${event.subject.number ?? '—'}${event.site?.code ? ` · ${event.site.code}` : ''}`,
                    [event.style?.code, event.colourway, event.size, event.marketCode].filter(Boolean).join(' · ') || '—',
                    `${event.requirement.code} · ${event.reason}`,
                    t(`feed.state.${event.state}`),
                  ],
                }))}
              />
            )}
          </PrintSection>
          <PrintSection title={t('print.expiryTitle', { from: day(expiries!.from), to: day(expiries!.to) })}>
            {expiries!.count === 0 ? (
              <p>{t('expiry.empty')}</p>
            ) : (
              <SummaryTable
                label={t('section.expiry')}
                columns={[t('csv.month'), t('expiry.validTo'), t('expiry.what'), t('expiry.left')]}
                rows={expiries!.months.flatMap((month) =>
                  month.items.map((item) => ({
                    id: `${item.recordType}-${item.recordId}`,
                    cells: [
                      monthLabel(month.month, locale),
                      day(item.validTo),
                      `${item.recordType === 'Certificate' ? t('expiry.kindCertificate') : item.recordType === 'SustainabilityClaim' ? t('expiry.kindClaim') : t('expiry.kindDeclaration')} · ${[item.label, item.detail, item.party].filter(Boolean).join(' · ')}${item.endsWithBase ? ` (${t('expiry.endsWithBase')})` : ''}`,
                      validity({ from: item.validFrom, to: item.validTo, today: model.today }).left,
                    ],
                  })),
                )}
              />
            )}
          </PrintSection>
        </>
      )}
    </PrintView>
  )
}
