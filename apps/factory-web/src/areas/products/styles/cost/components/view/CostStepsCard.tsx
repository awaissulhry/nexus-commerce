'use client'

import { useState } from 'react'
import { Lock } from 'lucide-react'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Grains } from '../../../model'
import { decimalText, moneyText } from '../../../model'
import type { ComponentsView } from '../../versions/api'
import { CS_NS, typedPieces, type Read } from '../../versions/model'
import { howWords, lineWords, sizeInView, sizeTotal, stepsFor, type ComponentLine } from '../model'
import { How, SheetStep } from './parts'

export interface CostStepsModel {
  /** The live components of the revision in view (B-W2b-418), for the colourway in view and the garments per carton typed. */
  components: Read<ComponentsView>
  /** The size asked (W1's cost cell); the card falls back to the base size. */
  size: string | null
  /** The garments per carton the components were asked with (no column keeps it). */
  cartonPieces: number | null
  grains: Grains
}

export interface CostStepsActions {
  onSize?: (size: string) => void
  onCartonPieces?: (pieces: number | null) => void
  onRetry?: () => void
}

/**
 * SCR-502 — the cost sheet's W2b steps (design products.styles › Cost › Cost sheet: Subcontract, Packaging, Freight and duties
 * on materials, Commissions — each a step that opens to its lines, with "How is this made?"): the live components of the
 * revision in view for one size, the garments per carton the carton's share needs (typed: no column keeps it), every step
 * together, and what is missing or worth a look, in words. Without the cost grain the steps keep their lines and quantities,
 * never a figure.
 */
export function CostStepsCard({ model, actions }: { model: CostStepsModel; actions?: CostStepsActions }) {
  const t = useT(CS_NS)
  const tp = useT('products')
  const locale = useLocale()
  const [pieces, setPieces] = useState(model.cartonPieces === null ? '' : String(model.cartonPieces))
  const part = model.components
  const header = t('steps.title')
  if (part.status === 'idle' || part.status === 'loading')
    return (
      <Card header={header} aria-busy="true">
        <p className="fw-st-hint" role="status">
          <Spinner size={14} /> {t('steps.loading')}
        </p>
      </Card>
    )
  if (part.status === 'error')
    return (
      <Card header={header}>
        <EmptyState title={t('steps.failed')} description={t(part.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('csCommon.retry')}</Button>} />
      </Card>
    )
  const view = part.value
  const size = sizeInView(view, model.size)
  const money = (value: string | null | undefined) => (model.grains.cost && value !== undefined && value !== null ? moneyText(value, view.currency, locale) : null)
  const number = (value: string) => decimalText(value, locale)
  const kindWords = (kind: string) => tp(`kind.${kind}`)
  const typed = typedPieces(pieces)
  const piecesProblem = pieces.trim() !== '' && typed === null ? t('steps.cartonProblem') : undefined
  if (!size)
    return (
      <Card header={header}>
        <EmptyState title={t('steps.noSizes')} description={t('steps.noSizesBody')} />
      </Card>
    )
  const steps = stepsFor(view.lines, size)
  const total = sizeTotal(view, size)
  const lineRows = (lines: readonly ComponentLine[]) =>
    lines.map((line, index) => {
      const words = lineWords(line, kindWords)
      const what = t(words.key, words.params)
      const how = howWords(line, money, number)
      return {
        id: `${line.seq ?? index}:${line.size ?? '*'}:${index}`,
        cells: [
          <span key="w" className="fw-st-cellstack">
            <b>{what}</b>
            <span className="nds-summary-sub">{t(`stepSource.${line.source}`)}</span>
          </span>,
          line.size === null ? t('steps.everySize') : line.size,
          line.uom ? `${number(line.quantity)} ${tp(`uom.${line.uom}`)}` : line.pct !== undefined && line.pct !== null ? `${number(line.pct)} %` : number(line.quantity),
          ...(model.grains.cost ? [money(line.unitCost) ?? '·'] : []),
          <span key="c" className="fw-st-inline fw-st-nowrap">
            {model.grains.cost ? (money(line.cost) ?? '·') : null}
            <How label={what}>
              <p>{t(how.key, how.params)}</p>
            </How>
          </span>,
        ],
      }
    })
  const columns = [t('steps.col.what'), t('steps.col.size'), t('steps.col.quantity'), ...(model.grains.cost ? [t('steps.col.unitCost')] : []), model.grains.cost ? t('steps.col.cost') : t('steps.col.how')]
  const align = [undefined, undefined, 'right' as const, ...(model.grains.cost ? ['right' as const] : []), 'right' as const]
  return (
    <Card header={header} description={t('steps.intro', { revision: view.revision.revision, colourway: view.colourway.code })}>
      <div className="fw-st-stack">
        {!model.grains.cost && <Banner tone="info" icon={<Lock size={16} aria-hidden />} title={t('steps.noGrain')} />}
        <div className="fw-st-cellpick fw-cs-tools">
          <label className="fw-st-scope">
            <span className="fw-st-hint">{t('steps.size')}</span>
            <Select size="sm" value={size} aria-label={t('steps.size')} onChange={(event) => actions?.onSize?.(event.target.value)}>
              {view.sizes.map((entry) => (
                <option key={entry} value={entry}>
                  {entry === view.style.baseSize ? t('steps.baseSizeOption', { size: entry }) : entry}
                </option>
              ))}
            </Select>
          </label>
          <form
            className="fw-cs-carton"
            onSubmit={(event) => {
              event.preventDefault()
              if (pieces.trim() === '') actions?.onCartonPieces?.(null)
              else if (typed !== null) actions?.onCartonPieces?.(typed)
            }}
          >
            <Field label={t('steps.carton')} hint={t('steps.cartonHint')} error={piecesProblem}>
              <Input size="sm" inputMode="numeric" value={pieces} onChange={(event) => setPieces(event.target.value)} />
            </Field>
            <Button size="sm" type="submit" heldReason={piecesProblem || (pieces.trim() === '' && model.cartonPieces === null) ? t('steps.cartonHeld') : (pieces.trim() === '' ? null : typed) === model.cartonPieces ? t('steps.cartonSame') : null}>
              {t('steps.cartonApply')}
            </Button>
          </form>
        </div>
        {steps.map((step) => (
          <SheetStep
            key={step.id}
            summary={
              <span className="fw-st-sheetrow">
                <span>{t(`steps.step.${step.id}`)}</span>
                {step.lines.length === 0 ? <Tag tone="neutral">{t('steps.none')}</Tag> : <Tag tone="neutral">{t('steps.lines', { count: step.lines.length })}</Tag>}
                <span className="fw-st-grow" />
                {model.grains.cost && <b>{step.lines.length === 0 ? '—' : (money(step.amount) ?? '—')}</b>}
              </span>
            }
          >
            {step.lines.length === 0 ? (
              <p className="fw-st-hint">{t(`steps.empty.${step.id}`)}</p>
            ) : (
              <SummaryTable label={t(`steps.step.${step.id}`)} stackOnPhone columns={columns} align={align} rows={lineRows(step.lines)} />
            )}
          </SheetStep>
        ))}
        <div className="fw-st-sheetrow fw-st-sheetrow-total">
          <span>{t('steps.total', { size })}</span>
          {!total.complete && <Tag tone="warning">{t('steps.incomplete')}</Tag>}
          <span className="fw-st-grow" />
          {model.grains.cost ? <b>{total.complete ? (money(total.total) ?? '—') : t('steps.knownSoFar', { amount: money(total.knownTotal) ?? '—' })}</b> : <span className="fw-st-hint">{t('steps.notInRole')}</span>}
        </div>
        <p className="fw-st-hint">{t('steps.versionsNote')}</p>
        {view.missing.length > 0 && (
          <Banner tone="warning" title={t('steps.missingTitle', { count: view.missing.length })}>
            <ul className="fw-st-list">
              {view.missing.map((entry) => (
                <li key={entry.key}>
                  {t(`stepMissing.${entry.code}`)}
                  {entry.size ? ` ${t('steps.inSize', { size: entry.size })}` : ''}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        {view.warnings.length > 0 && (
          <Banner tone="info" title={t('steps.warningsTitle', { count: view.warnings.length })}>
            <ul className="fw-st-list">
              {view.warnings.map((entry, index) => (
                <li key={`${entry.code}:${entry.recordId ?? index}`}>{t(`stepWarn.${entry.code}`)}</li>
              ))}
            </ul>
          </Banner>
        )}
      </div>
    </Card>
  )
}
