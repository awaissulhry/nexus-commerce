'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Pencil, RefreshCw } from 'lucide-react'
import { Banner, Card, KeyValue, type KeyValueItem } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { Timeline } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { quantity, type Phrase } from '../../../../_shared/stock/model'
import type { Lifecycle, LotDepth } from '../api'
import { DEPTH_NAMESPACE, HISTORY_TONE, historyWords, LIFECYCLE_TONE, lifecycleBehind } from '../model'
import type { LotDepthActions, LotDepthModel } from '../view-model'

/**
 * B-W2b-320 — the lot's W2b parts drawn inside W1's lot record (SCR-201-record): the lifecycle pill and card (state, since,
 * depleted, a move the handler has not handled yet with Check, the family, the history), the attributes as facts (lt-facts
 * W2b), the incoming inspection on the release card (lt-release W2b), the separation of duties (lt-status W2b), the
 * incoming inspections beside the holds (lt-holds W2b). Words: `warehouse-lots-counts` (`ld.*`); never the API's English.
 */

export type DepthWords = (key: string, params?: Readonly<Record<string, string | number>>) => string

export function useDepthWords(): { t: DepthWords; say: (words: Phrase | null | undefined) => string | null } {
  const t = useT(DEPTH_NAMESPACE)
  return useMemo(() => ({ t, say: (words: Phrase | null | undefined) => (words ? t(words.key, words.params) : null) }), [t])
}


export function LifecyclePill({ state }: { state: Lifecycle }) {
  const { t } = useDepthWords()
  return <Pill tone={LIFECYCLE_TONE[state]}>{t(`ld.life.state.${state}`)}</Pill>
}

/** The notice of the last W2b write (a check, a saved attribute), with its close. */
export function DepthNotice({ model, actions }: { model: LotDepthModel; actions?: LotDepthActions }) {
  const { t, say } = useDepthWords()
  if (!model.notice) return null
  return (
    <Banner
      tone={model.notice.tone}
      title={say(model.notice.words) ?? ''}
      action={
        <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
          {t('ld.common.close')}
        </Button>
      }
    />
  )
}

/** The lifecycle card (design lt-stock "depleted 3 Nov", SCM-236): state, since, behind the ledger, family, history. */
export function LifecycleCard({ model, actions, prefix, timeZone }: { model: LotDepthModel; actions?: LotDepthActions; prefix: string; timeZone: string }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const place = { locale, timeZone }
  const depth = model.depth.value
  return (
    <Card padded>
      <div className="fw-wl-stack tight">
        <h3 className="fw-wl-h3">{t('ld.life.title')}</h3>
        {!depth ? (
          model.depth.problem ? (
            <p className="fw-wl-hint">
              {t('ld.common.readFailed')}{' '}
              <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.()}>
                {t('ld.common.retry')}
              </Button>
            </p>
          ) : (
            <p className="fw-wl-hint" role="status">
              <Spinner size={12} /> {t('ld.common.reading')}
            </p>
          )
        ) : (
          <>
            <span className="fw-wl-chips">
              <LifecyclePill state={depth.lifecycle.state} />
              <span className="fw-wl-hint">{t('ld.life.since', { date: formatDate(depth.lifecycle.since, place) })}</span>
            </span>
            <p className="fw-wl-text">{t(`ld.life.means.${depth.lifecycle.state}`)}</p>
            {depth.lifecycle.depletedAt && <p className="fw-wl-hint">{t('ld.life.depletedAt', { date: formatDate(depth.lifecycle.depletedAt, place) })}</p>}
            {lifecycleBehind(depth) && (
              <Banner
                tone="info"
                title={t('ld.life.behind', { expected: t(`ld.life.state.${depth.lifecycle.expected}`) })}
                action={
                  <Button size="sm" heldReason={model.can.manage ? (model.checking ? t('ld.common.working') : null) : t('ld.life.noRight')} onClick={() => actions?.onCheck?.()}>
                    <RefreshCw size={13} aria-hidden /> {t('ld.life.check')}
                  </Button>
                }
              />
            )}
            <Family depth={depth} prefix={prefix} />
            {depth.lifecycle.history.length > 0 ? (
              <Timeline
                label={t('ld.life.history')}
                steps={[...depth.lifecycle.history].reverse().map((row, index) => ({
                  key: `${row.at}-${index}`,
                  label: say(historyWords(row)) ?? '',
                  tone: HISTORY_TONE[row.kind],
                  at: row.at,
                  detail: row.kind === 'LIFECYCLE' && row.from && row.to ? t('ld.life.fromTo', { from: t(`ld.life.state.${row.from}`), to: t(`ld.life.state.${row.to}`) }) : undefined,
                }))}
              />
            ) : (
              <p className="fw-wl-hint">{t('ld.life.noHistory')}</p>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

/** The lot it was split from, or the lots split from it (each with its stock). */
function Family({ depth, prefix }: { depth: LotDepth; prefix: string }) {
  const { t } = useDepthWords()
  const locale = useLocale()
  const href = (id: string) => `${prefix}${recordAddress({ type: 'Lot', id }, OFFICE_PAGES)}`
  const unit = t(`ld.uom.${depth.lot.item.baseUom}`)
  if (depth.family.parent) {
    return (
      <p className="fw-wl-text">
        {t('ld.family.childOf')}{' '}
        <Link className="fw-st-link fw-wl-code" href={href(depth.family.parent.id)}>
          {depth.family.parent.code}
        </Link>
      </p>
    )
  }
  if (depth.family.children.length === 0) return null
  return (
    <div className="fw-wl-stack tight">
      <h4 className="fw-wl-h3">{t('ld.family.children', { count: depth.family.children.length })}</h4>
      <ul className="fw-wl-checks">
        {depth.family.children.map((child) => (
          <li key={child.id} className="fw-st-inline">
            <Link className="fw-st-link fw-wl-code" href={href(child.id)}>
              {child.code}
            </Link>
            <LifecyclePill state={child.lifecycle} />
            {child.shade && <span className="fw-st-sub">{t('ld.family.shade', { shade: child.shade })}</span>}
            <span className="fw-st-num">{t('ld.family.stock', { hides: child.hidesInStock, quantity: quantity(child.onHand, locale), unit })}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The W2b attributes as facts (lt-facts "thickness range, finish, tannage, grade, origin"): items for W1's KeyValue. */
export function attributeItems(depth: LotDepth | null, t: DepthWords, locale: string): KeyValueItem[] {
  if (!depth) return []
  const values = depth.attributes.values
  const text = (key: string) => (typeof values[key] === 'string' ? (values[key] as string) : null)
  const items: KeyValueItem[] = []
  const keys = depth.attributes.keys
  const number = (value: string | null) => (value === null ? null : quantity(value, locale as 'it' | 'en', 2))
  if (keys.includes('thicknessMinMm')) {
    const min = number(text('thicknessMinMm'))
    const max = number(text('thicknessMaxMm'))
    items.push({ label: t('ld.attr.thickness'), value: min && max ? t('ld.attr.range', { min, max }) : min ? t('ld.attr.from', { min }) : max ? t('ld.attr.upTo', { max }) : '—' })
  }
  for (const key of keys) {
    if (key === 'thicknessMinMm' || key === 'thicknessMaxMm') continue
    const mix = values.gradeMix && typeof values.gradeMix === 'object' ? Object.entries(values.gradeMix) : []
    const value = key === 'gradeMix' ? (mix.length > 0 ? mix.map(([grade, share]) => t('ld.attr.gradeShare', { grade, share: number(share) ?? share })).join(' · ') : null) : key === 'tannage' ? (text('tannage') ? t(`ld.attr.tannages.${text('tannage')}`) : null) : key === 'widthCm' || key === 'weightGsm' ? (text(key) ? t(`ld.attr.${key}Value`, { value: number(text(key)) ?? '' }) : null) : text(key)
    items.push({ label: t(`ld.attr.${key}`), value: value || '—' })
  }
  return items
}

/** The facts card's W2b part: the attributes, Edit (inventory.lots.manage), the family's documents ending soon. */
export function AttributesFacts({ model, actions }: { model: LotDepthModel; actions?: LotDepthActions }) {
  const { t } = useDepthWords()
  const locale = useLocale()
  const depth = model.depth.value
  if (!depth) return null
  const edit = depth.attributes.canEdit ? null : !model.can.manage ? t('ld.attr.noRight') : t('ld.attr.rejected')
  return (
    <div className="fw-wl-stack tight">
      <div className="fw-wl-card-head">
        <h4 className="fw-wl-h3">{t('ld.attr.title')}</h4>
        <Button size="sm" heldReason={edit} onClick={() => actions?.onAttributes?.(true)}>
          <Pencil size={13} aria-hidden /> {t('ld.attr.edit')}
        </Button>
      </div>
      <KeyValue dense columns={3} labelCase="sentence" items={attributeItems(depth, t, locale)} />
      {Object.keys(depth.attributes.values).length === 0 && <p className="fw-wl-hint">{t('ld.attr.none')}</p>}
      {(depth.documents.expiring > 0 || depth.documents.expired > 0) && (
        <p className="fw-wl-hint fw-st-warning">{t('ld.docs.ending', { expiring: depth.documents.expiring, expired: depth.documents.expired })}</p>
      )}
    </div>
  )
}

const INCOMING_TONE = { NOT_INSPECTED: 'neutral', OPEN: 'warning', PASSED: 'success', FAILED: 'danger', CANCELLED: 'neutral' } as const

/** The release card's W2b check (lt-release "incoming inspection passed"): read from the lot's (or its parent's) inspections. */
export function IncomingCheck({ model, prefix }: { model: LotDepthModel; prefix: string }) {
  const { t } = useDepthWords()
  const depth = model.depth.value
  if (!depth) return null
  const incoming = depth.incoming
  const row = incoming.number ? incoming.inspections.find((inspection) => inspection.number === incoming.number) : undefined
  return (
    <p className="fw-wl-text">
      <b>{t('ld.incoming.name')}</b> · <Tag tone={INCOMING_TONE[incoming.state]}>{t(`ld.incoming.state.${incoming.state}`)}</Tag>{' '}
      {row && (
        <Link className="fw-st-link fw-wl-code" href={`${prefix}${recordAddress({ type: 'IncomingInspection', id: row.id }, OFFICE_PAGES)}`}>
          {row.number}
        </Link>
      )}
      {row?.from === 'PARENT' && <span className="fw-st-sub"> · {t('ld.incoming.fromParent')}</span>}
      <span className="fw-wl-hint"> · {t('ld.incoming.labNote')}</span>
    </p>
  )
}

/** The separation of duties on release (lt-status W2b): who received the lot never releases it (names inside the record only). */
export function SeparationLine({ model }: { model: LotDepthModel }) {
  const { t } = useDepthWords()
  const depth = model.depth.value
  if (!depth) return null
  const sep = depth.separation
  return (
    <div className="fw-wl-stack tight">
      <p className="fw-wl-text">
        <b>{t('ld.sep.title')}</b> · <Tag tone={sep.state === 'NOT_KEPT' ? 'danger' : sep.state === 'KEPT' ? 'success' : sep.viewerReceived ? 'warning' : 'neutral'}>{t(`ld.sep.state.${sep.state}`)}</Tag>
      </p>
      <p className="fw-wl-hint">{sep.state === 'WAITING' ? t(sep.viewerReceived ? 'ld.sep.youReceived' : 'ld.sep.waiting') : t(`ld.sep.means.${sep.state}`)}</p>
      {(sep.receivedBy || sep.decidedBy) && (
        <p className="fw-wl-hint">{[sep.receivedBy ? t('ld.sep.receivedBy', { name: sep.receivedBy.name }) : null, sep.decidedBy ? t('ld.sep.decidedBy', { name: sep.decidedBy.name }) : null].filter(Boolean).join(' · ')}</p>
      )}
    </div>
  )
}

const RESULT_TONE = { PASS: 'success', FAIL: 'danger' } as const

/** The incoming inspections that touch the lot (lt-holds W2b), its own and, for a child lot, its parent's. */
export function IncomingList({ model, prefix, timeZone }: { model: LotDepthModel; prefix: string; timeZone: string }) {
  const { t } = useDepthWords()
  const locale = useLocale()
  const depth = model.depth.value
  if (!depth) return null
  const rows = depth.incoming.inspections
  return (
    <div className="fw-wl-stack tight">
      <h4 className="fw-wl-h3">{t('ld.incoming.listTitle', { count: rows.length })}</h4>
      {rows.length === 0 ? (
        <p className="fw-wl-hint">{t('ld.incoming.none')}</p>
      ) : (
        <ul className="fw-wl-checks">
          {rows.map((row) => (
            <li key={row.id} className="fw-st-inline">
              <Link className="fw-st-link fw-wl-code" href={`${prefix}${recordAddress({ type: 'IncomingInspection', id: row.id }, OFFICE_PAGES)}`}>
                {row.number}
              </Link>
              <Pill tone={row.status === 'OPEN' ? 'warning' : row.result ? RESULT_TONE[row.result] : 'neutral'}>{row.status === 'DECIDED' && row.result ? t(`ld.incoming.result.${row.result}`) : t(`ld.incoming.status.${row.status}`)}</Pill>
              {row.decidedAt && <span className="fw-st-sub">{t('ld.incoming.decided', { date: formatDateTime(row.decidedAt, { locale, timeZone }) })}</span>}
              {row.from === 'PARENT' && <span className="fw-st-sub">{t('ld.incoming.fromParent')}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** "Nothing left · depleted 3 Nov" (lt-stock W2b), or nothing while the lot holds stock. */
export function DepletedLine({ model, timeZone }: { model: LotDepthModel; timeZone: string }) {
  const { t } = useDepthWords()
  const locale = useLocale()
  const depth = model.depth.value
  if (!depth?.lifecycle.depletedAt) return null
  return <p className="fw-wl-hint">{t('ld.life.nothingLeft', { date: formatDate(depth.lifecycle.depletedAt, { locale, timeZone }) })}</p>
}

