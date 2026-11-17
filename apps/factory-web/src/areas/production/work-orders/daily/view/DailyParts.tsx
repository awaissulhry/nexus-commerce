'use client'

import Link from 'next/link'
import { ArrowRight, Lock, PauseCircle, Printer, Unlock } from 'lucide-react'
import { Card, EmptyState, Menu, MetricStrip, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { ReadinessWord, WorkOrder } from '../../../_shared/api'
import { quantityText } from '../../../_shared/model'
import {
  DAILY_NAMESPACE,
  holdHeld,
  holdReasonWords,
  leatherMaterials,
  READINESS_TONE,
  readinessPhrase,
  reserveHeld,
  scrapGroups,
  scrapTotals,
  yieldBars,
  type DailyActions,
  type DailyModel,
  type Part,
  type ReadinessView,
} from '../model'
import type { Phrase } from '../../../_shared/model'
import type { ScrapRow } from '../api'
import '../daily.css'

/** A phrase in words: a param that is itself a key (`status.DRAFT`) is said too. */
export function say(t: (key: string, params?: Record<string, string | number>) => string, words: Phrase | null): string | null {
  if (!words) return null
  const params = words.params ? Object.fromEntries(Object.entries(words.params).map(([name, value]) => [name, typeof value === 'string' && /^status\.[A-Z_]+$/.test(value) ? t(value) : value])) : undefined
  return t(words.key, params)
}

/**
 * The work order's W2a parts (B-W2a-46), each a DS composition the record's tabs place: the readiness word (Pill),
 * the holds card (wo-side "holds (W2a)", Put on hold / Release the hold), Report finished to stock's card, the yield
 * (wo-yield: MetricStrip and a bar per hide; never by cutter), scrap, rework and holds grouped by operation and reason
 * (wo-scrap), Reserve leather… (F-PR-06: on Materials and Cutting & bundles). The OperationFlow's piles went into the one
 * operation table of Operations & WIP (F-PR-06). Views only: they fetch nothing.
 */

const day = (value: string, locale: Locale) => formatDate(`${value.slice(0, 10)}T12:00:00Z`, { locale })

export function ReadinessPill({ word, date }: { word: ReadinessWord; date: string | null }) {
  const t = useT(DAILY_NAMESPACE)
  const locale = useLocale()
  const words = readinessPhrase(word, date)
  return <Pill tone={READINESS_TONE[word]}>{t(words.key, words.params?.date ? { date: day(String(words.params.date), locale) } : undefined)}</Pill>
}

/** A part while it loads or when its read failed (never drawn as empty). */
function PartLine<T>({ part, label, onRetry }: { part: Part<T>; label: string; onRetry?: () => void }) {
  const t = useT(DAILY_NAMESPACE)
  if (part.problem)
    return (
      <EmptyState
        title={t('part.failed', { part: label })}
        description={t(part.problem)}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          ) : undefined
        }
      />
    )
  return (
    <p className="fw-pr-hint" role="status">
      <Spinner size={14} /> {t('part.loading', { part: label })}
    </p>
  )
}

// ---- readiness beside the release check (wo-release "material available or expected") -------------------------------------------

export function ReadinessLine({ readiness }: { readiness: ReadinessView | null | undefined }) {
  const t = useT(DAILY_NAMESPACE)
  const locale = useLocale()
  if (!readiness) return null
  const attention = readiness.materials.filter((material) => material.word !== 'RECEIVED' && material.word !== 'EXPECTED')
  return (
    <div className="fw-wd-readiness">
      <span className="fw-wd-row">
        <b>{t('readiness.title')}</b> <ReadinessPill word={readiness.word} date={readiness.date} />
      </span>
      <span className="fw-pr-hint">{t(`readiness.hint.${readiness.word}`)}</span>
      {attention.length > 0 && (
        <ul className="fw-pr-check-problems">
          {attention.map((material) => (
            <li key={`${material.label}|${material.word}`}>
              {material.label} — <ReadinessPill word={material.word} date={material.date} />
              {Number(material.short) > 0 ? ` ${t('readiness.short', { quantity: quantityText(material.short, locale), uom: material.uom })}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- holds (wo-side "holds (W2a)"; wo-hold) -------------------------------------------------------------------------------------

export function HoldsCard({ workOrder, daily, actions }: { workOrder: WorkOrder; daily: DailyModel; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const locale = useLocale()
  const held = holdHeld(workOrder, daily.can, daily.busy)
  const own = workOrder.hold ?? null
  const holds = daily.holds?.value ?? null
  const active = (holds ?? []).filter((hold) => hold.status === 'ACTIVE')
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('holds.title')}</h2>
        {workOrder.status !== 'ON_HOLD' && (
          <Button size="sm" heldReason={say(t, held)} onClick={() => actions?.onDialog?.({ kind: 'hold', workOrderIds: [workOrder.id], numbers: [workOrder.number] })}>
            <PauseCircle size={14} aria-hidden /> {t('holds.put')}
          </Button>
        )}
      </div>
      {/* The page's banner says the hold and where it goes back; here only a hold another record lifts. */}
      {own && own.recordType && own.recordType !== 'QualityHold' && <p className="fw-pr-hint">{t('holds.underRecord')}</p>}
      {daily.holds === null ? (
        <p className="fw-pr-hint">{t('holds.noRight')}</p>
      ) : !holds ? (
        <PartLine part={daily.holds} label={t('holds.title')} onRetry={() => actions?.onRetry?.('holds')} />
      ) : active.length === 0 ? (
        <p className="fw-pr-hint">{t('holds.none')}</p>
      ) : (
        <ul className="fw-wd-holds" aria-label={t('holds.title')}>
          {active.map((hold) => (
            <li key={hold.id} className="fw-wd-hold">
              <Lock size={16} className="fw-pr-ico is-blocked" aria-hidden />
              <span className="fw-pr-check-body">
                <span>
                  <b>{holdReasonWords(hold.reasonCode, daily.reasons, locale)}</b> — {t('holds.since', { date: day(hold.placedAt, locale), count: hold.ageDays })}
                  {hold.overdue && (
                    <>
                      {' '}
                      <Tag tone="danger">{t('holds.overdue')}</Tag>
                    </>
                  )}
                </span>
                {hold.reasonNote && <span className="fw-pr-hint">{hold.reasonNote}</span>}
                {hold.expectedReleaseOn && <span className="fw-pr-hint">{t('holds.expected', { date: day(hold.expectedReleaseOn, locale) })}</span>}
              </span>
              <Button size="sm" variant="quiet" heldReason={daily.can.holdsRelease ? null : t('held.noHoldRelease')} onClick={() => actions?.onDialog?.({ kind: 'releaseHold', holdId: hold.id })}>
                <Unlock size={13} aria-hidden /> {t('holds.release')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="fw-pr-hint">{t('holds.hint')}</p>
    </Card>
  )
}

// ---- report finished to stock (wo-finish; wo-bundles "W2a Report finished to stock") ---------------------------------------------

// F-PR-05a: Report finished is the work order band's primary while garments wait (it moved out of the Bundles tab). F-PR-06: the
// card on Cutting & bundles keeps the figures only — ONE Report finished button per page, the band's — and says where it is.
export function FinishedCard({ daily, actions }: { daily: DailyModel; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const locale = useLocale()
  const part = daily.finished
  if (!part) return null
  const finished = part.value
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('finished.title')}</h2>
      </div>
      <p className="fw-pr-hint">{t('finished.inBand')}</p>
      {!finished ? (
        <PartLine part={part} label={t('finished.title')} onRetry={() => actions?.onRetry?.('finished')} />
      ) : (
        <>
          <MetricStrip
            metrics={[
              { label: t('finished.pieces'), value: String(finished.garments.pieces) },
              { label: t('finished.released'), value: String(finished.garments.netReleased) },
              { label: t('finished.inStock'), value: String(finished.garments.inStock) },
              { label: t('finished.canReport'), value: String(finished.garments.canReport) },
            ]}
          />
          {finished.reports.length > 0 ? (
            <SummaryTable
              label={t('finished.reports')}
              stackOnPhone
              columns={[t('finished.col.when'), t('finished.col.place'), t('finished.col.pieces'), t('finished.col.state')]}
              align={[undefined, undefined, 'right', undefined]}
              rows={finished.reports.map((report) => ({
                id: report.id,
                cells: [day(report.at, locale), report.locationCode ?? '—', String(report.pieces), report.reversed ? t('finished.reversed') : t('finished.open', { count: report.open })],
              }))}
            />
          ) : (
            <p className="fw-pr-hint">{t('finished.noReports')}</p>
          )}
          <p className="fw-pr-hint">{t(finished.tracking === 'SERIAL' ? 'finished.hintSerial' : 'finished.hint')}</p>
        </>
      )}
    </Card>
  )
}

// ---- Reserve leather… (wo-leather: the Find hides dialog) -------------------------------------------------------------------------

/**
 * Reserve leather… for the work order's leathers (one: a button; more: a menu, a leather each), held with its reason. F-PR-06: on
 * Materials and on Cutting & bundles' hides (the Cut record's Allocate hides), the same dialog and the same reservation.
 */
export function ReserveLeather({ workOrder, daily, actions }: { workOrder: WorkOrder; daily: DailyModel; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const leathers = leatherMaterials(workOrder)
  const wait = say(t, reserveHeld(workOrder, daily.can))
  const reserve = (material: (typeof leathers)[number]) => actions?.onDialog?.({ kind: 'reserve', itemId: material.itemId, itemColourId: material.itemColourId ?? null })
  if (leathers.length === 0) return null
  if (leathers.length === 1) {
    return (
      <Button size="sm" heldReason={wait} onClick={() => reserve(leathers[0]!)}>
        {t('reserve.button')}
      </Button>
    )
  }
  return <Menu label={t('reserve.button')} align="right" items={leathers.map((material) => ({ id: `${material.itemId}:${material.itemColourId ?? ''}`, label: [material.itemCode, material.colourCode].filter(Boolean).join(' · '), disabled: !!wait, description: wait ?? undefined, onSelect: () => reserve(material) }))} />
}

// ---- yield (wo-yield) -------------------------------------------------------------------------------------------------------------

export function YieldCard({ daily, actions }: { daily: DailyModel; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const locale = useLocale()
  const part = daily.yield
  if (!part) return null
  const value = part.value
  const pct = (text: string | null) => (text === null ? '—' : `${quantityText(text, locale)} %`)
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('yield.title')}</h2>
        {value && <span className="fw-pr-hint">{t(`yield.planned.${value.plannedSource}`)}</span>}
      </div>
      {!value ? (
        <PartLine part={part} label={t('yield.title')} onRetry={() => actions?.onRetry?.('yield')} />
      ) : value.hides.length === 0 ? (
        <p className="fw-pr-hint">{t('yield.none')}</p>
      ) : (
        <>
          <MetricStrip
            metrics={[
              { label: t('yield.yield'), value: pct(value.overall.yieldPct), hint: t('yield.plannedPct', { pct: pct(value.overall.plannedPct) }) },
              { label: t('yield.waste'), value: pct(value.overall.wastePct) },
              { label: t('yield.used'), value: quantityText(value.overall.used, locale), hint: t('yield.pattern', { area: quantityText(value.overall.pattern, locale) }) },
              { label: t('yield.remnant'), value: quantityText(value.overall.remnant, locale) },
            ]}
          />
          <ul className="fw-wd-bars" aria-label={t('yield.perHide')}>
            {yieldBars(value).map((bar) => (
              <li key={bar.hideId} className="fw-wd-bar">
                <span className="fw-pr-cell">
                  <span className="fw-pr-code">{bar.label}</span>
                  <span className="fw-pr-cell-sub">{t('yield.lot', { lot: bar.lot })}</span>
                </span>
                <ProgressBar value={bar.yieldPct} height={8} tone={bar.low ? 'partial' : 'complete'} ariaLabel={t('yield.barLabel', { hide: bar.label })} />
                <span className="fw-wd-num">
                  {bar.yieldPct === null ? '—' : `${quantityText(String(bar.yieldPct), locale)} %`}
                  {bar.low && (
                    <>
                      {' '}
                      <Tag tone="warning">{t('yield.low')}</Tag>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {Number(value.overall.unmatched) > 0 && <p className="fw-pr-hint">{t('yield.unmatched', { area: quantityText(value.overall.unmatched, locale) })}</p>}
          <p className="fw-pr-hint">{t('yield.noCutter')}</p>
        </>
      )}
    </Card>
  )
}

// ---- scrap, rework and holds (wo-scrap) ----------------------------------------------------------------------------------------

export function ScrapCard({ prefix, daily, actions }: { prefix: string; daily: DailyModel; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const locale = useLocale()
  const holds = (daily.holds?.value ?? []).filter((hold) => hold.status === 'ACTIVE').length + (daily.bundleHolds?.length ?? 0)
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('scrap.title')}</h2>
        <Link className="fw-pr-link" href={`${prefix}/quality/inspections`}>
          {t('scrap.toQuality')} <ArrowRight size={12} aria-hidden />
        </Link>
      </div>
      {daily.scrap === null ? (
        <p className="fw-pr-hint">{t('scrap.noRight')}</p>
      ) : !daily.scrap.value ? (
        <PartLine part={daily.scrap} label={t('scrap.title')} onRetry={() => actions?.onRetry?.('scrap')} />
      ) : (
        <ScrapBody rows={daily.scrap.value} holds={holds} locale={locale} />
      )}
    </Card>
  )
}

function ScrapBody({ rows, holds, locale }: { rows: ScrapRow[]; holds: number; locale: string }) {
  const t = useT(DAILY_NAMESPACE)
  const totals = scrapTotals(rows)
  const groups = scrapGroups(rows, locale)
  return (
    <>
      <MetricStrip
        metrics={[
          { label: t('scrap.scrapped'), value: String(totals.scrap) },
          { label: t('scrap.rework'), value: String(totals.rework), hint: t('scrap.reworkOpen', { count: totals.reworkOpen }) },
          { label: t('scrap.holds'), value: String(holds) },
        ]}
      />
      {groups.length === 0 ? (
        <p className="fw-pr-hint">{t('scrap.none')}</p>
      ) : (
        <SummaryTable
          label={t('scrap.byOperation')}
          stackOnPhone
          columns={[t('scrap.col.operation'), t('scrap.col.kind'), t('scrap.col.reason'), t('scrap.col.times'), t('scrap.col.pieces')]}
          align={[undefined, undefined, undefined, 'right', 'right']}
          rows={groups.map((group) => ({
            id: group.key,
            cells: [
              group.operation,
              <Tag key="k" tone={group.kind === 'SCRAP' ? 'danger' : 'warning'}>
                {t(`scrap.kind.${group.kind}`)}
              </Tag>,
              group.reason,
              String(group.rows),
              group.open > 0 ? t('scrap.piecesOpen', { pieces: group.pieces, open: group.open }) : String(group.pieces),
            ],
          }))}
        />
      )}
      <p className="fw-pr-hint">{t('scrap.hint')}</p>
    </>
  )
}

/** "Print pick list" / "Print cutting list": opens the print dialog (the document is drawn there and printed from the browser). */
export function PrintButton({ what, actions, held }: { what: 'pick' | 'cutting'; actions?: DailyActions; held?: string | null }) {
  const t = useT(DAILY_NAMESPACE)
  return (
    <Button size="sm" variant="quiet" heldReason={held ?? null} onClick={() => actions?.onDialog?.({ kind: 'print', what })}>
      <Printer size={13} aria-hidden /> {t(`print.${what}.button`)}
    </Button>
  )
}
