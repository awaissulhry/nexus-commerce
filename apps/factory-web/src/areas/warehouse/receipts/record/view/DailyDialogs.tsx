'use client'

import type { ReactNode } from 'react'
import { Camera, CheckCircle2, ExternalLink, Trash2 } from 'lucide-react'
import { DISCREPANCY_KINDS, DISCREPANCY_LIMITS, type DiscrepancyKind } from '@nexus/factory-domain/inventory/receipts/discrepancies'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { Button, Checkbox, Input, Radio, Select, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { usePhotoWords } from '../../../../../lib/ds-words/photo-capture'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { quantity } from '../../../../_shared/buying/model'
import type { Receipt } from '../../api'
import { reportHref } from '../../daily-api'
import {
  checkProblemKeys,
  claimDraftHeld,
  deliveryOf,
  discrepancyHeld,
  draftKind,
  kindAsked,
  lineUnit,
  NAMESPACE,
  recipientsOf,
  reportSendHeld,
  requestHeld,
  settleHeld,
  type DiscrepancyDraft,
  type Say,
} from '../../daily-model'
import type { DailyDialog, ReceiptDailyActions, ReceiptDailyModel } from '../../daily-state'
import { lineWords, reasonWords } from './DailyTabs'

/**
 * The receipt's W2a dialogs (B-W2a-63; design warehouse.receipts pop rc-disc-new "New discrepancy" and rc-disc-send
 * "Send discrepancy report"; documents "Request from supplier"): each held with its first reason in words, one
 * Idempotency-Key per dialog (the container's), Esc closes and the focus returns to the opener (DS Modal). They fetch
 * nothing.
 */

type T = (key: string, params?: Record<string, string | number>) => string
const words = (t: T, said: Say | null | undefined): string | null => (said ? t(said.key, said.params as Record<string, string | number> | undefined) : null)

interface Props {
  receipt: Receipt
  daily: ReceiptDailyModel
  actions?: ReceiptDailyActions
  timeZone?: string
}

function Frame({ title, subtitle, held, label, onConfirm, daily, actions, children, size = 'md', tone, closeLabel }: { title: string; subtitle?: string; held: string | null; label: string; onConfirm: () => void; daily: ReceiptDailyModel; actions?: ReceiptDailyActions; children: ReactNode; size?: 'md' | 'lg' | 'xl' | 'xxl'; tone?: 'danger'; closeLabel?: string }) {
  const t = useT(NAMESPACE)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={title}
      subtitle={subtitle}
      size={size}
      busy={daily.busy}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {closeLabel ?? t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" tone={tone} heldReason={held} onClick={onConfirm}>
            {daily.busy && <Spinner size={12} />} {label}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        {children}
        {daily.problem && <Banner tone="danger" title={words(t, daily.problem)!} />}
      </div>
    </Modal>
  )
}

export function DailyDialogs(props: Props) {
  const dialog = props.daily.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'discrepancy':
      return <DiscrepancyDialog {...props} draft={dialog.draft} />
    case 'settle':
      return <SettleDialog {...props} dialog={dialog} />
    case 'remove':
      return <RemoveDialog {...props} id={dialog.id} />
    case 'report':
      return <ReportDialog {...props} dialog={dialog} />
    case 'claim':
      return <ClaimDialog {...props} dialog={dialog} />
    case 'request':
      return <RequestDialog {...props} dialog={dialog} />
  }
}

// ---- New discrepancy (pop rc-disc-new: kind · line · quantity · photos · note) -------------------------------------------------

function DiscrepancyDialog({ receipt, daily, actions, draft }: Props & { draft: DiscrepancyDraft }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const photoWords = usePhotoWords()
  const reasons = (daily.reasons.value ?? []).filter((reason) => reason.list === 'DISCREPANCY')
  const held = words(t, discrepancyHeld(draft, receipt, daily.can, daily.reasons.value ?? [], daily.busy))
  const set = (next: Partial<DiscrepancyDraft>) => actions?.onDialog?.({ kind: 'discrepancy', draft: { ...draft, ...next } })
  const editing = draft.id !== null
  const kind = draftKind(draft)
  const reasonLabel = (code: string) => {
    const reason = reasons.find((entry) => entry.code === code)
    return reason ? (locale === 'en' ? reason.labelEn : reason.labelIt) : code
  }
  return (
    <Frame
      title={editing ? t('new.titleChange') : t('new.title')}
      subtitle={t('new.subtitle', { number: receipt.number, supplier: receipt.supplier.name })}
      held={held}
      label={editing ? t('new.saveChange') : t('new.save')}
      onConfirm={() => actions?.onSaveDiscrepancy?.()}
      daily={daily}
      actions={actions}
      size="lg"
    >
      <div className="fw-by-fields">
        <Field label={t('new.reason')} hint={daily.reasons.problem ? t('new.reasonsFailed') : t('new.reasonHint')}>
          <Select size="sm" value={draft.reasonCode} onChange={(event) => set({ reasonCode: event.target.value })} autoFocus>
            <option value="">{t('new.reasonNone')}</option>
            {reasons.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {reasonLabel(reason.code)}
              </option>
            ))}
          </Select>
        </Field>
        {kindAsked(draft) ? (
          <Field label={t('new.kind')} required hint={draft.reasonCode ? t('new.kindOwnHint') : undefined}>
            <Select size="sm" value={draft.kind} onChange={(event) => set({ kind: event.target.value as DiscrepancyKind | '' })}>
              <option value="">{t('new.kindPick')}</option>
              {DISCREPANCY_KINDS.map((value) => (
                <option key={value} value={value}>
                  {t(`kind.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={t('new.kind')}>
            <p className="fw-by-text">{kind ? t(`kind.${kind}`) : '—'}</p>
          </Field>
        )}
        <Field label={t('new.line')}>
          <Select size="sm" value={draft.lineId} onChange={(event) => set({ lineId: event.target.value, uom: draft.uom || lineUnit(receipt, event.target.value) })}>
            <option value="">{t('disc.wholeDelivery')}</option>
            {receipt.lines.map((line) => (
              <option key={line.id} value={line.id}>
                {t('disc.line', { seq: line.seq, code: line.item.code, name: line.item.name, colour: line.colour ? ` · ${line.colour.name}` : '' })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('new.quantity')} hint={t('new.quantityHint')}>
          <span className="fw-rcd-qty">
            <Input size="sm" inputMode="decimal" value={draft.quantity} onChange={(event) => set({ quantity: event.target.value, uom: draft.uom || lineUnit(receipt, draft.lineId) })} aria-label={t('new.quantity')} />
            <Select size="sm" value={draft.uom} onChange={(event) => set({ uom: event.target.value as DiscrepancyDraft['uom'] })} aria-label={t('new.unit')}>
              <option value="">{t('new.noUnit')}</option>
              {UOMS.map((unit) => (
                <option key={unit} value={unit}>
                  {t(`uom.${unit}`)}
                </option>
              ))}
            </Select>
          </span>
        </Field>
      </div>
      <Field label={t('new.note')} hint={t('new.noteHint', { max: DISCREPANCY_LIMITS.note })}>
        <Textarea rows={3} maxLength={DISCREPANCY_LIMITS.note} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      <section aria-label={t('new.photos')}>
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">{t('new.photos')}</h3>
          {!draft.photoStep && (
            <Button size="sm" heldReason={daily.can.upload ? (draft.photos.length >= DISCREPANCY_LIMITS.photos ? t('held.photosFull', { max: DISCREPANCY_LIMITS.photos }) : null) : t('held.noUpload')} onClick={() => set({ photoStep: true })}>
              <Camera size={13} aria-hidden /> {t('photo.add')}
            </Button>
          )}
        </div>
        {draft.photoStep ? (
          <PhotoCapture
            label={t('new.photoLabel')}
            words={photoWords}
            onCapture={(photo) => set({ photoStep: false, photos: [...draft.photos, { key: `p-${draft.photos.length + 1}-${photo.width}x${photo.height}`, blob: photo.marked ?? photo.photo, name: `${receipt.number}-${draft.photos.length + 1}.jpg` }] })}
            onCancel={() => set({ photoStep: false })}
          />
        ) : draft.photos.length === 0 ? (
          <p className="fw-by-hint">{editing ? t('new.photosLater') : t('new.photosNone')}</p>
        ) : (
          <ul className="fw-by-chips" aria-label={t('new.photosReady')}>
            {draft.photos.map((photo, index) => (
              <li key={photo.key}>
                <Tag tone="info">
                  {t('new.photoReady', { n: index + 1 })}{' '}
                  <button type="button" className="fw-rcd-chip-x" aria-label={t('new.photoRemove', { n: index + 1 })} onClick={() => set({ photos: draft.photos.filter((entry) => entry.key !== photo.key) })}>
                    <Trash2 size={11} aria-hidden />
                  </button>
                </Tag>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="fw-by-hint">{receipt.status === 'POSTED' ? t('new.postedHint') : t('new.openHint')}</p>
      {draft.quantity && draft.uom && <p className="fw-by-hint">{t('new.quantityWords', { quantity: quantity(draft.quantity.replace(',', '.'), locale, 4), unit: t(`uom.${draft.uom}`) })}</p>}
    </Frame>
  )
}

// ---- the moves by hand: agreed, credited, closed --------------------------------------------------------------------------------

function SettleDialog({ receipt, daily, actions, dialog }: Props & { dialog: Extract<DailyDialog, { kind: 'settle' }> }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const row = daily.discrepancies.value?.find((entry) => entry.id === dialog.id)
  if (!row) return null
  const held = words(t, settleHeld(dialog.to, dialog.note, daily.can, daily.busy))
  return (
    <Frame title={t(`settle.title.${dialog.to}`, { seq: row.seq })} subtitle={`${receipt.number} · ${reasonWords(row, t, locale)} · ${lineWords(row, t)}`} held={held} label={t(`settle.confirm.${dialog.to}`)} onConfirm={() => actions?.onSettle?.()} daily={daily} actions={actions}>
      <p className="fw-by-text">{t(`settle.body.${dialog.to}`)}</p>
      <Field label={t(dialog.to === 'CLOSED' ? 'settle.noteClose' : 'settle.note')} required={dialog.to === 'CLOSED'} hint={t('settle.noteHint')}>
        <Textarea rows={3} maxLength={DISCREPANCY_LIMITS.resolution} value={dialog.note} onChange={(event) => actions?.onDialog?.({ ...dialog, note: event.target.value })} autoFocus />
      </Field>
      {row.claims.length > 0 && dialog.to === 'CLOSED' && <Banner tone="info" title={t('settle.claimNote', { numbers: row.claims.map((claim) => claim.number).join(', ') })} />}
    </Frame>
  )
}

function RemoveDialog({ receipt, daily, actions, id }: Props & { id: string }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const row = daily.discrepancies.value?.find((entry) => entry.id === id)
  if (!row) return null
  return (
    <Frame title={t('remove.title', { seq: row.seq })} subtitle={`${receipt.number} · ${reasonWords(row, t, locale)}`} held={daily.busy ? t('held.busy') : null} label={t('remove.confirm')} onConfirm={() => actions?.onRemove?.()} daily={daily} actions={actions} tone="danger">
      <ul className="fw-by-list">
        <li>{t('remove.what')}</li>
        <li>{t('remove.kept')}</li>
      </ul>
    </Frame>
  )
}

// ---- Send discrepancy report (pop rc-disc-send: the PDF, recipients from the supplier's contacts, message; result) -------------

function ReportDialog({ receipt, daily, actions, dialog, timeZone }: Props & { dialog: Extract<DailyDialog, { kind: 'report' }> }) {
  const t = useT(NAMESPACE)
  const shell = useT('shell')
  const locale = useLocale()
  const draft = dialog.draft
  const check = draft.check.value
  const set = (next: Partial<typeof draft>) => actions?.onDialog?.({ kind: 'report', draft: { ...draft, ...next } })
  const held = words(t, reportSendHeld(draft, daily.can, daily.busy))
  const rows = (daily.discrepancies.value ?? []).filter((row) => draft.ids.includes(row.id))
  const problems = check ? checkProblemKeys(check) : []
  const fileName = `${receipt.number}-discrepancies.pdf`

  if (draft.sent) {
    const sent = draft.sent
    const recipients = recipientsOf(check, draft.contactIds)
    const delivery = deliveryOf({ status: draft.delivery ?? 'QUEUED' })
    return (
      <Modal
        open
        onClose={() => actions?.onDialog?.(null)}
        title={t('report.sentTitle', { number: receipt.number })}
        size="md"
        footer={
          <>
            <Button size="sm" asChild>
              <a href={reportHref(receipt.id, sent.report.discrepancyIds, sent.report.language)} target="_blank" rel="noopener">
                <ExternalLink size={13} aria-hidden /> {t('report.openPdf')}
              </a>
            </Button>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.(null)}>
              {t('common.done')}
            </Button>
          </>
        }
      >
        <div className="fw-by-dialog">
          <Banner tone="success" title={t('report.sentBody', { count: sent.report.discrepancyIds.length, time: formatDateTime(sent.report.sentAt, { locale, timeZone }) })} />
          <ul className="fw-by-checks" aria-label={t('report.perRecipient')}>
            {sent.report.to.map((address) => {
              const named = recipients.find((recipient) => recipient.email === address)
              return (
                <li key={address} className="fw-by-check">
                  <CheckCircle2 size={16} className="fw-by-ico is-ok" aria-hidden />
                  <span className="fw-by-check-body">
                    <span>{named ? `${named.name} · ${address}` : address}</span>
                    <span className="fw-by-cell-sub">{t(`report.delivery.${delivery}`)}</span>
                  </span>
                </li>
              )
            })}
            {sent.report.cc.map((address) => (
              <li key={`cc-${address}`} className="fw-by-check">
                <CheckCircle2 size={16} className="fw-by-ico is-ok" aria-hidden />
                <span className="fw-by-check-body">
                  <span>{t('report.ccOf', { address })}</span>
                  <span className="fw-by-cell-sub">{t(`report.delivery.${delivery}`)}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="fw-by-hint">{t('report.sentWhere', { count: sent.report.sentIds.length, moved: sent.report.sentIds.length })}</p>
        </div>
      </Modal>
    )
  }

  return (
    <Frame title={t('report.title', { number: receipt.number })} subtitle={t('report.subtitle', { supplier: receipt.supplier.name })} held={held} label={t('report.send')} onConfirm={() => actions?.onSendReport?.()} daily={daily} actions={actions} size="xxl">
      <div className="fw-rcd-send">
        <div className="fw-by-stack">
          <section aria-label={t('report.which')}>
            <h3 className="fw-by-h3">{t('report.which')}</h3>
            <ul className="fw-by-list">
              {rows.map((row) => (
                <li key={row.id}>
                  {t('disc.number', { seq: row.seq })} · {reasonWords(row, t, locale)} · {lineWords(row, t)}
                  {row.quantity && row.uom ? ` · ${quantity(row.quantity, locale, 4)} ${t(`uom.${row.uom}`)}` : ''}
                  {row.status === 'SENT' ? ` · ${t('report.reminder')}` : ''}
                </li>
              ))}
            </ul>
          </section>
          {draft.check.problem ? (
            <Banner tone="danger" title={t('report.checkFailed')} action={<Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'report', draft: { ...draft, check: { value: null, problem: null } } })}>{t('common.retry')}</Button>} />
          ) : !check ? (
            <p className="fw-by-hint" role="status">
              <Spinner size={14} /> {t('report.checking')}
            </p>
          ) : (
            <>
              {problems.map((key) => (
                <Banner key={key} tone={key === 'report.problem.noContact' ? 'warning' : 'danger'} title={t(key)} />
              ))}
              <fieldset className="fw-rcd-fieldset">
                <legend className="fw-by-h3">{t('report.to')}</legend>
                {check.recipients.length === 0 ? (
                  <p className="fw-by-hint">{t('report.problem.noContact')}</p>
                ) : (
                  <ul className="fw-rcd-checks">
                    {check.recipients.map((recipient) => (
                      <li key={recipient.contactId}>
                        <Checkbox
                          checked={draft.contactIds.includes(recipient.contactId)}
                          onChange={(event) => set({ contactIds: event.target.checked ? [...draft.contactIds, recipient.contactId] : draft.contactIds.filter((id) => id !== recipient.contactId) })}
                          label={t('report.recipient', { name: recipient.name, email: recipient.email, roles: recipient.roles.map((role) => t(`contactRole.${role}`)).join(', ') || '—' })}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </fieldset>
              <div className="fw-by-fields">
                <Field label={t('report.cc')} hint={t('report.ccHint')}>
                  <Input size="sm" value={draft.cc} onChange={(event) => set({ cc: event.target.value })} />
                </Field>
                <Field label={t('report.language')}>
                  <span className="fw-by-inline" role="radiogroup" aria-label={t('report.language')}>
                    {(['it', 'en'] as const).map((language) => (
                      <Radio key={language} name="report-language" checked={draft.language === language} onChange={() => set({ language, preview: { src: null, problem: null } })} label={t(`language.${language}`)} />
                    ))}
                  </span>
                </Field>
              </div>
              <Field label={t('report.subject')}>
                <Input size="sm" maxLength={200} value={draft.subject} onChange={(event) => set({ subject: event.target.value })} />
              </Field>
              <Field label={t('report.message')} hint={t('report.messageHint')}>
                <Textarea rows={5} maxLength={DISCREPANCY_LIMITS.message} value={draft.message} placeholder={check.message} onChange={(event) => set({ message: event.target.value })} />
              </Field>
              <p className="fw-by-hint">{t('report.what')}</p>
            </>
          )}
        </div>
        <section className="fw-by-stack" aria-label={t('report.preview')}>
          <div className="fw-by-card-head">
            <h3 className="fw-by-h3">{t('report.preview')}</h3>
            <Button size="sm" asChild>
              <a href={reportHref(receipt.id, draft.ids, draft.language)} target="_blank" rel="noopener">
                <ExternalLink size={13} aria-hidden /> {t('report.newTab')}
              </a>
            </Button>
          </div>
          {draft.preview.problem ? (
            <Banner tone="warning" title={t(draft.preview.problem)} />
          ) : draft.preview.src ? (
            <PdfViewer src={draft.preview.src} title={t('report.pdfTitle', { number: receipt.number })} fileName={fileName} labels={pdfViewerLabels(shell)} height="min(60vh, 640px)" />
          ) : (
            <p className="fw-by-hint" role="status">
              <Spinner size={14} /> {t('report.previewLoading')}
            </p>
          )}
        </section>
      </div>
    </Frame>
  )
}

// ---- a claim from discrepancies ------------------------------------------------------------------------------------------------

function ClaimDialog({ receipt, daily, actions, dialog }: Props & { dialog: Extract<DailyDialog, { kind: 'claim' }> }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const draft = dialog.draft
  const reasons = (daily.reasons.value ?? []).filter((reason) => reason.list === 'CLAIM')
  const rows = (daily.discrepancies.value ?? []).filter((row) => draft.ids.includes(row.id))
  const held = words(t, claimDraftHeld(draft, daily.reasons.value ?? [], daily.can, daily.busy))
  const set = (next: Partial<typeof draft>) => actions?.onDialog?.({ kind: 'claim', draft: { ...draft, ...next } })
  return (
    <Frame title={t('claim.title', { count: rows.length })} subtitle={t('claim.subtitle', { supplier: receipt.supplier.name, number: receipt.number })} held={held} label={t('claim.confirm')} onConfirm={() => actions?.onClaim?.()} daily={daily} actions={actions}>
      <ul className="fw-by-list">
        {rows.map((row) => (
          <li key={row.id}>
            {t('disc.number', { seq: row.seq })} · {reasonWords(row, t, locale)} · {lineWords(row, t)}
            {row.quantity && row.uom ? ` · ${quantity(row.quantity, locale, 4)} ${t(`uom.${row.uom}`)}` : ''}
          </li>
        ))}
      </ul>
      <div className="fw-by-fields">
        <Field label={t('claim.reason')} required hint={daily.reasons.problem ? t('new.reasonsFailed') : undefined}>
          <Select size="sm" value={draft.reasonCode} onChange={(event) => set({ reasonCode: event.target.value })} autoFocus>
            <option value="">{t('claim.reasonPick')}</option>
            {reasons.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {locale === 'en' ? reason.labelEn : reason.labelIt}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('claim.remedy')}>
          <span className="fw-by-inline" role="radiogroup" aria-label={t('claim.remedy')}>
            {(['CREDIT', 'REPLACEMENT'] as const).map((remedy) => (
              <Radio key={remedy} name="claim-remedy" checked={draft.remedy === remedy} onChange={() => set({ remedy })} label={t(`remedy.${remedy}`)} />
            ))}
          </span>
        </Field>
      </div>
      <Field label={t('claim.note')} hint={t('claim.noteHint')}>
        <Textarea rows={3} maxLength={500} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      <p className="fw-by-hint">{t('claim.what')}</p>
    </Frame>
  )
}

// ---- Request from supplier (Documents check) -------------------------------------------------------------------------------------

function RequestDialog({ receipt, daily, actions, dialog }: Props & { dialog: Extract<DailyDialog, { kind: 'request' }> }) {
  const t = useT(NAMESPACE)
  const draft = dialog.draft
  const set = (next: Partial<typeof draft>) => actions?.onDialog?.({ kind: 'request', draft: { ...draft, ...next } })
  const held = words(t, requestHeld(draft, daily.can, daily.busy))
  const contacts = draft.contacts.value
  const wanted = draft.wanted.map((entry) => ({ key: entry.key, label: entry.lot ? `${t(`docs.ask.${entry.ask}`)} · ${t('docs.lotOf', { code: entry.lot.code, ref: entry.lot.supplierLotRef ?? '—', dye: entry.lot.dyeBatch ?? '—' })}` : t(`docs.ask.${entry.ask}`) }))
  if (draft.sentTo) {
    return (
      <Modal open onClose={() => actions?.onDialog?.(null)} title={t('request.sentTitle')} size="md" footer={<><span className="grow" /><Button size="sm" variant="primary" onClick={() => actions?.onDialog?.(null)}>{t('common.done')}</Button></>}>
        <div className="fw-by-dialog">
          <Banner tone="success" title={t('request.sentBody', { to: draft.sentTo.join(', ') })} />
          <p className="fw-by-hint">{t('request.sentWhere')}</p>
        </div>
      </Modal>
    )
  }
  return (
    <Frame title={t('request.title')} subtitle={t('request.subtitle', { supplier: receipt.supplier.name, number: receipt.number })} held={held} label={t('request.send')} onConfirm={() => actions?.onRequest?.()} daily={daily} actions={actions} size="lg">
      {draft.contacts.problem ? (
        <Banner tone="danger" title={t('request.contactsFailed')} />
      ) : !contacts ? (
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t('request.loading')}
        </p>
      ) : (
        <>
          <fieldset className="fw-rcd-fieldset">
            <legend className="fw-by-h3">{t('request.asked')}</legend>
            <ul className="fw-rcd-checks">
              {wanted.map((entry) => (
                <li key={entry.key}>
                  <Checkbox checked={draft.asked.includes(entry.key)} onChange={(event) => set({ asked: event.target.checked ? [...draft.asked, entry.key] : draft.asked.filter((key) => key !== entry.key) })} label={entry.label} />
                </li>
              ))}
            </ul>
          </fieldset>
          <fieldset className="fw-rcd-fieldset">
            <legend className="fw-by-h3">{t('report.to')}</legend>
            {contacts.length === 0 ? (
              <p className="fw-by-hint">{t('report.problem.noContact')}</p>
            ) : (
              <ul className="fw-rcd-checks">
                {contacts.map((contact) => (
                  <li key={contact.id}>
                    <Checkbox
                      checked={draft.to.includes(contact.id)}
                      onChange={(event) => set({ to: event.target.checked ? [...draft.to, contact.id] : draft.to.filter((id) => id !== contact.id) })}
                      label={t('report.recipient', { name: contact.name, email: contact.email ?? '—', roles: contact.roles.map((role) => t(`contactRole.${role}`)).join(', ') || '—' })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <Field label={t('report.language')} hint={t('request.languageHint')}>
            <span className="fw-by-inline" role="radiogroup" aria-label={t('report.language')}>
              {(['it', 'en'] as const).map((language) => (
                <Radio key={language} name="request-language" checked={draft.language === language} onChange={() => set({ language, edited: draft.edited })} label={t(`language.${language}`)} />
              ))}
            </span>
          </Field>
          <Field label={t('report.subject')} required>
            <Input size="sm" maxLength={200} value={draft.subject} onChange={(event) => set({ subject: event.target.value, edited: true })} />
          </Field>
          <Field label={t('request.body')} required hint={t('request.bodyHint')}>
            <Textarea rows={9} maxLength={4000} value={draft.body} onChange={(event) => set({ body: event.target.value, edited: true })} />
          </Field>
          <p className="fw-by-hint">{t('request.what')}</p>
        </>
      )}
    </Frame>
  )
}
