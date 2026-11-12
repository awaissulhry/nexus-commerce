'use client'

import { useEffect } from 'react'
import { ScanLine } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Kbd, Radio, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { Qty } from '../../../../_shared/stock/parts'
import {
  entryShort,
  lineOfTag,
  receivableLines,
  receiveHeld,
  settleHeld,
  shipHeld,
  TRANSFER_DDT_REASONS,
  TRANSFER_RESOLUTIONS,
  TRANSFER_TRANSPORT,
  type Phrase,
  type ReceiveEntry,
  type ShipDraft,
  type TransferDdtReason,
  type TransferResolution,
  type TransferTransport,
  type TransferView,
} from '../../model'
import { NoticeLine, useWords } from '../../parts'
import type { RecordDialog, TransferRecordActions, TransferRecordModel } from '../view-model'
import { PickerDialog } from './PickerDialog'

/** ⌘↵ submits a dialog when it is not held (as every dialog of the Office). */
function useSubmitKey(held: boolean, onSubmit?: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, onSubmit])
}

function Footer({ onClose, submit, held, onSubmit, tone = 'primary' }: { onClose?: () => void; submit: string; held: string | null; onSubmit?: () => void; tone?: 'primary' | 'danger' }) {
  const { t } = useWords()
  return (
    <>
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" variant={tone} heldReason={held} onClick={onSubmit} aria-keyshortcuts="Meta+Enter">
        {submit}
        <span className="fw-trf-keys" aria-hidden>
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </span>
      </Button>
    </>
  )
}

export function RecordDialogs({ transfer, model, actions }: { transfer: TransferView; model: TransferRecordModel; actions?: TransferRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  if (dialog.kind === 'ship') return <ShipDialog transfer={transfer} model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'receive') return <ReceiveDialog transfer={transfer} model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'settle') return <SettleDialog transfer={transfer} model={model} dialog={dialog} actions={actions} />
  if (dialog.kind === 'cancel') return <CancelDialog transfer={transfer} model={model} dialog={dialog} actions={actions} />
  return <PickerDialog transfer={transfer} model={model} picker={dialog.picker} actions={actions} />
}

// ---- Ship transfer ---------------------------------------------------------------------------------------------------------

/**
 * Ship transfer (design pop:tr-ship, a confirm from the record's primary): "posts moves to the in-transit location; issues
 * the DDT number (never reused)". The DDT's own fields: the reason (Transfer between sites; between two companies the one
 * the accountant says), who carries the goods (own van or a carrier, named), packages, gross weight, appearance, tracking,
 * the expected arrival.
 */
function ShipDialog({ transfer, model, dialog, actions }: { transfer: TransferView; model: TransferRecordModel; dialog: Extract<RecordDialog, { kind: 'ship' }>; actions?: TransferRecordActions }) {
  const { t, say } = useWords()
  const draft = dialog.draft
  const held = say(shipHeld(draft, transfer, model.today, model.live === 'offline'))
  const heldText = dialog.busy ? t('common.working') : held
  const set = (patch: Partial<ShipDraft>) => actions?.onDialog?.({ ...dialog, draft: { ...draft, ...patch } })
  useSubmitKey(!!heldText, actions?.onShip)
  const lines = transfer.lines
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('ship.title', { number: transfer.number })} size="lg" footer={<Footer onClose={() => actions?.onDialog?.(null)} submit={t('ship.submit')} held={heldText} onSubmit={actions?.onShip} />}>
      <div className="fw-trf-form">
        <Banner tone="info" title={t('ship.what', { count: lines.length, place: transfer.transit.code })}>
          {t('ship.never')}
        </Banner>
        <div className="fw-trf-form-grid">
          <Field label={t('ship.reason')} hint={transfer.interCompany ? t('ship.reasonInter') : t('ship.reasonHint')}>
            <Select size="sm" value={draft.reason} onChange={(event) => set({ reason: event.target.value as TransferDdtReason })}>
              {TRANSFER_DDT_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {t(`reason.${reason}`)}
                </option>
              ))}
            </Select>
          </Field>
          {draft.reason === 'OTHER' && (
            <Field label={t('ship.reasonText')} required>
              <Input size="sm" value={draft.reasonText} maxLength={200} onChange={(event) => set({ reasonText: event.target.value })} />
            </Field>
          )}
          <Field label={t('ship.by')} required>
            <Select size="sm" value={draft.transportBy} onChange={(event) => set({ transportBy: event.target.value as TransferTransport })}>
              {TRANSFER_TRANSPORT.map((by) => (
                <option key={by} value={by}>
                  {t(`transport.${by}`)}
                </option>
              ))}
            </Select>
          </Field>
          {draft.transportBy === 'CARRIER' && (
            <>
              <Field label={t('ship.carrier')} required>
                <Input size="sm" value={draft.carrierName} maxLength={200} onChange={(event) => set({ carrierName: event.target.value })} />
              </Field>
              <Field label={t('ship.carrierVat')}>
                <Input size="sm" value={draft.carrierVatNumber} maxLength={40} onChange={(event) => set({ carrierVatNumber: event.target.value })} />
              </Field>
            </>
          )}
          <Field label={t('ship.packages')} required>
            <Input size="sm" inputMode="numeric" value={draft.packages} onChange={(event) => set({ packages: event.target.value })} />
          </Field>
          <Field label={t('ship.weight')} required>
            <Input size="sm" inputMode="decimal" value={draft.grossWeightKg} onChange={(event) => set({ grossWeightKg: event.target.value })} />
          </Field>
          <Field label={t('ship.appearance')} hint={t('ship.appearanceHint')}>
            <Input size="sm" value={draft.appearance} maxLength={200} onChange={(event) => set({ appearance: event.target.value })} />
          </Field>
          <Field label={t('ship.expected')}>
            <DateField value={draft.expectedOn} clearable onChange={(value) => set({ expectedOn: value })} />
          </Field>
          <Field label={t('ship.trackingRef')}>
            <Input size="sm" value={draft.trackingRef} maxLength={100} onChange={(event) => set({ trackingRef: event.target.value })} />
          </Field>
          <Field label={t('ship.trackingUrl')}>
            <Input size="sm" type="url" value={draft.trackingUrl} maxLength={500} onChange={(event) => set({ trackingUrl: event.target.value })} />
          </Field>
          <Field label={t('ship.language')}>
            <Select size="sm" value={draft.language} onChange={(event) => set({ language: event.target.value === 'en' ? 'en' : 'it' })}>
              <option value="it">{t('ship.languageIt')}</option>
              <option value="en">{t('ship.languageEn')}</option>
            </Select>
          </Field>
        </div>
        <NoticeLine notice={dialog.notice} lines={dialog.lines} />
      </div>
    </Modal>
  )
}

// ---- Receive transfer ----------------------------------------------------------------------------------------------------------

/**
 * Receive transfer (design pop:tr-recv, from the Received tab): the received quantity per line (all of what is in transit by
 * default), hides scanned one by one (the scan ticks the hide's line: a hide arrives whole), where each is put at the other
 * site, and for a line that arrives short its reason (the Discrepancy list): the rest stays on the transit place until it is
 * settled. Without a reason a short line waits for the rest (partly received).
 */
function ReceiveDialog({ transfer, model, dialog, actions }: { transfer: TransferView; model: TransferRecordModel; dialog: Extract<RecordDialog, { kind: 'receive' }>; actions?: TransferRecordActions }) {
  const { t, say, locale } = useWords()
  const held = say(receiveHeld(dialog.draft, transfer, model.live === 'offline'))
  const heldText = dialog.busy ? t('common.working') : held
  useSubmitKey(!!heldText, actions?.onReceive)
  const lines = receivableLines(transfer)
  const setEntry = (lineId: string, patch: Partial<ReceiveEntry>) => actions?.onDialog?.({ ...dialog, draft: { ...dialog.draft, [lineId]: { ...dialog.draft[lineId]!, ...patch } } })
  const scan = () => {
    const line = lineOfTag(transfer, dialog.scan)
    if (!line) {
      actions?.onDialog?.({ ...dialog, scanNote: { key: 'receive.scanUnknown', params: { tag: dialog.scan.trim() } } })
      return
    }
    actions?.onDialog?.({ ...dialog, scan: '', scanNote: { key: 'receive.scanned', params: { tag: line.hide!.code, seq: line.seq } }, draft: { ...dialog.draft, [line.id]: { ...dialog.draft[line.id]!, quantity: line.inTransit } } })
  }
  const hides = lines.filter((line) => line.hide)
  const reasonLabel = (code: string) => {
    const reason = transfer.reasons.find((entry) => entry.code === code)
    return reason ? (locale === 'it' ? reason.labelIt : reason.labelEn) : code
  }
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('receive.title', { number: transfer.number })} size="xl" footer={<Footer onClose={() => actions?.onDialog?.(null)} submit={t('receive.submit')} held={heldText} onSubmit={actions?.onReceive} />}>
      <div className="fw-trf-form">
        <p className="fw-trf-hint">{t('receive.intro', { site: transfer.to.code })}</p>
        {hides.length > 0 && (
          <div className="fw-trf-scan">
            <Field label={t('receive.scan')} hint={t('receive.scanHint', { count: hides.length })}>
              <Input
                size="sm"
                value={dialog.scan}
                aria-label={t('receive.scan')}
                placeholder={t('receive.scanPlaceholder')}
                onChange={(event) => actions?.onDialog?.({ ...dialog, scan: event.target.value, scanNote: null })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    scan()
                  }
                }}
              />
            </Field>
            <Button size="sm" variant="secondary" heldReason={dialog.scan.trim() ? null : t('held.scanFirst')} onClick={scan}>
              <ScanLine size={14} aria-hidden /> {t('receive.scanButton')}
            </Button>
          </div>
        )}
        {dialog.scanNote && <p className="fw-trf-hint" role="status">{say(dialog.scanNote)}</p>}
        {lines.length === 0 ? (
          <p className="fw-trf-text">{t('receive.nothing')}</p>
        ) : (
          lines.map((line) => {
            const entry = dialog.draft[line.id]
            if (!entry) return null
            const short = entryShort(line, entry)
            return (
              <fieldset key={line.id} className="fw-trf-fieldset" aria-label={t('receive.lineLabel', { seq: line.seq, item: line.item.code })}>
                <KeyValue
                  columns={3}
                  dense
                  labelCase="sentence"
                  items={[
                    { label: t('receive.line'), value: `${line.seq} · ${line.item.code}${line.colour ? ` · ${line.colour.name}` : ''}` },
                    { label: line.hide ? t('receive.hideTag') : t('receive.lot'), value: line.hide?.code ?? line.lot?.code ?? '—' },
                    { label: t('receive.inTransit'), value: <Qty value={line.inTransit} uom={line.uom} decimals={4} /> },
                  ]}
                />
                <div className="fw-trf-form-grid">
                  {line.hide ? (
                    <Field label={t('receive.hideArrived')}>
                      <Select size="sm" value={entry.quantity === '0' ? 'no' : 'yes'} onChange={(event) => setEntry(line.id, { quantity: event.target.value === 'yes' ? line.inTransit : '0' })}>
                        <option value="no">{t('receive.hideNotYet')}</option>
                        <option value="yes">{t('receive.hideYes')}</option>
                      </Select>
                    </Field>
                  ) : (
                    <Field label={t('receive.quantity')} hint={t('receive.quantityHint')}>
                      <Input size="sm" inputMode="decimal" value={entry.quantity} aria-label={t('receive.quantityOf', { seq: line.seq })} onChange={(event) => setEntry(line.id, { quantity: event.target.value })} />
                    </Field>
                  )}
                  <Field label={t('receive.putAt')} hint={line.toLocation ? undefined : transfer.toLocation ? t('receive.putDefault', { place: transfer.toLocation.code }) : t('receive.putRequired')}>
                    <Select size="sm" value={entry.toLocationId ?? ''} disabled={!!line.toLocation} onChange={(event) => setEntry(line.id, { toLocationId: event.target.value || null })}>
                      <option value="">{line.toLocation ? `${line.toLocation.code} · ${line.toLocation.name}` : transfer.toLocation ? `${transfer.toLocation.code} · ${transfer.toLocation.name}` : t('receive.pickPlace')}</option>
                      {(model.toPlaces ?? []).map((place) => (
                        <option key={place.id} value={place.id}>
                          {place.code} · {place.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {short && (
                    <Field label={t('receive.reason')} hint={entry.reason ? t('receive.reasonCloses') : t('receive.reasonWaits')}>
                      <Select size="sm" value={entry.reason ?? ''} onChange={(event) => setEntry(line.id, { reason: event.target.value || null })}>
                        <option value="">{t('receive.moreComing')}</option>
                        {transfer.reasons.map((reason) => (
                          <option key={reason.code} value={reason.code}>
                            {reasonLabel(reason.code)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </div>
                {short && entry.reason && (
                  <Field label={t('receive.note')}>
                    <Textarea value={entry.note} rows={2} honourRows maxLength={1000} onChange={(event) => setEntry(line.id, { note: event.target.value })} />
                  </Field>
                )}
              </fieldset>
            )
          })
        )}
        <NoticeLine notice={dialog.notice} lines={dialog.lines} />
      </div>
    </Modal>
  )
}

// ---- Settle a difference -------------------------------------------------------------------------------------------------------------

function SettleDialog({ transfer, model, dialog, actions }: { transfer: TransferView; model: TransferRecordModel; dialog: Extract<RecordDialog, { kind: 'settle' }>; actions?: TransferRecordActions }) {
  const { t, say, locale } = useWords()
  const line = transfer.lines.find((entry) => entry.id === dialog.draft.lineId)
  const held = say(settleHeld(dialog.draft, line, transfer, model.live === 'offline'))
  const heldText = dialog.busy ? t('common.working') : held
  useSubmitKey(!!heldText, actions?.onSettle)
  const set = (patch: Partial<typeof dialog.draft>) => actions?.onDialog?.({ ...dialog, draft: { ...dialog.draft, ...patch } })
  const reason = line?.differenceReasonCode ? transfer.reasons.find((entry) => entry.code === line.differenceReasonCode) : undefined
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('settle.title', { seq: line?.seq ?? '' })} size="md" footer={<Footer onClose={() => actions?.onDialog?.(null)} submit={t('settle.submit')} held={heldText} onSubmit={actions?.onSettle} />}>
      <div className="fw-trf-form">
        {line && (
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('settle.line'), value: `${line.seq} · ${line.item.code}` },
              { label: t('settle.missing'), value: <Qty value={line.inTransit} uom={line.uom} decimals={4} /> },
              { label: t('settle.reason'), value: reason ? (locale === 'it' ? reason.labelIt : reason.labelEn) : (line.differenceReasonCode ?? '—') },
              { label: t('settle.onPlace'), value: transfer.transit.code },
            ]}
          />
        )}
        <fieldset className="fw-trf-choices">
          <legend className="fw-trf-h3">{t('settle.how')}</legend>
          {TRANSFER_RESOLUTIONS.map((resolution) => {
            const disabled = resolution === 'SENT_BACK' && !!line && line.receivedQuantity !== '0'
            return (
              <Radio
                key={resolution}
                name="resolution"
                value={resolution}
                checked={dialog.draft.resolution === resolution}
                disabled={disabled}
                onChange={() => set({ resolution: resolution as TransferResolution })}
                label={
                  <span className="fw-trf-choice">
                    <span>{t(`resolution.${resolution}`)}</span>
                    <span className="fw-trf-hint">{disabled ? t('refusal.SENT_BACK_PART') : t(`resolution.hint.${resolution}`)}</span>
                  </span>
                }
              />
            )
          })}
        </fieldset>
        <Field label={t('settle.note')}>
          <Textarea value={dialog.draft.note} rows={2} honourRows maxLength={1000} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        <NoticeLine notice={dialog.notice} />
      </div>
    </Modal>
  )
}

// ---- Cancel (a draft only) --------------------------------------------------------------------------------------------------------

function CancelDialog({ transfer, model, dialog, actions }: { transfer: TransferView; model: TransferRecordModel; dialog: Extract<RecordDialog, { kind: 'cancel' }>; actions?: TransferRecordActions }) {
  const { t, say } = useWords()
  const base: Phrase | null = transfer.actions.cancel.allowed ? (model.live === 'offline' ? { key: 'held.offline' } : dialog.reason.trim() ? null : { key: 'held.cancelReason' }) : { key: `refusal.${transfer.actions.cancel.refusal ?? 'NOT_DRAFT'}` }
  const heldText = dialog.busy ? t('common.working') : say(base)
  useSubmitKey(!!heldText, actions?.onCancel)
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('cancel.title', { number: transfer.number })} size="md" footer={<Footer onClose={() => actions?.onDialog?.(null)} submit={t('cancel.submit')} held={heldText} onSubmit={actions?.onCancel} tone="danger" />}>
      <div className="fw-trf-form">
        <p className="fw-trf-text">{t('cancel.body')}</p>
        <Field label={t('cancel.reason')} required>
          <Textarea value={dialog.reason} rows={3} honourRows maxLength={500} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
        </Field>
        <NoticeLine notice={dialog.notice} />
      </div>
    </Modal>
  )
}
