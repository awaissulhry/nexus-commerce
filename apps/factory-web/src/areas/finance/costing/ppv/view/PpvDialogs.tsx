'use client'

import { useEffect, useState } from 'react'
import { FilePlus2, Undo2 } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { CLOSE_NS } from '../../../../production/work-orders/close/model'
import { quantityText, signedMoney, unitCostText } from '../../model'
import { PPV_REASON_MAX, ppvPostHeld, ppvReasonHeld, type PpvDialog } from '../model'

/**
 * B-W2b-GB02 (G053; B-W2b-424's gap 1) — the Purchase price variance section's two writes (design finance.costing sec:ppv;
 * FIN-031; B-W2b-407's POST /costing/ppv/:id/reverse and POST /costing/ppv/post, costing.ledger.manage):
 *   Reverse…        what the variance is (material, supplier, document, paid against standard; its difference with the cost
 *                   grain and what the reversal books), the reason (3 to 1,000 characters), and that a reversal row dated
 *                   today takes it back — nothing is edited or deleted. Reverse is held until the reason is there.
 *   Post a document… a goods receipt or a supplier invoice by its number: its variances now (what the worker does after
 *                   the document's event, done by hand when it did not), then what was posted and the lines that took
 *                   none, each with why.
 * A refusal is said inside the dialog in words (never a code); what was typed stays. No person is named.
 */

export function PpvReverseDialog({ dialog, cost, draft, onSubmit, onClose }: { dialog: Extract<PpvDialog, { kind: 'reverse' }>; cost: boolean; draft?: string; onSubmit?: (reason: string) => void; onClose?: () => void }) {
  const t = useT(CLOSE_NS)
  const locale = useLocale()
  const [reason, setReason] = useState(draft ?? '')
  useEffect(() => setReason(draft ?? ''), [dialog.row.id, draft])
  const row = dialog.row
  const held = ppvReasonHeld(reason, dialog.busy)
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t('ppv.reverse.title', { material: row.item.code, document: row.source.number })}
      size="md"
      footer={
        <>
          <Button size="sm" onClick={() => onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held ? t(held.key, held.params) : null} onClick={() => onSubmit?.(reason.trim())}>
            {dialog.busy ? <Spinner size={12} /> : <Undo2 size={13} aria-hidden />} {t('ppv.reverse.go')}
          </Button>
        </>
      }
    >
      <div className="fw-fco-detail">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem.key, dialog.problem.params)} />}
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('ppv.col.material'), value: `${row.item.code} · ${row.item.name}`, hint: quantityText(row.quantity, row.item.baseUom, locale) },
            { label: t('ppv.col.supplier'), value: row.supplier.name },
            { label: t('ppv.col.document'), value: t('ppv.line', { number: row.source.number, seq: row.source.seq }), hint: `${t(`ppv.at.${row.source.at}`)} · ${formatDate(`${row.day}T12:00:00Z`, { locale })}` },
            ...(cost
              ? [
                  { label: t('ppv.reverse.paid'), value: t('ppv.reverse.against', { paid: unitCostText(row.paidUnitCost ?? null, row.currency, locale), standard: unitCostText(row.standardUnitCost ?? null, row.currency, locale) }) },
                  {
                    label: t('ppv.col.difference'),
                    value: signedMoney(row.differenceAmount ?? null, row.currency, locale),
                    hint: t('ppv.reverse.becomes', { amount: signedMoney(typeof row.differenceAmount === 'number' ? -row.differenceAmount : null, row.currency, locale) }),
                  },
                ]
              : []),
          ]}
        />
        <p className="fw-fco-muted">{t('ppv.reverse.what', { day: formatDate(new Date(), { locale }) })}</p>
        <Field label={t('ppv.reverse.reason')} hint={t('ppv.reverse.reasonHint', { max: PPV_REASON_MAX })}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={PPV_REASON_MAX} aria-label={t('ppv.reverse.reason')} />
        </Field>
      </div>
    </Modal>
  )
}

export function PpvPostDialog({
  dialog,
  can,
  draft,
  onSubmit,
  onClose,
}: {
  dialog: Extract<PpvDialog, { kind: 'post' }>
  can: { readonly manage: boolean } | undefined
  draft?: { readonly at?: 'RECEIPT' | 'INVOICE'; readonly number?: string }
  onSubmit?: (document: { at: 'RECEIPT' | 'INVOICE'; number: string }) => void
  onClose?: () => void
}) {
  const t = useT(CLOSE_NS)
  const [at, setAt] = useState<'RECEIPT' | 'INVOICE'>(draft?.at ?? 'INVOICE')
  const [number, setNumber] = useState(draft?.number ?? '')
  const held = ppvPostHeld(can, number, dialog.busy)
  const result = dialog.result
  return (
    <Modal
      open
      onClose={() => onClose?.()}
      title={t('ppv.post.title')}
      size="md"
      footer={
        result ? (
          <Button size="sm" variant="primary" onClick={() => onClose?.()}>
            {t('ppv.post.done')}
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={() => onClose?.()}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={() => onSubmit?.({ at, number: number.trim() })}>
              {dialog.busy ? <Spinner size={12} /> : <FilePlus2 size={13} aria-hidden />} {t('ppv.post.go')}
            </Button>
          </>
        )
      }
    >
      <div className="fw-fco-detail">
        {result ? (
          <>
            <Banner tone={result.posted > 0 ? 'success' : 'info'} title={t(result.posted > 0 ? 'ppv.post.posted' : 'ppv.post.nothing', { count: result.posted, number: result.number })} />
            {result.skipped.length > 0 && (
              <>
                <p className="fw-fco-muted">{t('ppv.post.skippedTitle', { count: result.skipped.length })}</p>
                <ul className="fw-fco-notes">
                  {result.skipped.map((line) => (
                    <li key={`${line.seq}-${line.code}`}>{t('ppv.post.skippedLine', { seq: line.seq, why: t(`ppv.skip.${line.code}`) })}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <>
            {dialog.problem && <Banner tone="danger" title={t(dialog.problem.key, dialog.problem.params)} />}
            <p className="fw-fco-muted">{t('ppv.post.what')}</p>
            <Field label={t('ppv.post.kind')}>
              <SegmentedControl
                ariaLabel={t('ppv.post.kind')}
                options={[
                  { value: 'INVOICE', label: t('ppv.post.INVOICE') },
                  { value: 'RECEIPT', label: t('ppv.post.RECEIPT') },
                ]}
                value={at}
                onChange={(value) => setAt(value === 'RECEIPT' ? 'RECEIPT' : 'INVOICE')}
                disabled={dialog.busy}
              />
            </Field>
            <Field label={t(at === 'RECEIPT' ? 'ppv.post.receiptNumber' : 'ppv.post.invoiceNumber')} hint={t('ppv.post.numberHint')}>
              <Input value={number} onChange={(event) => setNumber(event.target.value)} maxLength={60} disabled={dialog.busy} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
