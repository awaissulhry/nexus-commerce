'use client'

import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Banner, Card } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import type { CostOfOne, CostPart, Words } from '../model'
import '../cost.css'

/**
 * owb-pd5b step 5.3 (S4; design plan § 5zh "Cost of one piece, now"; prototype cost.js prodCostTab › sheet) — ONE bar of the 4 parts
 * with their percent, and a table that says HOW each part is worked out (Materials: the lines of the material list, the three biggest
 * shown · Work: the minutes of the route × the cost of one minute ÷ the efficiency · Overhead: a percent on the materials and the work ·
 * Other costs: outside work, freight, duty, packaging, commission). A size that misses an input says "known so far" and how many inputs
 * are missing — never a 0. The doors: "Keep … as the standard cost…" (the ONE primary of the page) and "The factory's rates…". On a
 * narrow room the table is small cards. Draws its model; fetches nothing.
 */

export interface CostLine {
  readonly key: string
  readonly name: string
  readonly how: string
  readonly amount: string | null
}

export interface CostPartRow {
  readonly part: CostPart
  readonly amount: string
  readonly share: number
  readonly how: Words
  /** The biggest lines (up to three), in words. */
  readonly lines: readonly CostLine[]
  /** How many lines more than shown. */
  readonly more: number
}

export interface CostNowModel {
  readonly state: 'reading' | 'failed' | 'ready' | 'empty'
  readonly problem: string | null
  readonly cost: CostOfOne | null
  readonly rows: readonly CostPartRow[]
  /** How many inputs are missing (listed under "More"). */
  readonly missing: number
  /** Writes an amount in the page's language and the sheet's currency. */
  readonly money: (amount: string | null | undefined) => string
  /** Why "Keep" waits (null: it opens the window). */
  readonly keepHeld: Words | null
}

export function CostNowCard({ model, onKeep, onRetry, ratesDoor }: { model: CostNowModel; onKeep: () => void; onRetry: () => void; ratesDoor?: ReactNode }) {
  const t = useT('products-cost')
  const say = (words: Words) => t(words.key, words.params)
  const cost = model.cost
  const doors = (
    <span className="fw-ct-doors">
      {ratesDoor}
      {cost && (
        <Button size="sm" variant="primary" heldReason={model.keepHeld ? say(model.keepHeld) : null} onClick={onKeep}>
          <Check size={13} aria-hidden /> {t('now.keep', { amount: model.money(cost.total ?? cost.knownTotal) })}
        </Button>
      )}
    </span>
  )
  return (
    <Card header={t('now.title')} headingLevel={2} description={cost ? t('now.intro', { size: cost.size }) : undefined} headerAction={model.state === 'ready' ? doors : ratesDoor}>
      {model.state === 'reading' && (
        <div className="fw-ct-body" aria-busy="true">
          <Skeleton height={28} />
          <Skeleton height={120} />
        </div>
      )}
      {model.state === 'failed' && (
        <Banner
          tone="danger"
          title={t('now.failed')}
          action={
            <Button size="sm" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem ?? 'problem.unavailable')}
        </Banner>
      )}
      {model.state === 'empty' && <p className="fw-ct-hint">{t('now.empty')}</p>}
      {model.state === 'ready' && cost && (
        <div className="fw-ct-body">
          <div className="fw-ct-bar" role="img" aria-label={t('now.barLabel', { parts: cost.parts.map((part) => `${t(`part.${part.part}`)} ${part.share} %`).join(', ') })}>
            {cost.parts
              .filter((part) => Number(part.amount) > 0)
              .map((part) => (
                <span key={part.part} className={`fw-ct-seg fw-ct-${part.part}`} style={{ flex: `${Math.max(0.5, Number(part.amount))} 1 0` }}>
                  {part.share >= 6 ? `${part.share} %` : ''}
                </span>
              ))}
          </div>
          <ul className="fw-ct-legend" aria-hidden>
            {cost.parts.map((part) => (
              <li key={part.part} className={`fw-ct-${part.part}`}>
                <span className="fw-ct-dot" />
                {t(`part.${part.part}`)} <b>{part.share} %</b>
              </li>
            ))}
          </ul>
          <div className="fw-ct-scroll">
            <table className="fw-ct-table" aria-label={t('now.title')}>
              <thead>
                <tr>
                  <th scope="col">{t('now.col.part')}</th>
                  <th scope="col">{t('now.col.how')}</th>
                  <th scope="col" className="fw-ct-num">
                    {t('now.col.amount')}
                  </th>
                  <th scope="col" className="fw-ct-num">
                    {t('now.col.share')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {model.rows.map((row) => [
                  <tr key={row.part} className={`fw-ct-group fw-ct-${row.part}`}>
                    <td>
                      <span className="fw-ct-name">
                        <span className="fw-ct-dot" aria-hidden />
                        {t(`part.${row.part}`)}
                      </span>
                    </td>
                    <td data-label={t('now.col.how')}>{say(row.how)}</td>
                    <td className="fw-ct-num" data-label={t('now.col.amount')}>
                      {model.money(row.amount)}
                    </td>
                    <td className="fw-ct-num" data-label={t('now.col.share')}>
                      {row.share} %
                    </td>
                  </tr>,
                  ...row.lines.map((line) => (
                    <tr key={`${row.part}:${line.key}`} className="fw-ct-sub">
                      <td>{line.name}</td>
                      <td>{line.how}</td>
                      <td className="fw-ct-num">{line.amount === null ? '—' : model.money(line.amount)}</td>
                      <td />
                    </tr>
                  )),
                  ...(row.more > 0
                    ? [
                        <tr key={`${row.part}:more`} className="fw-ct-sub">
                          <td colSpan={4}>{t('now.moreLines', { count: row.more })}</td>
                        </tr>,
                      ]
                    : []),
                ])}
                <tr className="fw-ct-total">
                  <td>{t('now.total')}</td>
                  <td>{cost.complete ? '' : <Tag tone="warning">{t('now.incomplete', { count: model.missing })}</Tag>}</td>
                  <td className="fw-ct-num">{cost.total !== null ? model.money(cost.total) : t('now.knownSoFar', { amount: model.money(cost.knownTotal) })}</td>
                  <td className="fw-ct-num">100 %</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  )
}
