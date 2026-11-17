'use client'

import { useState } from 'react'
import { AlertTriangle, Lock, X } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { Button, Select, Skeleton, Spinner, Textarea } from '@nexus/ui/primitives'
import { HEALTH_NOTE_MAX, HEALTH_REASON_CODES, type HealthReasonCode } from '@nexus/factory-domain/production-brand/health'
import { PROMISE_REASON_WORDS } from '@nexus/factory-domain/sales/portal-orders/promise'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { HealthPill } from '../../../../../../lib/production/view/HealthPill'
import { WaitingOnPill } from '../../../../../../lib/production/view/WaitingOnPill'
import type { BrandHealthView } from '../api'
import { clearHeld, healthInputOf, healthStateOf, raiseHeld, raiseOpenHeld, type HealthActions, type HealthModel, type HealthPart } from '../model'

const day = (value: string, locale: 'it' | 'en') => formatDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value, { locale })

/**
 * F-PR-05a — the Overview's Health card (06-tree A.4; 09-design §2(c) "Health — 'Bea Esempio, 14 Nov: re-run Saturday' (Office
 * only)"): per order of the work order the chip the customer reads, what the dates say, a person's raise with its curated reason and
 * the office's own note marked Office only, until when it stands, who the order waits on, and Raise to At risk… / Clear the raise
 * (production.brand.manage; held with the reason). The customer reads the chip and the reason, never the note (plan §4).
 */
export function HealthCard({ model, daysLate, actions }: { model: HealthModel; daysLate: number | null; actions?: HealthActions }) {
  const t = useT('production')
  if (model.orders.length === 0) return null
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('health.title')}</h2>
      </div>
      {model.problem && !model.dialog && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
      <div className="fw-pr-stack">
        {model.orders.map((part) => (
          <OrderHealth key={part.orderId} part={part} many={model.orders.length > 1} model={model} daysLate={daysLate} actions={actions} />
        ))}
      </div>
      <p className="fw-pr-hint">{t('health.customerReads')}</p>
      {model.dialog && <RaiseDialog model={model} actions={actions} />}
    </Card>
  )
}

function OrderHealth({ part, many, model, daysLate, actions }: { part: HealthPart; many: boolean; model: HealthModel; daysLate: number | null; actions?: HealthActions }) {
  const t = useT('production')
  const locale = useLocale()
  const head = many ? <strong>{t('health.order', { number: part.number })}</strong> : null
  if (part.read.problem) {
    return (
      <EmptyState
        title={t('health.failed', { number: part.number })}
        description={t(part.read.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('common.retry')}
          </Button>
        }
      />
    )
  }
  const view = part.read.value
  if (!view) {
    return (
      <div role="status" aria-label={t('common.loading')}>
        {head}
        <Skeleton height={20} />
      </div>
    )
  }
  if (!view.kept) {
    return (
      <div>
        {head}
        <p className="fw-pr-hint">{t('health.notKept')}</p>
      </div>
    )
  }
  const raise = view.raise && view.raise.stands ? view.raise : null
  const openHeld = raiseOpenHeld(view, model.can)
  const clearWait = clearHeld(view, model.can, model.busy)
  const computed = healthStateOf(view.computed)
  return (
    <div className="fw-pr-stack">
      {head}
      <span className="fw-pr-inline">
        <HealthPill face="office" {...healthInputOf(view, daysLate)} explain={false} />
        {view.waitingOn && <WaitingOnPill face="office" who={view.waitingOn} since={view.waitingSince} />}
      </span>
      <p className="fw-pr-hint">{computed ? t('health.computed', { health: t(`parts.health.${computed}`) }) : t('parts.health.none')}</p>
      {raise && (
        <div className="fw-pr-stack">
          <p>
            <AlertTriangle size={13} aria-hidden /> {t('health.raised', { reason: PROMISE_REASON_WORDS[raise.reasonCode][locale] })}
          </p>
          {raise.note && (
            <div className="fw-prp-office-note">
              <span className="fw-prp-office-mark">
                <Lock size={12} aria-hidden /> {t('parts.health.officeOnly')}
              </span>
              <p className="fw-prp-pop-line">{raise.setBy ? t('parts.health.note', { by: raise.setBy.name, date: day(raise.setAt, locale), note: raise.note }) : raise.note}</p>
            </div>
          )}
          <p className="fw-pr-hint">{t('health.until', { date: day(raise.until, locale) })}</p>
        </div>
      )}
      <span className="fw-pr-actions">
        <Button size="sm" heldReason={openHeld ? t(openHeld.key, openHeld.params) : model.busy ? t('held.busy') : null} onClick={() => actions?.onDialog?.(part.orderId)}>
          <AlertTriangle size={13} aria-hidden /> {raise ? t('health.change') : t('health.raise')}
        </Button>
        {view.raise && (
          <Button size="sm" variant="quiet" heldReason={clearWait ? t(clearWait.key, clearWait.params) : null} onClick={() => actions?.onClear?.(part.orderId)}>
            {model.busy ? <Spinner size={12} /> : <X size={13} aria-hidden />} {t('health.clear')}
          </Button>
        )}
      </span>
    </div>
  )
}

/** Raise to At risk: the order (when the work order has several), a curated reason the customer reads, an office-only note of one line. */
export function RaiseDialog({ model, actions }: { model: HealthModel; actions?: HealthActions }) {
  const t = useT('production')
  const locale = useLocale()
  const part = model.orders.find((entry) => entry.orderId === model.dialog?.orderId) ?? null
  const view: BrandHealthView | null = part?.read.value ?? null
  const standing = view?.raise && view.raise.stands ? view.raise : null
  const [reasonCode, setReasonCode] = useState<string>(model.draft?.reasonCode ?? standing?.reasonCode ?? '')
  const [note, setNote] = useState(model.draft?.note ?? standing?.note ?? '')
  if (!part) return null
  const held = raiseHeld(view, model.can, reasonCode, note, model.busy)
  const go = held ? null : () => actions?.onRaise?.({ orderId: part.orderId, reasonCode: reasonCode as HealthReasonCode, note: note.trim() || null })
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('raise.title', { number: part.number })}
      size="md"
      footer={
        <span className="fw-pr-actions">
          <Button size="sm" variant="quiet" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : <AlertTriangle size={13} aria-hidden />} {t('raise.go')}
          </Button>
        </span>
      }
    >
      <form
        className="fw-pr-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          go?.()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go?.()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        <p>{t('raise.body')}</p>
        <Field label={t('raise.reason')}>
          <Select size="sm" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} aria-label={t('raise.reason')}>
            <option value="">{t('raise.reasonPick')}</option>
            {HEALTH_REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {PROMISE_REASON_WORDS[code][locale]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('raise.note')} hint={t('raise.noteHint', { max: HEALTH_NOTE_MAX })}>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={HEALTH_NOTE_MAX} />
        </Field>
        <p className="fw-pr-hint">{t('raise.days')}</p>
      </form>
    </Modal>
  )
}
