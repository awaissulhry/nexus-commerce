'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Circle, XCircle } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, Checkbox, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../i18n/ds-parts'
import { useScopedT } from '../../../i18n/provider'
import type { ReleaseCheck, WorkOrder } from '../../../../areas/production/_shared/api'
import { checkItems, onlyMaterialShort, type CheckItem } from '../../../../areas/production/_shared/model'
import type { Part, Phrase } from '../model'
import './work-order-acts.css'

/** Words: the production catalogue (`release.*`, `check.*`, `overview.*`); a refusal may name another (`orders:wo.…`). */
const NS = 'production'

const reasonLength = (text: string, min: number, max: number) => {
  const length = text.trim().length
  return length >= min && length <= max
}

/** Params whose value is itself a message key (`reason.CR_VI_PENDING`, `kind.SEWING`) are drawn in words. */
export function translateParams(t: (key: string, params?: Record<string, string | number>) => string, params?: Readonly<Record<string, string | number>>): Record<string, string | number> | undefined {
  if (!params) return undefined
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === 'string' && /^(reason|kind)\.[A-Z_]+$/.test(value) ? t(value) : value]))
}

const STATE_ICON = {
  OK: <CheckCircle2 size={16} className="fw-woa-ico is-ok" aria-hidden />,
  NOT_REQUIRED: <Circle size={16} className="fw-woa-ico" aria-hidden />,
  OVERRIDDEN: <AlertTriangle size={16} className="fw-woa-ico is-overridden" aria-hidden />,
  BLOCKED: <XCircle size={16} className="fw-woa-ico is-blocked" aria-hidden />,
} as const

/**
 * F-OP-114 — the release check, each condition passed or held in words with what holds it (moved from the work order record's
 * Overview: ONE list, drawn there and in Release… on the order page). The deposit is one of its checks; the customer's credit and
 * the compliance gate are checked again by the release itself and said in its refusal.
 */
export function ReleaseCheckList({ items, label }: { items: readonly CheckItem[]; label: string }) {
  const t = useScopedT(NS)
  return (
    <ul className="fw-woa-checks" aria-label={label}>
      {items.map((item) => (
        <li key={item.code} className="fw-woa-check">
          {STATE_ICON[item.state]}
          <span className="fw-woa-check-body">
            <span>
              <b>{t(`check.name.${item.code}`)}</b> — {t(item.words.key, translateParams(t, item.words.params))}
            </span>
            {item.problems.length > 0 && (
              <ul className="fw-woa-check-problems">
                {item.problems.map((problem, index) => (
                  <li key={index}>{t(problem.key, translateParams(t, problem.params))}</li>
                ))}
              </ul>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * F-OP-114 — Release (design wo-release-confirm), ONE copy for the work order's record and the order page's row ⋯ (moved here from
 * the record's dialogs): what the release freezes and reaches, a short material only with the planner's override and a reason.
 * `listChecks`: the release check drawn in the dialog (the order page; the record draws it on its Overview).
 */
export function ReleaseDialog({
  workOrder,
  check,
  busy,
  problem,
  draft,
  listChecks = false,
  onCancel,
  onRelease,
  onRetry,
}: {
  workOrder: WorkOrder
  check: Part<ReleaseCheck>
  busy: boolean
  problem: Phrase | null
  draft?: { readonly override?: boolean; readonly reason?: string } | null
  listChecks?: boolean
  onCancel: () => void
  onRelease?: (overrideReason: string | null) => void
  onRetry?: () => void
}) {
  const t = useScopedT(NS)
  const value = check.value
  const material = onlyMaterialShort(value)
  const [override, setOverride] = useState(draft?.override ?? false)
  const [reason, setReason] = useState(draft?.reason ?? '')
  const needsReason = material
  const reasonOk = reasonLength(reason, 3, 500)
  const items = listChecks && value ? checkItems(value, workOrder) : []
  const open = items.filter((item) => item.state === 'BLOCKED').length
  const held = busy
    ? t('held.busy')
    : listChecks && !value
      ? t('held.checking')
      : listChecks && open > 0 && !material
        ? t('orders:wo.checksOpen', { count: open }) // listChecks: the order page (its catalogue is loaded there)
        : needsReason && !override
          ? t('release.overrideNeeded')
          : needsReason && !reasonOk
            ? t('release.reasonShort')
            : null
  const go = held ? null : () => onRelease?.(needsReason ? reason.trim() : null)
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('release.title', { number: workOrder.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {busy ? <Spinner size={12} /> : null} {t('release.go')}
          </Button>
        </>
      }
    >
      <form
        className="fw-woa-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          go?.()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && go) {
            event.preventDefault()
            go()
          }
        }}
      >
        {problem && <Banner tone="danger" title={t(problem.key, problem.params)} />}
        <p>{t('release.body', { revision: workOrder.revision?.revision ?? '—' })}</p>
        <ul className="fw-woa-list">
          <li>{t('release.reachCells', { count: workOrder.cells.length, pieces: workOrder.pieces })}</li>
          <li>{t('release.reachOps', { count: workOrder.spec.operations.length })}</li>
          <li>{t('release.reachMaterials', { count: workOrder.spec.materials.length })}</li>
        </ul>
        {/* F-OP-114: the release check in the dialog (each condition passed or held in words); reading, or Try again. */}
        {listChecks &&
          (value ? (
            <>
              <h3 className="fw-woa-h3">{t('overview.check')}</h3>
              <ReleaseCheckList items={items} label={t('overview.check')} />
            </>
          ) : check.problem ? (
            <EmptyState
              title={t('overview.check')}
              description={t(check.problem)}
              action={
                <Button size="sm" onClick={() => onRetry?.()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : (
            <p className="fw-woa-hint" role="status">
              <Spinner size={12} /> {t('held.checking')}
            </p>
          ))}
        <p className="fw-woa-hint">{t('release.reversal')}</p>
        {material && (
          <>
            <Banner tone="warning" title={t('release.short')} />
            <Checkbox checked={override} onChange={(event) => setOverride(event.target.checked)} label={t('release.override')} />
            {override && (
              <Field label={t('release.reason')} hint={t('release.reasonHint')} error={reason.length > 0 && !reasonOk ? t('release.reasonShort') : undefined}>
                <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
              </Field>
            )}
          </>
        )}
      </form>
    </Modal>
  )
}
