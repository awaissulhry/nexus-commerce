'use client'

import { Plus } from 'lucide-react'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { WorkOrder } from '../../../_shared/api'
import { EXTRA_NOTE, extraHeld, type ExtraActions, type ExtraDialogModel, type ExtraModel } from '../use-extra'
import type { ExtraReasonCode, ExtraRecord } from '../api'

/** The tile in the reader's language, then the person's own words (the record keeps the tile's English words before them). */
function reasonWords(row: ExtraRecord, tile: string): string {
  const at = row.reason?.indexOf(': ') ?? -1
  return at < 0 ? tile : `${tile}: ${row.reason!.slice(at + 2)}`
}

/**
 * Unplanned operations of a work order (B-W2b-82; MES-086), on SCR-072's Operations tab: what was added, why and where, and "Add
 * an unplanned operation" on a RELEASED or IN_PROGRESS work order. One record: no person, no money. An added operation is frozen
 * like the routing's: it stays unused when nobody scans it, and it changes no figure then.
 */
export function ExtraPanel({ workOrder, model, actions }: { workOrder: WorkOrder; model: ExtraModel; actions?: ExtraActions }) {
  const t = useT('production')
  const locale = useLocale()
  const rows = model.added.value
  const held = workOrder.status === 'RELEASED' || workOrder.status === 'IN_PROGRESS' ? null : t('extra.held.status')
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('extra.title')}</h2>
        {model.canAdd ? (
          <Button size="sm" onClick={() => actions?.onOpen?.()} heldReason={held}>
            <Plus size={13} aria-hidden /> {t('extra.add')}
          </Button>
        ) : null}
      </div>
      {model.added.problem ? (
        <Banner tone="danger" title={t('extra.listFailed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
      ) : rows === null ? (
        <p className="fw-pr-hint" aria-busy="true">
          {t('extra.loading')}
        </p>
      ) : rows.length === 0 ? (
        <p className="fw-pr-hint">{t('extra.none')}</p>
      ) : (
        <SummaryTable
          label={t('extra.title')}
          stackOnPhone
          columns={[t('extra.col.operation'), t('extra.col.reason'), t('extra.col.addedOn'), t('extra.col.at')]}
          rows={rows.map((row) => ({
            id: row.id,
            cells: [`${row.seq ?? '—'} ${row.operation.code} · ${row.operation.name}`, reasonWords(row, t(`extra.reason.${row.reasonCode}`)), t(`extra.on.${row.addedOn}`), formatDateTime(row.at, { locale })],
          }))}
        />
      )}
      <p className="fw-pr-hint">{t('extra.hint')}</p>
      {model.dialog ? <ExtraDialog workOrder={workOrder} dialog={model.dialog} actions={actions} /> : null}
    </Card>
  )
}

function ExtraDialog({ workOrder, dialog, actions }: { workOrder: WorkOrder; dialog: ExtraDialogModel; actions?: ExtraActions }) {
  const t = useT('production')
  const locale = useLocale()
  const { choices, draft } = dialog
  const heldKey = extraHeld(dialog)
  const held = heldKey ? t(heldKey) : null
  const picked = choices?.operations.find((operation) => operation.id === draft.operationId) ?? null
  const tile = choices?.reasons.find((reason) => reason.code === draft.reasonCode) ?? null
  return (
    <Modal
      open
      onClose={() => (dialog.busy ? undefined : actions?.onClose?.())}
      title={t('extra.dialog.title', { number: workOrder.number })}
      subtitle={t('extra.dialog.subtitle')}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()} heldReason={dialog.busy ? t('held.busy') : null}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onAdd?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {dialog.busy ? <Spinner size={12} /> : <Plus size={13} aria-hidden />} {t('extra.add')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pr-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) actions?.onAdd?.()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
            event.preventDefault()
            actions?.onAdd?.()
          }
        }}
      >
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem.key, dialog.problem.params)} />}
        {!choices && !dialog.problem ? (
          <p className="fw-pr-hint" aria-busy="true">
            {t('extra.loading')}
          </p>
        ) : null}
        {choices && choices.operations.length === 0 ? <p className="fw-pr-hint">{t('extra.empty')}</p> : null}
        {choices && choices.operations.length > 0 ? (
          <>
            <Field label={t('extra.operation')} htmlFor="fw-pr-extra-operation" required>
              <Select id="fw-pr-extra-operation" value={draft.operationId ?? ''} onChange={(event) => actions?.onDraft?.({ operationId: event.target.value || null })}>
                <option value="">{t('extra.pick')}</option>
                {choices.operations.map((operation) => (
                  <option key={operation.id} value={operation.id}>
                    {`${operation.code} · ${operation.name} · ${t('extra.minutes', { minutes: operation.standardMinutes })}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('extra.why')} htmlFor="fw-pr-extra-reason" required>
              <Select id="fw-pr-extra-reason" value={draft.reasonCode ?? ''} onChange={(event) => actions?.onDraft?.({ reasonCode: (event.target.value || null) as ExtraReasonCode | null })}>
                <option value="">{t('extra.pick')}</option>
                {choices.reasons.map((reason) => (
                  <option key={reason.code} value={reason.code}>
                    {locale === 'it' ? reason.label.it : reason.label.en}
                  </option>
                ))}
              </Select>
            </Field>
            {tile?.needsNote ? (
              <Field label={t('extra.note')} htmlFor="fw-pr-extra-note" required>
                <Textarea id="fw-pr-extra-note" value={draft.note} limit={EXTRA_NOTE.max} maxLength={EXTRA_NOTE.max} rows={2} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
              </Field>
            ) : null}
            {picked?.pays === 'OFF_STANDARD' ? <Banner tone="warning" title={t('extra.noRate')} /> : null}
            <ul className="fw-pr-list">
              <li>{t('extra.dialog.scans')}</li>
              <li>{t('extra.dialog.pay')}</li>
              <li>{t('extra.dialog.frozen')}</li>
            </ul>
          </>
        ) : null}
      </form>
    </Modal>
  )
}
