'use client'

import { Calculator, ListRestart, PencilLine } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { MarginMeter } from '@nexus/ui/charts/margin-meter/index'
import { Waterfall, type WaterfallStep } from '@nexus/ui/charts/waterfall/index'
import { Button, Input, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Textarea, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../../lib/i18n/provider'
import type { QuoteLine } from '../../../api'
import { percent, unitPrice, type Grains } from '../../../model'
import type { ListPriceLine, PriceReason, PricingLine } from '../api'
import { lineFlag, lineHeld, marginOf, netProblems, reasonLabel, sizeOrder, sizeSurchargesOf, stepWords, type CostBreakdown, type NetDraft, type Tone, type Words } from '../model'
import { PriceDepthMessages, usePriceWords } from '../words'
import { signedPrice } from './signed'
import '../price-depth.css'

type Part<T> = { status: 'loading' } | { status: 'error'; problem: Words } | { status: 'ready'; value: T }

export interface LineWaterfallModel {
  line: QuoteLine
  currency: string
  priceBasis: 'NET' | 'GROSS'
  grains: Grains
  /** Why the price cannot change here (not a draft, no right), or null. */
  readOnly: Words | null
  pricing: Part<{ line: PricingLine; floorPct: string | null | undefined }>
  /** GET …/list-prices of this line (the list, the break's pieces, the surcharges' scope); null: not read or none. */
  list: ListPriceLine | null
  reasons: readonly PriceReason[]
  /** The revision's cost sheet today (cost grain and costing.view): the breakdown, or why it is not shown. */
  cost: Part<CostBreakdown | null> | { status: 'held'; why: Words }
  /** The net form ("Change the net…") while open. */
  net: NetDraft | null
  saving: 'LIST' | 'SUGGESTED' | 'NET' | null
  notice: { words: Words; tone: Tone } | null
}

export interface LineWaterfallActions {
  onReprice?: (how: 'LIST' | 'SUGGESTED') => void
  onNetOpen?: (open: boolean) => void
  onNetDraft?: (next: NetDraft) => void
  onNetSave?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * The line drawer's "Cost breakdown and Waterfall" (design pop:quotes.lineDrawer, W2b): the waterfall from the start to
 * the net (the DS Waterfall: each step in this screen's words, its reason, the break's pieces, the list it came from), the
 * size surcharges beside it, what one piece costs on the revision's cost sheet today (materials, labour, overhead — the
 * cost grain) against the cost the quote keeps ("cost changed since priced"), the price the cost suggests at the floor
 * and the margin against the floor (the margin grain). Re-price from the list, price from the cost, change the net with
 * its reason — each held with its reason in words. It fetches nothing.
 */
export function LineWaterfallView({ model, actions }: { model: LineWaterfallModel; actions?: LineWaterfallActions }) {
  return (
    <PriceDepthMessages>
      <Body model={model} actions={actions} />
    </PriceDepthMessages>
  )
}

function Body({ model, actions }: { model: LineWaterfallModel; actions?: LineWaterfallActions }) {
  const { t, sales, say } = usePriceWords()
  const locale = useLocale()
  const ds = useDsWords()
  const lang = locale === 'it' ? 'it' : 'en'
  const { currency, grains, line } = model
  const money = (value: number) => formatNumber(value, locale, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 })
  const pct = (value: number) => percent(String(value), locale)

  if (!grains.price) return <p className="fw-q-hint">{t('drawer.noPrice')}</p>
  if (model.pricing.status === 'loading')
    return (
      <p className="fw-q-hint" role="status">
        <Spinner size={12} /> {t('common.loading')}
      </p>
    )
  if (model.pricing.status === 'error')
    return (
      <Banner
        tone="danger"
        title={t('drawer.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('common.retry')}
          </Button>
        }
      >
        {say(model.pricing.problem)}
      </Banner>
    )

  const pricing = model.pricing.value.line
  const floorPct = model.pricing.value.floorPct
  const steps = pricing.steps ?? null
  const reasonOf = (code: string) => reasonLabel(model.reasons, code, lang)
  const words = steps ? stepWords(steps, model.list, reasonOf) : []
  const chart: WaterfallStep[] = words
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.bar !== null)
    .map(({ entry, index }) => ({ id: `${entry.kind}-${index}`, kind: entry.bar!, label: say(entry.name), amount: entry.amount, note: entry.note ? say(entry.note) : undefined }))
  const surcharges = sizeSurchargesOf(steps)
  const sizes = sizeOrder(Object.keys(surcharges))
  const flag = lineFlag(pricing)
  const editable = model.readOnly === null
  const busy = model.saving !== null
  const held = (how: 'LIST' | 'SUGGESTED' | 'NET') => (model.readOnly ? say(model.readOnly) : busy ? t('held.busy') : say(lineHeld(pricing, how)) || null)
  const cost = model.cost
  const breakdown = cost.status === 'ready' ? cost.value : null
  const suggested = pricing.suggested

  return (
    <div className="fw-qp-drawer">
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {steps ? (
        <Waterfall steps={chart} label={t('drawer.waterfall', { line: line.seq })} format={money} labels={ds.waterfall} mismatchWords={(total, given) => t('drawer.mismatch', { total, given })} />
      ) : (
        <p className="fw-q-hint">{t(pricing.fromList ? 'drawer.noStepsList' : 'drawer.noSteps', { price: unitPrice(pricing.unitPrice, currency, locale) })}</p>
      )}
      {pricing.stepsProblem && <Banner tone="warning" title={t('drawer.stepsProblem')} />}
      {sizes.length > 0 && (
        <div className="fw-qp-sizes">
          <span className="fw-q-hint">{t('drawer.bySize')}</span>
          <ul className="fw-qp-chips" aria-label={t('drawer.bySize')}>
            {sizes.map((size) => {
              const scope = model.list?.sizeSurcharges.find((entry) => entry.size === size)?.scope
              return (
                <li key={size}>
                  <Tag tone="neutral">{t('drawer.sizeAdds', { size, amount: signedPrice(surcharges[size], currency, locale) })}</Tag>
                  {scope ? <span className="fw-qp-sub"> {t(`scope.${scope}`)}</span> : null}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {model.list?.list && (
        <p className="fw-q-hint">
          {model.list.list.validFrom || model.list.list.validTo
            ? t('drawer.listDays', { code: model.list.list.code, days: [model.list.list.validFrom, model.list.list.validTo].map((day) => (day ? formatDate(`${day}T12:00:00Z`, { locale }) : '…')).join(' – ') })
            : t('drawer.listAlways', { code: model.list.list.code })}
        </p>
      )}

      <h4 className="fw-qp-h4">{t('drawer.costTitle')}</h4>
      {!grains.cost ? (
        <p className="fw-q-hint">{t('drawer.noCostGrain')}</p>
      ) : cost.status === 'held' ? (
        <p className="fw-q-hint">{say(cost.why)}</p>
      ) : cost.status === 'loading' ? (
        <p className="fw-q-hint" role="status">
          <Spinner size={12} /> {t('common.loading')}
        </p>
      ) : cost.status === 'error' ? (
        <p className="fw-q-hint">{say(cost.problem)}</p>
      ) : !breakdown ? (
        <p className="fw-q-hint">{t('drawer.costNoCells')}</p>
      ) : (
        <>
          <Waterfall
            steps={[
              { id: 'material', kind: 'start', label: t('cost.material'), amount: breakdown.material },
              { id: 'labour', kind: 'step', label: t('cost.labour'), amount: breakdown.labour },
              ...(breakdown.overhead !== null ? [{ id: 'overhead', kind: 'step' as const, label: t('cost.overhead'), amount: breakdown.overhead }] : []),
              { id: 'cost', kind: 'total', label: t(breakdown.complete ? 'cost.total' : 'cost.known'), amount: null },
            ]}
            label={t('drawer.costChart', { line: line.seq })}
            format={money}
            good="down"
            labels={ds.waterfall}
          />
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('cost.kept'), value: line.costComplete ? unitPrice(line.unitCost, currency, locale) : sales('lines.costMissing') },
              {
                label: t('cost.today'),
                value:
                  breakdown.total === null ? (
                    t('cost.incomplete')
                  ) : (
                    <span className="fw-qp-inline">
                      {money(breakdown.total)}
                      {breakdown.changed !== null && breakdown.changed !== 0 ? <Tag tone={breakdown.changed > 0 ? 'warning' : 'info'}>{t(breakdown.changed > 0 ? 'cost.changedUp' : 'cost.changedDown', { amount: money(Math.abs(breakdown.changed)) })}</Tag> : null}
                    </span>
                  ),
              },
            ]}
          />
          {breakdown.changed !== null && breakdown.changed !== 0 && (
            <p className="fw-q-hint">{t(editable && pricing.suggested?.unitPrice ? 'cost.changedHint' : 'cost.changedHintView')}</p>
          )}
        </>
      )}

      {grains.margin && (
        <div className="fw-qp-margin">
          <MarginMeter
            value={pricing.marginPct === null || pricing.marginPct === undefined ? null : Number(pricing.marginPct)}
            floor={floorPct === null || floorPct === undefined ? null : Number(floorPct)}
            locale={INTL_LOCALE[locale]}
            format={pct}
            label={t('drawer.margin')}
            labels={ds.marginMeter}
          />
          {flag && <Tag tone={flag === 'negative' ? 'danger' : 'warning'}>{t(`flag.${flag}`)}</Tag>}
          {breakdown?.total !== null && breakdown?.total !== undefined && marginOf(pricing.unitPrice, breakdown.total) !== null && (
            <span className="fw-q-hint">{t('drawer.marginToday', { pct: pct(Math.round(marginOf(pricing.unitPrice, breakdown.total)! * 10) / 10) })}</span>
          )}
        </div>
      )}
      {suggested && suggested.unitPrice && (
        <p className="fw-q-hint">{grains.margin && suggested.marginPct ? t('drawer.suggestedAt', { price: unitPrice(suggested.unitPrice, currency, locale), pct: percent(suggested.marginPct, locale) }) : t('drawer.suggested', { price: unitPrice(suggested.unitPrice, currency, locale) })}</p>
      )}
      {suggested && !suggested.unitPrice && pricing.kind === 'SIZE_GRID' && <p className="fw-q-hint">{t(suggested.basedOn ? 'held.noCost' : 'held.noCostSheet')}</p>}

      <div className="fw-qp-actions">
        <Button size="sm" heldReason={held('LIST')} onClick={() => actions?.onReprice?.('LIST')}>
          {model.saving === 'LIST' ? <Spinner size={12} /> : <ListRestart size={13} aria-hidden />} {t('drawer.reprice')}
        </Button>
        <Button size="sm" heldReason={held('SUGGESTED')} onClick={() => actions?.onReprice?.('SUGGESTED')}>
          {model.saving === 'SUGGESTED' ? <Spinner size={12} /> : <Calculator size={13} aria-hidden />} {t('drawer.fromCost')}
        </Button>
        {!model.net && (
          <Button size="sm" heldReason={held('NET')} onClick={() => actions?.onNetOpen?.(true)}>
            <PencilLine size={13} aria-hidden /> {t('drawer.changeNet')}
          </Button>
        )}
      </div>
      {model.net && <NetForm model={model} actions={actions} />}
      {!editable && model.readOnly && <p className="fw-q-hint">{say(model.readOnly)}</p>}
    </div>
  )
}

function NetForm({ model, actions }: { model: LineWaterfallModel; actions?: LineWaterfallActions }) {
  const { t, say } = usePriceWords()
  const locale = useLocale()
  const lang = locale === 'it' ? 'it' : 'en'
  const draft = model.net!
  const current = model.pricing.status === 'ready' ? model.pricing.value.line.unitPrice : null
  const problems = netProblems(draft, current, model.reasons)
  const reason = model.reasons.find((entry) => entry.code === draft.reasonCode)
  const set = (patch: Partial<NetDraft>) => actions?.onNetDraft?.({ ...draft, ...patch })
  return (
    <form
      className="fw-qp-netform"
      aria-label={t('drawer.changeNet')}
      onSubmit={(event) => {
        event.preventDefault()
        if (problems.length === 0) actions?.onNetSave?.()
      }}
    >
      <div className="fw-qp-fields">
        <Field label={t('manual.net')} hint={t('manual.now') + ': ' + unitPrice(current, model.currency, locale)}>
          <Input inputMode="decimal" value={draft.text} onChange={(event) => set({ text: event.target.value })} aria-label={t('manual.net')} />
        </Field>
        <Field label={t('manual.reason')}>
          <Select value={draft.reasonCode} onChange={(event) => set({ reasonCode: event.target.value })} aria-label={t('manual.reason')}>
            <option value="">{t('manual.reasonPick')}</option>
            {model.reasons.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {reasonLabel(model.reasons, entry.code, lang)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={t(reason?.needsDetail ? 'manual.noteNeeded' : 'manual.note')}>
        <Textarea value={draft.note} onChange={(event) => set({ note: event.target.value })} rows={2} maxLength={500} aria-label={t('manual.note')} />
      </Field>
      <div className="fw-qp-actions">
        <Button size="sm" type="button" onClick={() => actions?.onNetOpen?.(false)}>
          {t('common.back')}
        </Button>
        <Button size="sm" type="submit" variant="primary" heldReason={problems.length > 0 ? say(problems[0]) : model.saving ? t('held.busy') : null}>
          {model.saving === 'NET' ? <Spinner size={12} /> : null} {t('manual.save')}
        </Button>
      </div>
    </form>
  )
}
