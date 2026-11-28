'use client'

import { Info, Pencil, Plus, Tag as TagIcon, Users, X } from 'lucide-react'
import { Banner, Card, KeyValue } from '@nexus/ui/components'
import { Button, FilterChip, Skeleton } from '@nexus/ui/primitives'
import { DeptChip } from '../../../../../lib/department/view/DeptChip'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { StyleRouteView } from '../route/api'
import { minutesWords, type RouteChip, type RouteRow, type Words } from '../route/model'
import '../route/route.css'

/**
 * owb-pd6 step 6.1 (S4; design plan § 5u, § 5v; prototype prod.js prodOpsTab) — the face of the product tab "Route": the chips (the
 * product's route, then one per model or customer route), the steps of the chosen route (number, the department chip, minutes, the
 * minutes of one piece), the rules as notes, the three doors ("Edit this route…", "New route…", "Take out" — held with words when
 * the person may not, or the revision is not a draft), and the card "Who decides the route" (the levels of § 5v in three lines).
 * Draws its model; fetches nothing (route/RouteContainer.tsx reads). Words: `products-route`.
 */

export interface RouteViewModel {
  /** `outside`: no office around (the design index, a test's render); `reading`; `failed` (with `problem`); `ready`. */
  readonly state: 'outside' | 'reading' | 'failed' | 'ready'
  readonly problem: string | null
  readonly chips: readonly RouteChip[]
  readonly chosen: StyleRouteView | null
  readonly rows: readonly RouteRow[]
  readonly total: string | null
  readonly notes: { readonly errors: readonly string[]; readonly warnings: readonly string[] }
  readonly answer: readonly Words[]
  readonly forWhom: Words
  /** Why the three doors are held; null: they act. */
  readonly held: Words | null
  /** "Start revision n…" is offered on a released revision with no draft yet (the record's own window). */
  readonly start: { readonly next: number } | null
  readonly busy: boolean
  /** A take-out the server refused, in words. */
  readonly actProblem: string | null
}

export interface RouteViewActions {
  readonly onChoose: (routeId: string | null) => void
  readonly onEdit: () => void
  readonly onNew: () => void
  readonly onTakeOut: () => void
  readonly onRetry: () => void
  readonly onStartRevision?: () => void
}

export function RouteView({ model, actions }: { model: RouteViewModel; actions: RouteViewActions }) {
  const t = useT('products-route')
  const locale = useLocale()
  const say = (words: Words) => t(words.key, words.params)
  const held = model.held ? say(model.held) : model.busy ? t('held.busy') : null
  const doors = (
    <span className="fw-rt-doors">
      <Button size="sm" heldReason={held} onClick={actions.onEdit}>
        <Pencil size={13} aria-hidden /> {t('action.edit')}
      </Button>
      <Button size="sm" heldReason={held} onClick={actions.onNew}>
        <Plus size={13} aria-hidden /> {t('action.new')}
      </Button>
      {model.chosen && (
        <Button size="sm" variant="quiet" heldReason={held} onClick={actions.onTakeOut} aria-label={t('action.takeOutOf', { name: model.chosen.name })}>
          <X size={13} aria-hidden /> {t('action.takeOut')}
        </Button>
      )}
    </span>
  )

  return (
    <div className="fw-rt-room">
      <div className="fw-rt">
        <Card header={t('routes.title')} headingLevel={2} description={model.state === 'ready' ? model.answer.map(say).join(' ') : undefined} headerAction={model.state === 'ready' ? doors : undefined}>
          {model.state === 'outside' && <p className="fw-rt-quiet">{t('routes.outside')}</p>}
          {model.state === 'reading' && (
            <div className="fw-rt-skel" aria-busy="true">
              <Skeleton height={24} />
              <Skeleton height={24} />
              <Skeleton height={24} />
            </div>
          )}
          {model.state === 'failed' && (
            <Banner
              tone="danger"
              title={t('routes.failed')}
              action={
                <Button size="sm" onClick={actions.onRetry}>
                  {t('common.retry')}
                </Button>
              }
            >
              {t(model.problem ?? 'problem.unavailable')}
            </Banner>
          )}
          {model.state === 'ready' && (
            <div className="fw-rt-body">
              <div className="fw-rt-chips" role="group" aria-label={t('routes.which')}>
                {model.chips.map((chip) => (
                  <FilterChip key={chip.id ?? 'product'} size="md" pressed={chip.pressed} onClick={() => actions.onChoose(chip.id)}>
                    {chip.kind === 'PRODUCT' ? (
                      t('routes.product')
                    ) : (
                      <span className="fw-rt-chip">
                        {chip.kind === 'CUSTOMER' ? <Users size={13} aria-hidden /> : <TagIcon size={13} aria-hidden />}
                        <span className="fw-rt-chip-name">{chip.name}</span>
                        {chip.party ? <span className="fw-rt-chip-party">· {chip.party.code}</span> : null}
                      </span>
                    )}
                  </FilterChip>
                ))}
              </div>
              <p className="fw-rt-for">{say(model.forWhom)}</p>

              {model.rows.length === 0 ? (
                <p className="fw-rt-quiet">{t('routes.empty')}</p>
              ) : (
                <div className="fw-rt-scroll">
                  <table className="fw-rt-table" aria-label={t('routes.tableOf', { name: model.chosen ? model.chosen.name : t('routes.product') })}>
                    <thead>
                      <tr>
                        <th scope="col" className="fw-rt-no">
                          {t('col.step')}
                        </th>
                        <th scope="col">{t('col.department')}</th>
                        <th scope="col" className="fw-rt-num">
                          {t('col.minutes')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.rows.map((row) => (
                        <tr key={row.no}>
                          <td className="fw-rt-no">{row.no}</td>
                          <td>{row.dept ? <DeptChip dept={row.dept} /> : <span className="fw-rt-old">{row.name || t('routes.noDepartment')}</span>}</td>
                          <td className="fw-rt-num">{minutesWords(row.minutes, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {model.rows.length > 0 && <p className="fw-rt-total">{model.total === null ? t('routes.noMinutes') : t('routes.total', { minutes: minutesWords(model.total, locale) })}</p>}

              {model.notes.errors.length > 0 && (
                <Banner tone="warning" title={t('routes.rulesTitle', { count: model.notes.errors.length })}>
                  <ul className="fw-rt-list">
                    {model.notes.errors.map((key) => (
                      <li key={key}>{t(key)}</li>
                    ))}
                  </ul>
                </Banner>
              )}
              {model.notes.warnings.map((key) => (
                <p key={key} className="fw-rt-note">
                  <Info size={14} aria-hidden /> {t(key)}
                </p>
              ))}
              {model.actProblem && <Banner tone="danger" title={t(model.actProblem)} />}
              {model.held && model.held.key === 'held.released' && (
                <p className="fw-rt-note">
                  <Info size={14} aria-hidden /> {say(model.held)}
                  {model.start && actions.onStartRevision && (
                    <Button size="sm" variant="quiet" onClick={actions.onStartRevision}>
                      {t('action.startRevision', { revision: model.start.next })}
                    </Button>
                  )}
                </p>
              )}
            </div>
          )}
        </Card>

        <Card header={t('who.title')} headingLevel={2} description={t('who.answer')}>
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('who.product.label'), value: t('who.product.value') },
              { label: t('who.model.label'), value: t('who.model.value') },
              { label: t('who.line.label'), value: t('who.line.value') },
            ]}
          />
        </Card>
      </div>
    </div>
  )
}
