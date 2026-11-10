'use client'

import { ArrowLeftRight } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { VersionCompare } from '@nexus/ui/patterns/VersionCompare/index'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { Redline } from '../../../changes/view/Redline'
import { VERSIONS_NS } from '../../release/model'
import type { VersionRow } from '../api'
import { byNewest, costLines, costState, moneyOf, pairHeld, type VersionsActions, type VersionsModel } from '../model'

/**
 * Compare revisions (design products.styles style.ver.compare and pop:styles.compare; PRD-168): two revisions of the style
 * picked (the released one against the draft by default; ⇄ swaps them), then B-W2b-244's redline of B-W2b-220's compare —
 * one DS VersionCompare per part that differs (BOM, routing and minutes, measurement spec, protectors, pattern pieces, the
 * revision's label and release scope), the unchanged parts named — and the cost difference, only with the cost grain: both
 * revisions priced with today's inputs, per colourway the cost per garment of each size ("Not in your role" without the
 * grain; held without costing.view over the style's company). Nothing here writes.
 */
export function CompareBody({ model, actions }: { model: VersionsModel; actions?: VersionsActions }) {
  const tv = useT(VERSIONS_NS)
  const tr = useT('products')
  const rows = model.versions.status === 'ready' ? byNewest(model.versions.value.revisions) : []
  if (model.versions.status === 'loading' || model.versions.status === 'idle')
    return (
      <p className="fw-st-hint" role="status">
        <Spinner size={14} /> {tv('base.reading')}
      </p>
    )
  if (model.versions.status === 'error')
    return (
      <Banner
        tone="danger"
        title={tv('ver.failed')}
        action={
          <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.('versions')}>
            {tv('base.retry')}
          </Button>
        }
      />
    )
  const held = pairHeld(rows, model.pair)
  const option = (row: VersionRow) => (
    <option key={row.id} value={row.id}>
      {tv('ver.option', { revision: row.revision, status: tr(`revisionStatus.${row.status}`) })}
    </option>
  )
  return (
    <div className="fw-st-stack">
      {rows.length >= 2 && (
        <div className="fw-ver-pair">
          <Field label={tv('pair.from')}>
            <Select size="sm" value={model.pair?.from ?? ''} onChange={(event) => model.pair && actions?.onPair?.({ from: event.target.value, to: model.pair.to })}>
              {rows.map(option)}
            </Select>
          </Field>
          <Button size="sm" variant="quiet" onClick={() => actions?.onSwap?.()} aria-label={tv('pair.swap')} title={tv('pair.swap')}>
            <ArrowLeftRight size={14} aria-hidden />
          </Button>
          <Field label={tv('pair.to')}>
            <Select size="sm" value={model.pair?.to ?? ''} onChange={(event) => model.pair && actions?.onPair?.({ from: model.pair.from, to: event.target.value })}>
              {rows.map(option)}
            </Select>
          </Field>
        </div>
      )}
      {held ? (
        <p className="fw-st-hint">{tv(held)}</p>
      ) : (
        <>
          <Redline model={{ compare: model.compare.status === 'ready' ? model.compare.value : null, problem: model.compare.status === 'error' ? model.compare.problem : null }} onRetry={() => actions?.onRetry?.('compare')} />
          {model.compare.status === 'ready' && <CostPart model={model} />}
        </>
      )}
    </div>
  )
}

/** The cost difference (cost grain): one VersionCompare of the colourways, priced with today's inputs. */
function CostPart({ model }: { model: VersionsModel }) {
  const tv = useT(VERSIONS_NS)
  const tr = useT('products')
  const ds = useDsWords()
  const locale = useLocale() as Locale
  if (model.compare.status !== 'ready') return null
  const compare = model.compare.value
  const state = costState(compare)
  if (state === 'absent') return <p className="fw-st-hint">{tv('costCmp.notInRole')}</p>
  if (state === 'held' || !compare.cost) return <p className="fw-st-hint">{tv('costCmp.held')}</p>
  const cost = compare.cost
  const money = moneyOf(cost.currency, locale)
  return (
    <section className="fw-st-stack" aria-label={tv('costCmp.title')}>
      <h3 className="fw-st-h3">{tv('costCmp.title')}</h3>
      <p className="fw-st-hint">{tv('costCmp.how', { day: formatDate(`${cost.on}T12:00:00Z`, { locale }) })}</p>
      {(!cost.complete.before || !cost.complete.after) && <Banner tone="warning" title={tv('costCmp.incomplete', { count: cost.missing.length })} />}
      <div className="fw-chg-bleed">
        <VersionCompare
          before={{ label: tv('ver.rev', { revision: compare.before.revision }), note: tr(`revisionStatus.${compare.before.status}`) }}
          after={{ label: tv('ver.rev', { revision: compare.after.revision }), note: tr(`revisionStatus.${compare.after.status}`) }}
          lines={costLines(cost, money)}
          fields={cost.fields.map((field) => ({ id: field.id, label: ['material', 'labour', 'overhead'].includes(field.id) ? tv(`costCmp.field.${field.id}`) : field.label }))}
          sizes={cost.sizes}
          totals={cost.totals.map((total) => ({ ...total, label: tv('costCmp.total'), before: total.before === null ? null : money(total.before), after: total.after === null ? null : money(total.after) }))}
          locale={INTL_LOCALE[locale]}
          formatQuantity={money}
          labels={ds.versionCompare}
        />
      </div>
    </section>
  )
}
