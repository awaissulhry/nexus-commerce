'use client'

import { EmptyState, ProgressBar } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { LineCard, LinesOverview } from '../../reports/api'
import { outputPhrase, STATE_TONE, stationNotes } from '../../reports/model'
import '../../reports/reports.css'

export interface LinesPanelModel {
  readonly lines: { readonly value: LinesOverview | null; readonly problem: string | null }
  /** The line the page is scoped to (null: all lines). */
  readonly scope: string | null
}

export interface LinesPanelActions {
  onLine?: (lineId: string | null) => void
  onRetry?: () => void
}

/**
 * Floor now › Lines (SCR-073 fn-lines; design production.floor "Each line at a glance", MES-160; Owner answer F2): a card
 * per line with its state word (Running, Waiting, No work), the garments through its last operation today against what
 * the published plan puts through it today (ProgressBar with the numbers), the work orders on it, the operation where most
 * pieces wait, and per station only "nobody signed in" and the machines down. A card sets the page's line scope (again:
 * all lines); [ and ] step through the lines. Help calls and absences (a number) come in W2b. Never a person.
 */
export function LinesPanel({ model, actions }: { model: LinesPanelModel; actions?: LinesPanelActions }) {
  return (
    <WithMessages namespaces={['production-reports']}>
      <Lines model={model} actions={actions} />
    </WithMessages>
  )
}

function Lines({ model, actions }: { model: LinesPanelModel; actions?: LinesPanelActions }) {
  const t = useT('production-reports')
  const overview = model.lines.value
  const sites = overview ? overview.sites.length : 0
  return (
    <section className="fw-prr-card" aria-labelledby="fw-prr-lines-title">
      <div className="fw-prr-card-head">
        <h2 className="fw-prr-h2" id="fw-prr-lines-title">
          {t('lines.title')}
        </h2>
        <span className="fw-prr-inline">
          <span className="fw-prr-muted">{t('lines.hint')}</span>
          {model.scope && (
            <Button size="sm" onClick={() => actions?.onLine?.(null)}>
              {t('lines.allLines')}
            </Button>
          )}
        </span>
      </div>
      {model.lines.problem ? (
        <EmptyState title={t('lines.failed')} description={t(model.lines.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
      ) : !overview ? (
        <p className="fw-prr-muted" role="status">
          <Spinner size={12} /> {t('common.loading')}
        </p>
      ) : overview.lines.length === 0 ? (
        <EmptyState title={t('lines.none.title')} description={t('lines.none.body')} />
      ) : (
        <div className="fw-prr-line-grid" role="group" aria-label={t('lines.title')}>
          {overview.lines.map((card) => (
            <LineCardView key={card.id} card={card} pressed={model.scope === card.id} showSite={sites > 1} onPress={() => actions?.onLine?.(model.scope === card.id ? null : card.id)} />
          ))}
        </div>
      )}
    </section>
  )
}

function LineCardView({ card, pressed, showSite, onPress }: { card: LineCard; pressed: boolean; showSite: boolean; onPress: () => void }) {
  const t = useT('production-reports')
  const locale = useLocale()
  const output = outputPhrase(card)
  const notes = stationNotes(card)
  const shown = card.workOrders.slice(0, 3).map((row) => row.number)
  const more = card.workOrders.length - shown.length
  return (
    <button type="button" className={pressed ? 'fw-prr-line-card is-scope' : 'fw-prr-line-card'} aria-pressed={pressed} onClick={onPress} aria-label={t('lines.cardLabel', { line: `${card.code} · ${card.name}`, state: t(`lines.state.${card.state}`) })}>
      <span className="fw-prr-line-top">
        <span className="fw-prr-line-name">
          {card.code} · {card.name}
          {showSite ? ` · ${card.site.code}` : ''}
        </span>
        <Tag tone={STATE_TONE[card.state]}>{t(`lines.state.${card.state}`)}</Tag>
      </span>
      <span className="fw-prr-muted">{card.lastScanAt ? t('lines.lastReport', { time: formatTime(card.lastScanAt, { locale }) }) : t('lines.noReport')}</span>
      {card.plannedToday !== null && card.plannedToday > 0 && (
        <ProgressBar value={Math.min(100, card.outputPct ?? 0)} height={6} ariaLabel={t('lines.outputLabel', { line: card.code })} />
      )}
      <span>
        {t(output.key, output.params)}
        {card.plan ? ` · ${t('lines.plan', { number: card.plan.number })}` : ''}
      </span>
      <span className="fw-prr-muted">{card.workOrders.length === 0 ? t('lines.noWorkOrders') : t('lines.workOrders', { count: card.workOrders.length, numbers: shown.join(', ') + (more > 0 ? ` +${more}` : '') })}</span>
      {card.bottleneck && <span className="fw-prr-muted">{t('lines.bottleneck', { seq: card.bottleneck.seq, operation: card.bottleneck.code, waiting: card.bottleneck.waiting, number: card.bottleneck.workOrderNumber })}</span>}
      {card.stations.length === 0 ? (
        <span className="fw-prr-muted">{t('lines.noStations')}</span>
      ) : (
        <>
          <span className="fw-prr-muted">{notes.nobody.length === 0 ? t('lines.everyoneIn') : t('lines.nobody', { stations: notes.nobody.join(', ') })}</span>
          {notes.down.length > 0 && <span className="fw-prr-inline"><Tag tone="danger">{t('lines.machineDown', { count: notes.down.length })}</Tag> <span className="fw-prr-muted">{notes.down.join(', ')}</span></span>}
        </>
      )}
    </button>
  )
}
