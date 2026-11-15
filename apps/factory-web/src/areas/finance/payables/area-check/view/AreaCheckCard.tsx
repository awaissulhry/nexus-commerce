'use client'

import Link from 'next/link'
import { Ruler } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { decimal } from '../../../_shared/model'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES, type Phrase } from '../../../payments/riba/depth'
import type { AreaLine } from '../api'
import { AREA_TONE, claimHeld, type AreaCan } from '../model'
import '../../payables.css'
import '../../../_shared/finance.css'

export interface AreaCheckModel {
  prefix: string
  can: AreaCan
  /** The leather lines (null while read). */
  lines: AreaLine[] | null
  /** A failed read (a `finance` key), never drawn as empty. */
  problem: string | null
  /** The line whose claim is being opened. */
  busy: string | null
  /** A refused claim, on its line. */
  claimProblem: { lineId: string; phrase: Phrase } | null
  /** The claim just opened, on its line. */
  opened: { lineId: string; claim: { id: string; number: string } } | null
}

export interface AreaCheckActions {
  onRetry?: () => void
  onClaim?: (line: AreaLine) => void
}

/**
 * SCR-516 — the leather area check in a supplier invoice's three-way match (design finance.payables rec:Supplier invoice ›
 * Match › three-way "Leather area check (W2b): invoiced sq ft vs measured sq ft received; beyond tolerance → 'Open area
 * claim'"): per goods line of a hide-tracked material, what the supplier bills (this line and its other live invoices of the
 * order line) against the area measured on the hides received (an unmeasured hide counts with the area it came with: the
 * words say how many were measured), the difference and the tolerance in force (the order line's, else the leather
 * setting's), the outcome — within, short, over, nothing received — and, when short, "Open area claim" (a DRAFT claim for the
 * shortfall in Purchasing, sent by a person). No money in this section.
 */
export function AreaCheckCard({ model, actions }: { model: AreaCheckModel; actions?: AreaCheckActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: AreaCheckModel; actions?: AreaCheckActions }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const s = useScopedT('finance')
  const title = (
    <h3 className="fw-fpy-h3">
      <Ruler size={14} aria-hidden /> {p('area.title')}
    </h3>
  )
  if (model.problem) {
    return (
      <Card padded>
        <div className="fw-fpy-stack">
          {title}
          <Banner tone="danger" title={p('area.failed')}>
            {t(model.problem)}
          </Banner>
          <span className="fw-fpy-inline">
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          </span>
        </div>
      </Card>
    )
  }
  if (!model.lines) {
    return (
      <Card padded aria-busy="true">
        <div className="fw-fpy-stack">
          {title}
          <Skeleton height={16} />
          <Skeleton height={16} />
        </div>
      </Card>
    )
  }
  if (model.lines.length === 0) {
    return (
      <Card padded>
        <div className="fw-fpy-stack">
          {title}
          <p className="fw-fpy-muted">{p('area.none')}</p>
        </div>
      </Card>
    )
  }
  return (
    <Card padded>
      <div className="fw-fpy-stack">
        {title}
        <p className="fw-fpy-muted">{p('area.explain')}</p>
        {model.lines.map((line) => (
          <AreaLineRow key={line.lineId} line={line} model={model} onClaim={() => actions?.onClaim?.(line)} heldWords={(phrase) => (phrase ? s(phrase.key, phrase.params) : null)} />
        ))}
      </div>
    </Card>
  )
}

function AreaLineRow({ line, model, onClaim, heldWords }: { line: AreaLine; model: AreaCheckModel; onClaim: () => void; heldWords: (phrase: Phrase | null) => string | null }) {
  const p = useT(PAY_DEPTH)
  const s = useScopedT('finance')
  const locale = useLocale()
  const unit = line.item.baseUom
  const area = (value: string) => p('area.value', { value: decimal(value, locale, 2), unit })
  const check = line.check
  const held = claimHeld(line, model.busy !== null)
  const orderText = p('area.order', { number: line.order.number, line: line.order.lineSeq })
  const problem = model.claimProblem?.lineId === line.lineId ? model.claimProblem.phrase : null
  const opened = model.opened?.lineId === line.lineId ? model.opened.claim : null
  return (
    <section className="fw-fpy-stack" aria-label={p('area.lineLabel', { seq: line.seq })}>
      <div className="fw-fpy-head">
        <span>
          <strong>{p('area.line', { seq: line.seq })}</strong> · {line.item.code} {line.item.name} ·{' '}
          {model.can.purchasing ? (
            <Link className="fw-fin-link" href={`${model.prefix}/purchasing/orders/${line.order.id}`}>
              {orderText}
            </Link>
          ) : (
            orderText
          )}
        </span>
        {check ? <Pill tone={AREA_TONE[check.outcome]}>{p(`area.outcome.${check.outcome}`)}</Pill> : <Pill tone="neutral">{p('area.outcome.NO_AREA')}</Pill>}
      </div>
      {check && (
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={[
            { label: p('area.invoiced'), value: check.invoiced === check.invoicedTotal ? area(check.invoiced) : p('area.invoicedWithOthers', { line: area(check.invoiced), total: area(check.invoicedTotal) }) },
            { label: p('area.measured'), value: area(check.measured) },
            { label: p('area.hides'), value: check.unmeasuredHides > 0 ? p('area.hidesSome', { measured: check.measuredHides, all: check.measuredHides + check.unmeasuredHides }) : p('area.hidesAll', { count: check.measuredHides }) },
            { label: p('area.difference'), value: p('area.differenceValue', { area: area(check.difference), percent: decimal(check.differencePercent, locale, 2) }) },
            { label: p('area.tolerance'), value: p(`area.toleranceFrom.${line.toleranceFrom}`, { percent: decimal(line.tolerancePercent, locale, 2) }) },
            ...(check.opensClaim ? [{ label: p('area.shortfall'), value: area(check.shortfall) }] : []),
          ]}
        />
      )}
      {!check && <p className="fw-fpy-muted">{p('area.noAreaBody')}</p>}
      {line.claim.existing.length > 0 && (
        <p className="fw-fpy-muted">
          {p('area.existing', { count: line.claim.existing.length })}{' '}
          {line.claim.existing.map((claim, index) => (
            <span key={claim.id}>
              {index > 0 && ', '}
              {model.can.purchasing ? (
                <Link className="fw-fin-link" href={`${model.prefix}/purchasing/claims/${claim.id}`}>
                  {claim.number}
                </Link>
              ) : (
                claim.number
              )}
            </span>
          ))}
        </p>
      )}
      {opened && (
        <Banner tone="success" title={p('area.opened', { number: opened.number })}>
          {model.can.purchasing ? (
            <Link className="fw-fin-link" href={`${model.prefix}/purchasing/claims/${opened.id}`}>
              {p('area.openClaim')}
            </Link>
          ) : (
            p('area.openedBody')
          )}
        </Banner>
      )}
      {problem && <Banner tone="danger" title={s(problem.key, problem.params)} />}
      {check?.opensClaim && !opened && (
        <span className="fw-fpy-inline">
          <Button size="sm" variant="primary" heldReason={heldWords(held)} onClick={onClaim}>
            {p('area.claim')}
          </Button>
        </span>
      )}
    </section>
  )
}
