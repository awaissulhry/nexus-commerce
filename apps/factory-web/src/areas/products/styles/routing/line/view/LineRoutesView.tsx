'use client'

import { SlidersHorizontal, Undo2 } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Select, Tag } from '@nexus/ui/primitives'
import { DeptBar } from '../../../../../../lib/department/view/DeptBar'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { PartFailed, PartReading, Quiet, Section } from '../../../../../../lib/record-sections/Kit'
import type { Words } from '../../route/model'
import type { LineRow } from '../model'
import '../line.css'

/**
 * owb-pd6 step 6.4 (S4; design plan § 5v "Order › Production has a new section 'Route of each line'", § 5z; prototype prod.js
 * lineRoutesSec) — the section on the office order's Production tab (the base's slot, mounted after Team): each line with its steps as
 * the department bar, where its route comes from, and what the person may do — sales picks a model route; the production manager makes
 * "Another route for this order…" (the route builder, a reason needed) or goes "Back to the normal route". Once the basket cards are
 * printed every route is read only ("Fixed at the print of the basket cards"). Drawn with the section kit (lib/record-sections).
 * Draws its model; fetches nothing (_shared/parts/RouteOfEachLinePart.tsx). Office only: the customer never reaches it.
 */

export interface LineRoutesViewModel {
  readonly state: 'reading' | 'failed' | 'ready'
  /** A failed read: an `orders` problem key (the section kit's words). */
  readonly problem: string | null
  readonly answer: Words | null
  readonly rows: readonly LineRow[]
  /** The line a write runs on (its controls wait). */
  readonly busyLine: string | null
  /** Why "Another route for this order…" waits (the departments not read yet). */
  readonly exceptionHeld: Words | null
  readonly actProblem: Words | null
}

export interface LineRoutesViewActions {
  readonly onPick: (lineId: string, routeId: string | null) => void
  readonly onException: (lineId: string) => void
  readonly onBack: (lineId: string) => void
  readonly onRetry: () => void
}

export function LineRoutesView({ model, actions }: { model: LineRoutesViewModel; actions: LineRoutesViewActions }) {
  const t = useT('products-route')
  const locale = useLocale()
  const say = (words: Words) => t(words.key, words.params)
  return (
    <Section id="route-of-each-line" title={t('line.section')} answer={model.state === 'ready' && model.answer ? say(model.answer) : undefined} info={<p>{t('line.info')}</p>}>
      {model.state === 'reading' && <PartReading rows={2} height={28} />}
      {model.state === 'failed' && <PartFailed part={t('line.section')} problem={model.problem ?? 'problem.read.internal'} onRetry={actions.onRetry} />}
      {model.state === 'ready' && model.rows.length === 0 && <Quiet>{t('line.none')}</Quiet>}
      {model.state === 'ready' && model.rows.length > 0 && (
        <ul className="fw-lr-list">
          {model.rows.map((row) => {
            const busy = model.busyLine === row.lineId
            const title = say(row.title)
            return (
              <li key={row.lineId} className="fw-lr-row">
                <div className="fw-lr-head">
                  <b className="fw-lr-name">{title}</b>
                  {row.routeName && <span className="fw-lr-route">· {row.routeName}</span>}
                  <Tag tone={row.source.tone}>{t(row.source.key)}</Tag>
                </div>
                <DeptBar route={row.route} current={null} />
                {row.exception && (
                  <p className="fw-lr-why">
                    {t('line.why', { reason: row.exception.reason })}{' '}
                    <span className="fw-lr-when">{row.exception.by ? t('line.whenBy', { by: row.exception.by, date: formatDate(row.exception.at, { locale }) }) : t('line.when', { date: formatDate(row.exception.at, { locale }) })}</span>
                  </p>
                )}
                {(row.may.pick || row.may.exception || row.may.back) && (
                  <div className="fw-lr-acts">
                    {row.may.pick && (
                      <Select size="sm" value={row.pickValue} disabled={busy} aria-label={t('line.pickOf', { line: title })} onChange={(event) => actions.onPick(row.lineId, event.target.value || null)}>
                        <option value="">{t('line.normal')}</option>
                        {row.choices.map((choice) => (
                          <option key={choice.routeId} value={choice.routeId}>
                            {choice.name}
                          </option>
                        ))}
                      </Select>
                    )}
                    {row.may.exception && (
                      <Button size="sm" heldReason={busy ? t('held.busy') : model.exceptionHeld ? say(model.exceptionHeld) : null} onClick={() => actions.onException(row.lineId)}>
                        <SlidersHorizontal size={13} aria-hidden /> {t('line.another')}
                      </Button>
                    )}
                    {row.may.back && (
                      <Button size="sm" variant="quiet" heldReason={busy ? t('held.busy') : null} onClick={() => actions.onBack(row.lineId)}>
                        <Undo2 size={13} aria-hidden /> {t('line.back')}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {model.actProblem && <Banner tone="danger" title={say(model.actProblem)} />}
    </Section>
  )
}
