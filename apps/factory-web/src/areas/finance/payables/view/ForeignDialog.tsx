'use client'

import { useRef } from 'react'
import { FileUp } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { foreignProblems, PAYABLES_NAMESPACE, type ForeignDraft } from '../model'
import type { ForeignModel } from './PayablesListView'

/**
 * "Add foreign invoice" (design finance.payables band, W2a: a foreign supplier's invoice typed from its PDF; an Italian
 * supplier's comes through SDI and is never typed): the supplier (searched among suppliers and workshops), invoice or
 * credit note, number, date, currency, due date, one line (what it bills, net, VAT rate — 0 with its Natura, e.g. N2.1 —,
 * VAT), the PDF (put on the supplier first, then copied onto the invoice) and a note. The container sends it as ONE
 * registration; a service without PO, matched as NO_PO (map it to an order on the record's Lines tab). Composed here:
 * the PDF picker is a DS Button over a hidden file input (FileDropzone's words are English only).
 */
export function ForeignDialog({
  model,
  today,
  actions,
}: {
  model: ForeignModel
  today: string
  actions?: { onChange: (draft: ForeignDraft) => void; onSupplierQuery: (text: string) => void; onFile: (file: File | null) => void; onSubmit: () => void; onClose: () => void }
}) {
  const t = useT(PAYABLES_NAMESPACE)
  const locale = useLocale()
  const file = useRef<HTMLInputElement>(null)
  const draft = model.draft
  const set = (patch: Partial<ForeignDraft>) => actions?.onChange({ ...draft, ...patch })
  const problems = foreignProblems(draft, today)
  const held = model.busy ? t('held.busy') : problems.length > 0 ? t(problems[0]!) : null
  const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  const zeroVat = Number(draft.vatRate.replace(',', '.')) === 0

  return (
    <Modal
      open
      onClose={() => actions?.onClose()}
      title={t('foreign.title')}
      subtitle={t('foreign.subtitle')}
      size="lg"
      footer={
        <>
          <Button size="sm" onClick={() => actions?.onClose()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSubmit()}>
            {t('foreign.submit')}
          </Button>
        </>
      }
    >
      <div className="fw-fpy-stack">
        {model.problems && model.problems.length > 0 && <Banner tone="danger" title={model.problems.map((phrase) => t(phrase.key, phrase.params)).join(' ')} />}
        <div className="fw-fpy-form">
          <Field label={t('foreign.supplierSearch')} hint={t('foreign.supplierHint')}>
            <Input size="sm" type="search" placeholder={t('foreign.supplierPlaceholder')} onChange={(event) => actions?.onSupplierQuery(event.target.value)} />
          </Field>
          <Field label={t('foreign.supplier')} error={draft.country === 'IT' ? t('refusal.COMES_THROUGH_SDI') : undefined}>
            <Select
              size="sm"
              value={draft.partyId ?? ''}
              onChange={(event) => {
                const picked = model.suppliers?.find((entry) => entry.id === event.target.value) ?? null
                set({ partyId: picked?.id ?? null, country: picked?.country ?? null, currency: picked?.currency ?? draft.currency })
              }}
            >
              <option value="">{model.suppliers === null ? t('foreign.supplierFirst') : model.suppliers.length === 0 ? t('foreign.supplierNone') : t('foreign.supplierPick')}</option>
              {(model.suppliers ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${entry.code} · ${entry.legalName} (${entry.country})`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('foreign.kind')}>
            <Select size="sm" value={draft.kind} onChange={(event) => set({ kind: event.target.value === 'CREDIT_NOTE' ? 'CREDIT_NOTE' : 'INVOICE' })}>
              <option value="INVOICE">{t('kind.INVOICE')}</option>
              <option value="CREDIT_NOTE">{t('kind.CREDIT_NOTE')}</option>
            </Select>
          </Field>
          <Field label={t('foreign.number')} required>
            <Input size="sm" value={draft.number} maxLength={20} onChange={(event) => set({ number: event.target.value })} />
          </Field>
          <Field label={t('foreign.issueDate')} required>
            <DateField
              value={draft.issueDate}
              max={today}
              locale={dateLocale}
              ariaLabel={t('foreign.issueDate')}
              placeholder={t('foreign.datePlaceholder')}
              clearLabel={t('foreign.dateClear')}
              onChange={(value) => set({ issueDate: value })}
            />
          </Field>
          <Field label={t('foreign.dueDate')}>
            <DateField
              value={draft.dueDate}
              locale={dateLocale}
              ariaLabel={t('foreign.dueDate')}
              placeholder={t('foreign.datePlaceholder')}
              clearLabel={t('foreign.dateClear')}
              onChange={(value) => set({ dueDate: value })}
            />
          </Field>
          <Field label={t('foreign.currency')} required>
            <Input size="sm" value={draft.currency} maxLength={3} onChange={(event) => set({ currency: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('foreign.description')} required className="fw-fpy-form-wide">
            <Input size="sm" value={draft.description} maxLength={1000} onChange={(event) => set({ description: event.target.value })} />
          </Field>
          <Field label={t('foreign.net')} required hint={t('foreign.amountHint')}>
            <Input size="sm" inputMode="decimal" value={draft.net} onChange={(event) => set({ net: event.target.value })} />
          </Field>
          <Field label={t('foreign.vatRate')} required>
            <Input size="sm" inputMode="decimal" value={draft.vatRate} onChange={(event) => set({ vatRate: event.target.value })} />
          </Field>
          {zeroVat && (
            <Field label={t('foreign.vatNature')} hint={t('foreign.vatNatureHint')}>
              <Input size="sm" value={draft.vatNature} maxLength={4} onChange={(event) => set({ vatNature: event.target.value.toUpperCase() })} />
            </Field>
          )}
          <Field label={t('foreign.vat')} required>
            <Input size="sm" inputMode="decimal" value={draft.vat} onChange={(event) => set({ vat: event.target.value })} />
          </Field>
          <Field label={t('foreign.file')} required hint={draft.fileName ?? t('foreign.fileHint')} className="fw-fpy-form-wide">
            <span className="fw-fpy-inline">
              <Button size="sm" onClick={() => file.current?.click()}>
                <FileUp size={14} aria-hidden /> {draft.fileName ? t('foreign.fileChange') : t('foreign.filePick')}
              </Button>
              <input
                ref={file}
                className="fw-fpy-file"
                type="file"
                accept="application/pdf,.pdf"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                  actions?.onFile(event.target.files?.[0] ?? null)
                  event.target.value = ''
                }}
              />
            </span>
          </Field>
          <Field label={t('foreign.note')} className="fw-fpy-form-wide">
            <Textarea value={draft.note} maxLength={1000} rows={2} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        </div>
        <p className="fw-fpy-muted">{t('foreign.after')}</p>
      </div>
    </Modal>
  )
}
