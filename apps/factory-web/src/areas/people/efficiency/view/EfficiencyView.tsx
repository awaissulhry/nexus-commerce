'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { MoreHorizontal, SlidersHorizontal } from 'lucide-react'
import { Banner, Menu } from '@nexus/ui/components'
import { SectionLayout, type SectionLayoutValue, type SectionSpec } from '@nexus/ui/patterns'
import { Button, Select, Toggle } from '@nexus/ui/primitives'
import { AsOf, DateRangePicker } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { OfficeScope } from '../../../../shell/scope/scope-model'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { KeysModal, NoPeopleAccess, PeoplePrivacyNote, useWords, type SightState } from '../../_shared/parts'
import type { OperationDetail, OperationRow, Operations, Overview, ReviewEntry, ReviewQueue, Trend } from '../api'
import { dateOfDay, dayOfDate, daysWithFigures, EFFICIENCY_SECTIONS, printAddress, rangeShown, type EfficiencyAddress, type EfficiencyCan, type EfficiencyProblem, type EfficiencySection } from '../model'
import type { PersonDialogActions, PersonDialogState } from '../use-person'
import type { ReviewDetailActions, ReviewDetailState } from '../use-review'
import '../efficiency.css'
import { ArrangeDialog } from './ArrangeDialog'
import { LinesPanel, PrivacyPanel, TilesPanel, TrendPanel } from './FiguresPanels'
import { IndividualPanel, PersonDialog } from './PersonDialog'
import { OperationsPanel } from './OperationsPanel'
import { ReviewDetail } from './ReviewDetail'
import { BulkDecisionDialog, ReviewPanel } from './ReviewPanel'

export type Read<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: EfficiencyProblem }

export interface EfficiencyNotice {
  tone: 'success' | 'warning' | 'danger'
  key: string
  params?: Record<string, string | number>
  /** Rows a many-rows action could not do, each with why. */
  refused?: readonly { label: string; problem: EfficiencyProblem }[]
}

export interface BulkState {
  decision: 'KEEP' | 'INVESTIGATE'
  rows: readonly ReviewEntry[]
  reason: string
  busy: boolean
}

/** The file's words: the container has no catalogue, the view does. */
export interface CsvWords {
  header: readonly string[]
  noLine: string
  tooFew: string
}

export interface OperationPop {
  id: string
  detail: Read<OperationDetail>
}

export interface EfficiencyModel {
  prefix: string
  scope: OfficeScope
  can: EfficiencyCan
  address: EfficiencyAddress
  /** Read before anything else: while it is not ready every read below stays `idle`. */
  sight: SightState
  overview: Read<Overview>
  trend: Read<Trend>
  operations: Read<Operations>
  review: Read<ReviewQueue>
  /** The lines and styles seen so far (the scope's choices). */
  lines: readonly { id: string; code: string; name: string }[]
  styles: readonly { id: string; code: string; name: string }[]
  updates: number
  notice: EfficiencyNotice | null
  bulk: BulkState | null
  sending: boolean
  pop: OperationPop | null
  layout: SectionLayoutValue
  specs: readonly SectionSpec[]
  arranging: boolean
  timeZone: string
  detail: (ReviewDetailState & { id: string; ids: readonly string[] }) | null
  person: PersonDialogState | null
  /** Design cases: the how panel and the keys list stand open. */
  howOpen?: boolean
  keysOpen?: boolean
}

export interface EfficiencyActions {
  onAddress?: (change: Partial<EfficiencyAddress>) => void
  onRetrySight?: () => void
  onRetry?: () => void
  onRetryReview?: () => void
  onShowUpdates?: () => void
  onDismissNotice?: () => void
  onExport?: (words: CsvWords) => void
  onSend?: (rows: readonly OperationRow[]) => Promise<boolean>
  onPop?: (row: OperationRow | null) => void
  onBulk?: (decision: BulkState['decision'], rows: readonly ReviewEntry[]) => void
  onBulkReason?: (reason: string) => void
  onBulkCancel?: () => void
  onBulkApply?: () => void
  onArrange?: (open: boolean) => void
  onArranged?: (order: string[]) => void
  review?: ReviewDetailActions
  person?: PersonDialogActions
}

/**
 * SCR-161 — People › Efficiency (design people.efficiency; MES-247, MES-249, MES-250, MES-251): the band says the level of data
 * and how fresh it is; "What you see here" stands first and is locked there, and nothing below is read until it is on the
 * screen. Scope, tiles with two denominators side by side, a chart per line against its target, planned against actual by
 * operation, the standard review in both directions, one person's figures behind the legal gate. No league table, no
 * score, no sort: rows come by line or by style and routing order (Statuto dei Lavoratori art. 4; AI Act Annex III 4(b)).
 */
export function EfficiencyView({ model, actions }: { model: EfficiencyModel; actions?: EfficiencyActions }) {
  return (
    <WithMessages namespaces={['people-efficiency', 'people', 'lists']}>
      <Efficiency model={model} actions={actions} />
    </WithMessages>
  )
}

function Efficiency({ model, actions }: { model: EfficiencyModel; actions?: EfficiencyActions | undefined }) {
  const t = useT('people-efficiency')
  const people = useWords()
  const locale = useLocale()
  const [help, setHelp] = useState(model.keysOpen ?? false)
  const [how, setHow] = useState(false)
  // A pop-over draws through a portal: only once the page is on the client.
  useEffect(() => setHow(model.howOpen ?? false), [model.howOpen])
  const { address } = model
  const overview = model.overview.status === 'ready' ? model.overview.value : null
  const range = rangeShown(address, overview)
  const days = model.trend.status === 'ready' ? daysWithFigures(model.trend.value.lines) : []
  const notice = model.notice
  const csvWords: CsvWords = { header: [t('lines.line'), t('lines.people'), t('tile.earned'), t('tile.attended'), t('tile.offStandard'), t('tile.efficiency'), t('tile.onStandard'), t('lines.planned')], noLine: t('lines.noLine'), tooFew: t('tooFew.short') }

  if (!model.can.view) return <NoPeopleAccess permission="people.efficiency.view" />

  const panels: Record<EfficiencySection, ReactNode> = {
    privacy: <PrivacyPanel model={model} actions={actions} />,
    tiles: <TilesPanel model={model} actions={actions} how={how} onHow={setHow} />,
    trend: <TrendPanel model={model} actions={actions} />,
    lines: <LinesPanel model={model} actions={actions} />,
    operations: <OperationsPanel model={model} actions={actions} days={days} onHelp={() => setHelp(true)} />,
    review: <ReviewPanel model={model} actions={actions} onHelp={() => setHelp(true)} />,
    individual: <IndividualPanel model={model} actions={actions} />,
  }

  return (
    <div className="fw-pp fw-ef">
      <div className="fw-pp-head">
        <span className="fw-pp-status">
          <PeoplePrivacyNote sight={model.sight} text={t('privacy.pill')} />
          {overview ? <AsOf at={overview.asOf} /> : null}
        </span>
        <span className="fw-pp-actions">
          <Button size="sm" onClick={() => actions?.onArrange?.(true)}>
            <SlidersHorizontal size={14} aria-hidden /> {t('band.arrange')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'export', label: t('band.export'), onSelect: () => actions?.onExport?.(csvWords), ...(overview ? {} : { disabled: true, description: t('held.reading') }) },
              { id: 'print', label: t('band.print'), href: printAddress(model.prefix, address), target: '_blank' },
              { id: 'how', label: t('how.title'), onSelect: () => setHow(true) },
              { id: 'keys', label: t('keys.title'), onSelect: () => setHelp(true) },
            ]}
          />
        </span>
      </div>

      <div className="fw-ef-scope" role="group" aria-label={t('scope.label')}>
        <DateRangePicker value={{ start: dateOfDay(range.from), end: dateOfDay(range.to) }} onChange={(next) => actions?.onAddress?.({ from: dayOfDate(next.start), to: dayOfDate(next.end), day: null })} />
        <Select size="sm" aria-label={t('scope.line')} value={address.lineId ?? ''} onChange={(event) => actions?.onAddress?.({ lineId: event.target.value || null })}>
          <option value="">{t('scope.allLines')}</option>
          {model.lines.map((line) => (
            <option key={line.id} value={line.id}>{`${line.code} · ${line.name}`}</option>
          ))}
        </Select>
        <Select size="sm" aria-label={t('scope.style')} value={address.styleId ?? ''} onChange={(event) => actions?.onAddress?.({ styleId: event.target.value || null })}>
          <option value="">{t('scope.allStyles')}</option>
          {model.styles.map((style) => (
            <option key={style.id} value={style.id}>{`${style.code} · ${style.name}`}</option>
          ))}
        </Select>
        <label className="fw-pp-row">
          <Toggle size="sm" checked={address.compare} aria-label={t('scope.compare')} onChange={(compare) => actions?.onAddress?.({ compare })} />
          <span className="fw-pp-hint">{t('scope.compare')}</span>
        </label>
        <ScopeSiteChip model={model.scope} />
        {model.updates > 0 && (
          <Button size="sm" variant="quiet" onClick={() => actions?.onShowUpdates?.()}>
            {t('updates', { count: model.updates })}
          </Button>
        )}
      </div>

      {notice && (
        <Banner
          tone={notice.tone}
          title={t(notice.key, { ...notice.params, count: notice.params?.count ?? 0 })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {people('common.close')}
            </Button>
          }
        >
          {notice.refused && notice.refused.length > 0 ? (
            <ul className="fw-pp-list">
              {notice.refused.map((entry) => (
                <li key={entry.label}>{`${entry.label}: ${entry.problem.ns === 'efficiency' ? t(entry.problem.words.key, entry.problem.words.params) : people(entry.problem.words.key, entry.problem.words.params)}`}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}

      <SectionLayout sections={model.specs} value={model.layout} onChange={() => undefined} className="fw-ef-sections">
        {Object.fromEntries(EFFICIENCY_SECTIONS.map((id) => [id, panels[id]]))}
      </SectionLayout>

      {address.day && <span className="fw-pp-hint">{t('operations.dayShown', { day: formatDate(`${address.day}T12:00:00Z`, { locale }) })}</span>}

      {model.detail && <ReviewDetail model={model} detail={model.detail} actions={actions} />}
      {model.person && <PersonDialog model={model.person} scope={{ from: range.from, to: range.to }} timeZone={model.timeZone} actions={actions?.person} />}
      {model.bulk && <BulkDecisionDialog bulk={model.bulk} actions={actions} />}
      {model.arranging && <ArrangeDialog specs={model.specs.map((spec) => ({ ...spec, label: t(`section.${spec.id}`) }))} layout={model.layout} onApply={(order) => actions?.onArranged?.(order)} onClose={() => actions?.onArrange?.(false)} />}
      {help && (
        <KeysModal
          own={[
            { keys: ['⇧K'], does: t('keys.keep') },
            { keys: ['C'], does: t('keys.change') },
            { keys: ['I'], does: t('keys.investigate') },
            { keys: ['J', 'K'], does: t('keys.moves') },
          ]}
          onClose={() => setHelp(false)}
        />
      )}
    </div>
  )
}
