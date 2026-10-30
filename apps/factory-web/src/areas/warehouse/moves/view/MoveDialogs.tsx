'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, Undo2 } from 'lucide-react'
import { Banner, Card, Field, KeyValue, Modal } from '@nexus/ui/components'
import { Button, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { LedgerRow } from '../../../_shared/stock/api'
import { money, quantity, reverseHeldKey, unitCost } from '../../../_shared/stock/model'
import { ReasonTag } from '../../../_shared/stock/parts'
import { mirrorOf, sideKey, type MovesPageActions, type MovesPageModel } from '../model'

/**
 * A move's detail (design mv-detail: a DetailModal reviewed in sequence; a move has no page of its own) and the reversal
 * (mv-reverse: the mirror move shown before it is posted, the reason required, refused in words when later moves used
 * the stock). J / K (and ⌘↑ / ⌘↓) walk the loaded rows; the worker is named only when the API names one (this one record,
 * at a site that records workers: Owner answer W1).
 */

function useSide() {
  const s = useT('stock')
  return (side: LedgerRow['from']) => {
    const key = sideKey(side)
    return key ? s(key) : side.location ? `${side.location.code} · ${side.location.name}` : '—'
  }
}

export function MoveDetailModal({ model, actions }: { model: MovesPageModel; actions?: MovesPageActions }) {
  const t = useT('warehouse-stock')
  const s = useT('stock')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const sideWords = useSide()
  const detail = model.detail!
  const order = (model.rows ?? []).map((row) => row.id)
  const at = model.address.open ? order.indexOf(model.address.open) : -1
  const previous = at > 0 ? order[at - 1]! : null
  const next = at >= 0 && at < order.length - 1 ? order[at + 1]! : null
  const latest = useRef(actions)
  latest.current = actions
  const value = detail.status === 'ready' ? detail.value : null
  const move = value?.move ?? null
  const held = move ? reverseHeldKey(move, model.can) : 'held.noReverse'

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select')) return
      const back = event.key === 'k' || ((event.metaKey || event.ctrlKey) && event.key === 'ArrowUp')
      const forth = event.key === 'j' || ((event.metaKey || event.ctrlKey) && event.key === 'ArrowDown')
      if (back && previous) {
        event.preventDefault()
        latest.current?.onOpen?.(previous)
      } else if (forth && next) {
        event.preventDefault()
        latest.current?.onOpen?.(next)
      } else if (event.key === 'r' && !event.metaKey && !event.ctrlKey && move && !held && !model.reverse) {
        event.preventDefault()
        latest.current?.onReverse?.(move)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const unit = (uom: LedgerRow['uom']) => s(`uom.${uom}`)
  const summary = (row: LedgerRow) => `${s(`reason.${row.reason}`)} · ${quantity(row.baseQuantity, locale)} ${unit(row.item.baseUom)} · ${formatDateTime(row.occurredAt, place)}`
  const docHref = (row: LedgerRow) => (row.document ? `${model.prefix}${row.document.type === 'GoodsReceipt' ? `/warehouse/receipts/${encodeURIComponent(row.document.id)}` : recordAddress({ type: 'WorkOrder', id: row.document.id }, OFFICE_PAGES)}` : null)
  const postedBy = (row: LedgerRow) =>
    row.postedBy.audience === 'FLOOR' ? (row.postedBy.device ? s('postedBy.FLOOR', { device: row.postedBy.device.name }) : s('postedBy.floorNoDevice')) : row.postedBy.audience === 'SYSTEM' ? s('postedBy.SYSTEM') : (row.postedBy.name ?? s('postedBy.officeNoName'))

  return (
    <Modal
      open
      onClose={() => actions?.onOpen?.(null)}
      size="detail"
      title={move ? t('mv.detail.title', { reason: s(`reason.${move.reason}`), material: move.item.code }) : t('mv.detail.titleLoading')}
      subtitle={move ? formatDateTime(move.occurredAt, place) : undefined}
      headerActions={
        <span className="fw-st-inline">
          <Button size="sm" variant="quiet" heldReason={previous ? null : t('mv.detail.first')} onClick={() => previous && actions?.onOpen?.(previous)} aria-keyshortcuts="k" aria-label={t('mv.detail.previous')}>
            <ChevronUp size={14} aria-hidden />
          </Button>
          <span className="fw-stk-hint">{at >= 0 ? t('mv.detail.position', { at: at + 1, count: order.length }) : null}</span>
          <Button size="sm" variant="quiet" heldReason={next ? null : t('mv.detail.last')} onClick={() => next && actions?.onOpen?.(next)} aria-keyshortcuts="j" aria-label={t('mv.detail.next')}>
            <ChevronDown size={14} aria-hidden />
          </Button>
        </span>
      }
      footer={
        <>
          <span className="fw-stk-hint">{t('mv.detail.keys')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onOpen?.(null)}>
            {s('common.close')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? s(held) : null} onClick={() => move && actions?.onReverse?.(move)} aria-keyshortcuts="r">
            <Undo2 size={13} aria-hidden /> {t('mv.reverse')}
          </Button>
        </>
      }
    >
      {detail.status === 'loading' ? (
        <p className="fw-stk-hint" role="status">
          <Spinner size={14} /> {t('mv.detail.loading')}
        </p>
      ) : detail.status === 'error' ? (
        <Banner
          tone="danger"
          title={s(detail.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetryDetail?.()}>
              {s('problem.retry')}
            </Button>
          }
        />
      ) : (
        move &&
        value && (
          <div className="fw-stk-detail">
            <Card padded>
              <h3 className="fw-stk-hint">{t('mv.detail.what')}</h3>
              <KeyValue
                labelCase="sentence"
                items={[
                  { label: t('mv.col.reason'), value: <ReasonTag reason={move.reason} /> },
                  { label: t('mv.col.material'), value: `${move.item.code} · ${move.item.name}`, hint: move.colour ? `${move.colour.code} ${move.colour.name}` : undefined },
                  ...(move.lot ? [{ label: t('mv.col.lot'), value: <Link className="fw-st-link" href={`${model.prefix}${recordAddress({ type: 'Lot', id: move.lot.id }, OFFICE_PAGES)}`}>{move.lot.code}</Link> }] : []),
                  ...(move.hide ? [{ label: t('mv.detail.hide'), value: <Link className="fw-st-link" href={`${model.prefix}${recordAddress({ type: 'Hide', id: move.hide.id }, OFFICE_PAGES)}`}>{move.hide.code}</Link> }] : []),
                  { label: t('mv.col.quantity'), value: `${quantity(move.baseQuantity, locale, 4)} ${unit(move.item.baseUom)}`, hint: move.uom !== move.item.baseUom ? t('mv.asEntered', { quantity: quantity(move.quantity, locale, 4), unit: unit(move.uom) }) : undefined },
                  { label: t('mv.col.from'), value: sideWords(move.from) },
                  { label: t('mv.col.to'), value: sideWords(move.to) },
                ]}
              />
            </Card>
            <Card padded>
              <h3 className="fw-stk-hint">{t('mv.detail.why')}</h3>
              <KeyValue
                labelCase="sentence"
                items={[
                  { label: t('mv.col.note'), value: move.note ?? t('mv.detail.noNote') },
                  { label: t('mv.col.document'), value: move.document && docHref(move) ? <Link className="fw-st-link" href={docHref(move)!}>{move.document.number}</Link> : (move.reference ?? '—'), hint: move.document && move.reference && move.reference !== move.document.number ? move.reference : undefined },
                  { label: t('mv.col.posted'), value: postedBy(move), hint: move.worker ? t('mv.detail.worker', { name: move.worker }) : move.postedBy.audience === 'FLOOR' && move.stationOnly ? t('mv.detail.stationOnly') : undefined },
                  { label: t('mv.detail.happened'), value: formatDateTime(move.occurredAt, place), hint: move.postedBy.audience === 'FLOOR' ? t('mv.detail.deviceClock') : undefined },
                  { label: t('mv.detail.recorded'), value: formatDateTime(move.createdAt, place) },
                  { label: t('mv.detail.key'), value: <code className="fw-st-sub">{move.idempotencyKey}</code> },
                ]}
              />
            </Card>
            {model.can.cost && (
              <Card padded>
                <h3 className="fw-stk-hint">{s('money.value')}</h3>
                {move.valuation ? (
                  <KeyValue
                    labelCase="sentence"
                    items={[
                      { label: t('mv.detail.method'), value: t(`mv.method.${move.valuation.method}`) },
                      { label: s('money.unitCost'), value: unitCost(move.valuation.unitCost, move.valuation.currency, locale) },
                      { label: s('money.value'), value: money(move.valuation.valueAmount, move.valuation.currency, locale) },
                    ]}
                  />
                ) : (
                  <p className="fw-stk-hint">{t('mv.detail.notValued')}</p>
                )}
              </Card>
            )}
            {(value.original || value.reversal) && (
              <Card padded>
                <h3 className="fw-stk-hint">{t('mv.detail.reversal')}</h3>
                {value.original && (
                  <p className="fw-stk-hint">
                    {t('mv.detail.reverses')}{' '}
                    <button type="button" className="fw-stk-reason-button" onClick={() => actions?.onOpen?.(value.original!.id)}>
                      {summary(value.original)}
                    </button>
                  </p>
                )}
                {value.reversal && (
                  <p className="fw-stk-hint">
                    {t('mv.detail.reversedBy')}{' '}
                    <button type="button" className="fw-stk-reason-button" onClick={() => actions?.onOpen?.(value.reversal!.id)}>
                      {summary(value.reversal)}
                    </button>
                  </p>
                )}
              </Card>
            )}
          </div>
        )
      )}
    </Modal>
  )
}

/** Reverse this move: the mirror shown first, the reason, Post reversal (one deliberate act at a time). */
export function ReverseDialog({ model, actions }: { model: MovesPageModel; actions?: MovesPageActions }) {
  const t = useT('warehouse-stock')
  const s = useT('stock')
  const locale = useLocale()
  const sideWords = useSide()
  const reverse = model.reverse!
  const mirror = mirrorOf(reverse.move)
  const note = reverse.note.trim()
  const held = model.can.reverse ? (reverse.posting ? t('rev.posting') : note.length === 0 ? t('rev.held.note') : note.length > 500 ? t('rev.held.long') : null) : s('held.noReverse')
  const unit = s(`uom.${reverse.move.item.baseUom}`)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        latest.current?.onPostReverse?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held])
  return (
    <Modal
      open
      onClose={() => actions?.onReverse?.(null)}
      size="md"
      title={t('rev.title')}
      subtitle={`${s(`reason.${reverse.move.reason}`)} · ${reverse.move.item.code}`}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onReverse?.(null)}>
            {s('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onPostReverse?.()} aria-keyshortcuts="Meta+Enter">
            <Undo2 size={13} aria-hidden /> {t('rev.post')}
          </Button>
        </>
      }
    >
      <div className="fw-stk-form">
        {reverse.problem && <Banner tone="danger" title={t(reverse.problem.key, reverse.problem.params)} />}
        <p className="fw-stk-hint">{t('rev.intro')}</p>
        <dl className="fw-stk-mirror">
          <dt>{t('mv.col.from')}</dt>
          <dd>{sideWords(mirror.from)}</dd>
          <dt>{t('mv.col.to')}</dt>
          <dd>{sideWords(mirror.to)}</dd>
          <dt>{t('mv.col.quantity')}</dt>
          <dd>{`${quantity(mirror.baseQuantity, locale, 4)} ${unit}`}</dd>
        </dl>
        <p className="fw-stk-preview">{t('rev.reach')}</p>
        <Field label={t('rev.note')} required hint={t('rev.noteHint')}>
          <Textarea value={reverse.note} onChange={(event) => actions?.onReverseNote?.(event.target.value)} limit={500} rows={3} autoFocus />
        </Field>
      </div>
    </Modal>
  )
}
