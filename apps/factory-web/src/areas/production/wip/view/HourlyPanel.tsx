'use client'

import { useEffect, useState } from 'react'
import { DetailPopover, EmptyState, PerformanceGraph } from '@nexus/ui/components'
import { Button, InfoTip, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { reasonWords } from '../../../../lib/line-board/model'
import type { Hour, HourlyAnswer, LineHours, ReasonOption } from '../api'
import { hourRow, reasonHeld, shortHours } from '../model'

/** A refusal in our words (catalogue keys). */
export type BoardRefusal = { readonly key: string; readonly fix: string | null }

export interface HourlyPanelModel {
  readonly hourly: { readonly value: readonly HourlyAnswer[] | null; readonly problem: string | null }
  readonly lineScope: string | null
  /** production.boards.targets: "Set targets". */
  readonly canSetTargets: boolean
  /** Design cases: the reason pop-up of this hour (its label) stands open. */
  readonly openReason?: string
}

export interface HourlyPanelActions {
  onSaveReason?: (hour: Hour, draft: { code: string; note: string }) => Promise<BoardRefusal | null>
  onSetTargets?: (line: LineHours['line']) => void
  onRetry?: () => void
}

const TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'>> = { success: 'success', warning: 'warning', danger: 'danger', info: 'info', neutral: 'neutral' }

/**
 * Floor now › Hour by hour (SCR-073 fn-hourly; design production.floor; MES-161): per line the pieces per hour as bars
 * against the line's hourly target as a line, each missed hour with the lead's reason under the graph; the lead adds it in
 * "Why was 10:00–11:00 short?". Targets are line targets, never per person. The office sets them in "Set targets".
 */
export function HourlyPanel({ model, actions }: { model: HourlyPanelModel; actions?: HourlyPanelActions }) {
  const t = useT('production-floor')
  const answers = model.hourly.value
  const lines = answers?.flatMap((answer) => answer.lines.filter((entry) => !model.lineScope || entry.line.id === model.lineScope).map((entry) => ({ entry, reasons: answer.reasons, site: answer.site }))) ?? null
  return (
    <section className="fw-fn-section" aria-labelledby="fw-fn-hourly">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2" id="fw-fn-hourly">
          {t('hourly.title')} <InfoTip tip={t('hourly.tip')} />
        </h2>
        <span className="fw-pr-hint">{t('hourly.hint')}</span>
      </div>
      {model.hourly.problem ? (
        <EmptyState title={t('hourly.failed')} description={t(model.hourly.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
      ) : !lines ? (
        <p className="fw-pr-hint" role="status">
          <Spinner size={12} /> {t('loading')}
        </p>
      ) : lines.length === 0 ? (
        <EmptyState title={t('hourly.none.title')} description={t('hourly.none.body')} />
      ) : (
        <div className="fw-fn-lines">
          {lines.map(({ entry, reasons, site }) => (
            <LineGraph key={entry.line.id} entry={entry} reasons={reasons} siteCode={(answers?.length ?? 0) > 1 ? site.code : null} model={model} actions={actions} />
          ))}
        </div>
      )}
    </section>
  )
}

function LineGraph({ entry, reasons, siteCode, model, actions }: { entry: LineHours; reasons: readonly ReasonOption[]; siteCode: string | null; model: HourlyPanelModel; actions?: HourlyPanelActions }) {
  const t = useT('production-floor')
  const { totals } = entry
  const missed = shortHours(entry)
  const hasTarget = entry.hours.some((hour) => hour.target !== null)
  return (
    <article className="fw-fn-line" aria-label={t('hourly.lineLabel', { line: `${entry.line.code} · ${entry.line.name}` })}>
      <div className="fw-fn-line-head">
        <h3 className="fw-pr-h3">
          {entry.line.code} · {entry.line.name}
          {siteCode ? ` · ${siteCode}` : ''}
        </h3>
        <span className="fw-pr-inline">
          <Tag tone={TONE[totals.paceLook.tone] ?? 'neutral'}>{t(`pace.${totals.pace}`)}</Tag>
          {model.canSetTargets && (
            <Button size="sm" onClick={() => actions?.onSetTargets?.(entry.line)}>
              {t('targets.open')}
            </Button>
          )}
        </span>
      </div>
      <p className="fw-pr-hint">{totals.targetSoFar === null ? t('hourly.doneNoTarget', { done: totals.done }) : t('hourly.done', { done: totals.done, target: totals.targetSoFar, day: totals.target ?? 0 })}</p>
      {entry.hours.length === 0 ? (
        <p className="fw-pr-hint">{t('hourly.noHours')}</p>
      ) : (
        <figure className="fw-fn-graph" aria-label={t('hourly.graphLabel', { line: entry.line.code })}>
          <PerformanceGraph
            data={entry.hours.map(hourRow)}
            xKey="hour"
            left={{
              key: 'pieces',
              label: t('hourly.pieces'),
              color: chart.actual,
              axis: 'left',
              shape: 'bar',
              stack: [
                { key: 'met', label: t('hourly.met'), color: chart.positive },
                { key: 'short', label: t('hourly.short'), color: chart.negative },
                { key: 'running', label: t('hourly.running'), color: chart.actual },
              ],
            }}
            right={{ key: 'target', label: t('hourly.target'), color: chart.reference, axis: 'left' }}
            height={200}
          />
        </figure>
      )}
      {!hasTarget && entry.hours.length > 0 && <p className="fw-pr-hint">{t('hourly.noTarget')}</p>}
      {missed.length > 0 && (
        <ul className="fw-fn-missed">
          {missed.map((hour) => (
            <MissedHour key={hour.hour} hour={hour} reasons={reasons} can={entry.canGiveReason} open={model.openReason === hour.label} onSave={actions?.onSaveReason} />
          ))}
        </ul>
      )}
    </article>
  )
}

function MissedHour({ hour, reasons, can, open, onSave }: { hour: Hour; reasons: readonly ReasonOption[]; can: boolean; open?: boolean; onSave?: HourlyPanelActions['onSaveReason'] }) {
  const t = useT('production-floor')
  const locale = useLocale()
  const words = hour.reason ? reasonWords(hour.reason, locale) : null
  return (
    <li className="fw-fn-miss">
      <span className="fw-fn-miss-hour">{hour.label}</span>
      <span className="fw-fn-miss-figures">{t('hourly.ofTarget', { done: hour.done, target: hour.target?.targetPieces ?? 0 })}</span>
      <span className="fw-fn-miss-why">
        {words ? (
          <>
            {words}
            {hour.reason?.note ? ` — ${hour.reason.note}` : ''}
          </>
        ) : (
          t('hourly.noReason')
        )}
        {hour.calls > 0 ? ` · ${t('hourly.calls', { count: hour.calls })}` : ''}
      </span>
      {can && <ReasonPopover hour={hour} reasons={reasons} defaultOpen={open} onSave={onSave} />}
    </li>
  )
}

function ReasonPopover({ hour, reasons, defaultOpen, onSave }: { hour: Hour; reasons: readonly ReasonOption[]; defaultOpen?: boolean; onSave?: HourlyPanelActions['onSaveReason'] }) {
  const t = useT('production-floor')
  const locale = useLocale()
  const [draft, setDraft] = useState({ code: hour.reason?.code ?? '', note: hour.reason?.note ?? '' })
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<BoardRefusal | null>(null)
  const [open, setOpen] = useState(false)
  // A design case opens it after the first paint (the panel is a portal: nothing of it on the server).
  useEffect(() => setOpen(Boolean(defaultOpen)), [defaultOpen])
  const title = t('reason.title', { hour: hour.label })
  const held = reasonHeld(reasons, draft)
  const save = async (close: () => void) => {
    setBusy(true)
    setRefused(null)
    const answer = (await onSave?.(hour, draft)) ?? null
    setBusy(false)
    if (answer) setRefused(answer)
    else close()
  }
  return (
    <DetailPopover trigger={hour.reason ? t('reason.change') : t('reason.add')} triggerLabel={title} triggerClassName="fw-fn-reason-open" label={title} hoverDelay={0} open={open} onOpenChange={setOpen}>
      {({ close }) => (
        <form
          className="fw-fn-reason"
          onSubmit={(event) => {
            event.preventDefault()
            if (!held && !busy) void save(close)
          }}
        >
          <h3 className="fw-pr-h3">{title}</h3>
          <label className="fw-fn-field">
            <span>{t('reason.code')}</span>
            <Select value={draft.code} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value }))}>
              <option value="">{t('reason.pick')}</option>
              {reasons.map((reason) => (
                <option key={reason.code} value={reason.code}>
                  {reasonWords(reason, locale)}
                </option>
              ))}
            </Select>
          </label>
          <label className="fw-fn-field">
            <span>{t('reason.note')}</span>
            <Textarea value={draft.note} rows={2} maxLength={500} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} />
          </label>
          {refused && (
            <p className="fw-fn-refused" role="alert">
              {t(refused.key)}
              {refused.fix ? ` ${t(refused.fix)}` : ''}
            </p>
          )}
          <Button type="submit" variant="primary" size="sm" heldReason={held ? t(held) : null} disabled={busy}>
            {busy ? t('saving') : t('reason.save')}
          </Button>
        </form>
      )}
    </DetailPopover>
  )
}
