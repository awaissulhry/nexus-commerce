'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Undo2 } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { DetailModal, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { LedgerEntry, WorkOrderCost } from '../api'
import { COSTING_NAMESPACE, costSheetHref, decimalText, labourHref, moneyText, quantityText, reasonHeld, signedMoney, type CostingCan, type Phrase } from '../model'
import { CostBridge, CostFacts, CostLabour, CostMaterials, CostScrapAndWaiting, CostSummary } from './CostParts'

export interface DetailState {
  /** The work order whose cost is open. */
  readonly id: string
  readonly value: WorkOrderCost | null
  readonly problem: string | null
}

export interface ReverseState {
  readonly entry: LedgerEntry
  readonly busy: boolean
  readonly problem: Phrase | null
}

/**
 * pop:wo-cost — one work order's cost (design "WO-0221 — cost", a DetailModal: centred, a full-screen sheet on a phone;
 * J / K the next or previous work order of the list): the facts, the bridge from the basis to the actual, planned ·
 * actual · variance · per garment, the materials issued per lot and hide, labour per operation (minutes earned × cost per
 * minute; never per person) and what waits; "Open work order" (its Labour & cost tab) and "Open the cost sheet".
 */
export function WorkOrderCostDialog({ state, ids, can, prefix, onGo, onClose, onRetry }: { state: DetailState; ids: readonly string[]; can: CostingCan; prefix: string; onGo?: (id: string) => void; onClose?: () => void; onRetry?: () => void }) {
  const t = useT(COSTING_NAMESPACE)
  const detail = state.value
  const number = detail?.workOrder.number ?? t('detail.thisWorkOrder')
  return (
    <DetailModal
      open
      onClose={() => onClose?.()}
      title={t('detail.title', { number })}
      subtitle={detail ? `${detail.workOrder.style.code} · ${detail.workOrder.style.name}` : undefined}
      meta={detail ? <Pill tone={detail.final ? 'success' : 'info'}>{t(detail.final ? 'state.final' : 'state.open')}</Pill> : undefined}
      nav={ids.length > 1 && ids.includes(state.id) ? { ids, current: state.id, onGo: (id) => onGo?.(id), noun: t('detail.noun') } : undefined}
      loading={!detail && !state.problem}
      error={state.problem ? t(state.problem) : undefined}
      onRetry={state.problem ? onRetry : undefined}
      footer={
        detail ? (
          <>
            {can.styles && (
              <Button size="sm" asChild>
                <Link href={costSheetHref(prefix, detail.workOrder.style.id)}>{t('detail.costSheet')}</Link>
              </Button>
            )}
            <span className="grow" />
            {can.workOrders ? (
              <Button size="sm" variant="primary" asChild>
                <Link href={labourHref(prefix, detail.workOrder.id)}>
                  <ExternalLink size={13} aria-hidden /> {t('detail.open')}
                </Link>
              </Button>
            ) : (
              <Button size="sm" variant="primary" heldReason={t('held.noWorkOrders', { permission: 'workorders.view' })}>
                {t('detail.open')}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {detail && (
        <div className="fw-fco-detail">
          <CostFacts detail={detail} can={can} />
          <div className="fw-fco-pair">
            <CostBridge detail={detail} can={can} />
            <CostSummary detail={detail} can={can} />
          </div>
          <CostMaterials detail={detail} can={can} prefix={prefix} />
          <CostLabour detail={detail} can={can} />
          <CostScrapAndWaiting detail={detail} can={can} />
          {detail.actual.subcontract === 0 && can.cost && <p className="fw-fco-muted">{t('detail.noSubcontract')}</p>}
        </div>
      )}
    </DetailModal>
  )
}

/**
 * Reverse entry (design ledger "Reverse entry (reason, ActionConfirm)"; composed: the DS ActionConfirm speaks English
 * only): what the entry is, the reason (3 to 500 characters), what the reversal does — a new entry dated today with the
 * opposite amount, its overhead reversed with it; nothing is edited or deleted — and Reverse, held until the reason is
 * there. A refusal is said inside the dialog; the typed reason stays.
 */
export function ReverseDialog({ state, can, onSubmit, onClose, draft }: { state: ReverseState; can: Pick<CostingCan, 'cost'>; onSubmit?: (reason: string) => void; onClose?: () => void; draft?: string }) {
  const t = useT(COSTING_NAMESPACE)
  const locale = useLocale()
  const [reason, setReason] = useState(draft ?? '')
  useEffect(() => setReason(draft ?? ''), [state.entry.id, draft])
  const held = reasonHeld(reason)
  const entry = state.entry
  const heldText = state.busy ? t('held.busy') : held ? t(held.key) : null
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t('reverse.title', { number: entry.workOrder.number })}
      size="md"
      footer={
        <>
          <Button size="sm" onClick={() => onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={heldText} onClick={() => onSubmit?.(reason.trim())}>
            {state.busy ? <Spinner size={12} /> : <Undo2 size={13} aria-hidden />} {t('reverse.go')}
          </Button>
        </>
      }
    >
      <div className="fw-fco-detail">
        {state.problem && <Banner tone="danger" title={t(state.problem.key, state.problem.params)} />}
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('ledger.col.date'), value: formatDateTime(entry.occurredAt, { locale }) },
            { label: t('ledger.col.event'), value: t(`event.${entry.event}`), hint: t(`kind.${entry.kind}`) },
            { label: t('ledger.col.item'), value: entry.item ? `${entry.item.code} · ${entry.item.name}` : '—', hint: entry.item ? quantityText(entry.quantity, entry.item.baseUom, locale) : entry.minutes ? t('labour.minutes', { minutes: decimalText(entry.minutes, locale, 1) }) : undefined },
            { label: t('ledger.col.document'), value: entry.document?.label ?? '—' },
            ...(can.cost ? [{ label: t('ledger.col.value'), value: moneyText(entry.amount ?? null, entry.currency, locale), hint: t('reverse.becomes', { amount: signedMoney(typeof entry.amount === 'number' ? -entry.amount : null, entry.currency, locale) }) }] : []),
          ]}
        />
        <p className="fw-fco-muted">{t('reverse.what', { day: formatDate(new Date(), { locale }) })}</p>
        <Field label={t('reverse.reason')} hint={t('reverse.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} aria-label={t('reverse.reason')} />
        </Field>
      </div>
    </Modal>
  )
}
