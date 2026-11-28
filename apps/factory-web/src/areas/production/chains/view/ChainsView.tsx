'use client'

import { Check, Hourglass, Route, RotateCcw } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, Pill, Select } from '@nexus/ui/primitives'
import { DeptChip } from '../../../../lib/department/view/DeptChip'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { departmentOf } from '../../baskets/model'
import type { Chain, ChainLine } from '../api'
import { CHAINS_NAMESPACE, cellFull, cellOf, cellShare, slowestOf } from '../model'
import '../chains.css'

/**
 * owb-fl9 step 3 — Production › Chains (design § 4.8, § 5d; P/lines.js chainHead, chainMatrix): pick a chain, then every model and size
 * (a lot) at every step: done and waiting per cell; the slowest step in red with its number and the word "Slowest" and how many wait
 * (never colour alone). The table scrolls inside its frame on a narrow window, never the page. The view fetches nothing.
 */

export interface ChainsModel {
  readonly lines: readonly ChainLine[]
  readonly lineId: string | null
  readonly chain: Chain | null
  readonly state: 'loading' | 'ready' | 'failed'
  readonly problem: string | null
}

export function ChainsView({ model, onLine, onRetry }: { model: ChainsModel; onLine: (lineId: string) => void; onRetry: () => void }) {
  const t = useT(CHAINS_NAMESPACE)
  const locale = useLocale()
  const chain = model.chain
  const slow = chain ? slowestOf(chain) : null
  return (
    <div className="fw-ch-page">
      <div className="fw-ch-bar">
        <Field label={t('chain.pick')} htmlFor="fw-ch-line">
          <Select id="fw-ch-line" value={model.lineId ?? ''} onChange={(event) => onLine(event.target.value)}>
            {model.lineId === null ? <option value="">{t('chain.none')}</option> : null}
            {model.lines.map((line) => (
              <option key={line.id} value={line.id}>
                {line.name}
              </option>
            ))}
          </Select>
        </Field>
        {slow ? (
          <Pill tone="danger" icon={<Hourglass aria-hidden />}>
            {t('chain.slowest', { no: slow.index + 1, step: slow.step.name, count: slow.step.waiting })}
          </Pill>
        ) : null}
      </div>
      {model.state === 'failed' ? <Banner tone="danger" title={t(model.problem ?? 'error.read')} action={<Button size="sm" onClick={onRetry}><RotateCcw aria-hidden /> {t('chain.retry')}</Button>} /> : null}
      {model.state === 'loading' ? <p className="fw-ch-muted">{t('chain.loading')}</p> : null}
      {model.state === 'ready' && model.lines.length === 0 ? <EmptyState icon={<Route aria-hidden />} title={t('chain.noLines')} description={t('chain.noLinesHint')} /> : null}
      {model.state === 'ready' && chain && chain.lots.length === 0 ? <p className="fw-ch-muted">{t('chain.noLots')}</p> : null}
      {model.state === 'ready' && chain && chain.lots.length > 0 ? (
        <div className="fw-ch-frame">
          <table className="fw-ch-table">
            <caption className="fw-ch-caption">{t('chain.caption', { name: chain.line.name })}</caption>
            <thead>
              <tr>
                <th scope="col" className="fw-ch-lot">
                  {t('chain.lot')}
                </th>
                {chain.steps.map((step, index) => (
                  <th key={step.operationId} scope="col" data-slowest={step.slowest || undefined}>
                    <span className="fw-ch-head">
                      <span className="fw-ch-no">{index + 1}</span>
                      {step.department ? <DeptChip dept={departmentOf(step.department, locale)} /> : <span>{step.name}</span>}
                    </span>
                    <span className="fw-ch-total">{t('chain.done', { count: step.done })}</span>
                    {step.slowest ? (
                      <span className="fw-ch-slow">
                        <Hourglass aria-hidden /> {t('chain.slowWord', { count: step.waiting })}
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chain.lots.map((lot) => (
                <tr key={lot.workOrderSizeId}>
                  <th scope="row" className="fw-ch-lot">
                    <span className="fw-ch-model">{lot.model}</span> <span className="fw-ch-size">{lot.size}</span>
                    {lot.quantity !== undefined ? <span className="fw-ch-muted">{t('chain.pieces', { count: lot.quantity })}</span> : null}
                  </th>
                  {chain.steps.map((step) => {
                    const cell = cellOf(lot, step.operationId)
                    const full = cellFull(lot, cell.done)
                    return (
                      <td key={step.operationId} data-full={full || undefined} data-slowest={step.slowest || undefined}>
                        <span className="fw-ch-cell">
                          {full ? <Check aria-hidden className="fw-ch-tick" /> : null}
                          <b>{cell.done}</b>
                          {lot.quantity !== undefined ? <span className="fw-ch-of">/ {lot.quantity}</span> : null}
                        </span>
                        {cell.waiting > 0 ? <span className="fw-ch-wait">{t('chain.waiting', { count: cell.waiting })}</span> : null}
                        {lot.quantity !== undefined ? (
                          <span className="fw-ch-bar-track" aria-hidden>
                            <i style={{ inlineSize: `${cellShare(lot, cell.done)}%` }} />
                          </span>
                        ) : null}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
