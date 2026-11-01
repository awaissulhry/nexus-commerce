'use client'

import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { Banner, Field, phraseMatches } from '@nexus/ui/components'
import { SizeGridEditor } from '@nexus/ui/grid'
import { Button, Input, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ConfirmPhraseField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { SubcontractOrder } from '../../api'
import { addOperationHeld, kitLineHeld, sizesHeld, sizesOf, type RecordDialog, type SubcontractRecordActions, type SubcontractRecordModel } from '../record-model'
import { dateLocale, gridCopy } from './OperationsTab'
import { DialogProblem, useSay } from './parts'
import { ReceiveDialog } from './ReceiveDialog'
import { SendKitDialog } from './SendKitDialog'

export interface DialogProps {
  order: SubcontractOrder
  model: SubcontractRecordModel
  actions?: SubcontractRecordActions
}

/**
 * The record's dialogs (Esc closes each and the focus goes back to its opener; ⌘↵ confirms where it may): Cancel (the
 * reason), Close, Add operation (from the work order's routing), Remove operation, Pieces per size (the DS size grid
 * editor), Add kit line, Remove kit lines, Take back a kit line that never left, Annul a kit DDT (its number typed), and
 * Send kit / Receive back (their own files). Each refusal is said inside its dialog, in this app's words.
 */
export function RecordDialogs(props: DialogProps) {
  const dialog = props.model.dialog
  if (!dialog) return null
  switch (dialog.kind) {
    case 'cancel':
      return <CancelDialog {...props} dialog={dialog} />
    case 'close':
      return <CloseDialog {...props} dialog={dialog} />
    case 'addOperation':
      return <AddOperationDialog {...props} dialog={dialog} />
    case 'removeOperation':
      return <RemoveOperationDialog {...props} dialog={dialog} />
    case 'sizes':
      return <SizesDialog {...props} dialog={dialog} />
    case 'kitLine':
      return <KitLineDialog {...props} dialog={dialog} />
    case 'removeKit':
      return <RemoveKitDialog {...props} dialog={dialog} />
    case 'returnLine':
      return <ReturnLineDialog {...props} dialog={dialog} />
    case 'annul':
      return <AnnulDialog {...props} dialog={dialog} />
    case 'send':
      return <SendKitDialog {...props} draft={dialog.draft} />
    case 'receive':
      return <ReceiveDialog {...props} draft={dialog.draft} />
  }
}

type Of<K extends RecordDialog['kind']> = Extract<RecordDialog, { kind: K }>

/** A dialog's frame: the title, the body, Cancel and the confirm held with why (⌘↵ confirms when it is not held). */
export function Frame({ model, actions, title, held, label, tone, size = 'md', onConfirm, children }: { model: SubcontractRecordModel; actions?: SubcontractRecordActions; title: string; held: string | null; label: string; tone?: 'danger'; size?: 'sm' | 'md' | 'lg'; onConfirm?: () => void; children: ReactNode }) {
  const t = useT('subcontract-order')
  const blocked = model.busy ? t('held.busy') : held
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={title}
      size={size}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)} heldReason={model.busy ? t('held.busy') : null}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" tone={tone} heldReason={blocked} onClick={onConfirm} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy && <Spinner size={12} />} {label}
          </Button>
        </>
      }
    >
      <div
        className="fw-by-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !blocked) {
            event.preventDefault()
            onConfirm?.()
          }
        }}
      >
        {children}
        <DialogProblem problem={model.dialogProblem} />
      </div>
    </Modal>
  )
}

function CancelDialog({ order, model, actions, dialog }: DialogProps & { dialog: Of<'cancel'> }) {
  const t = useT('subcontract-order')
  const planned = order.kitLines.filter((line) => line.status === 'PLANNED').length
  return (
    <Frame model={model} actions={actions} title={t('cancel.title', { number: order.number })} held={dialog.reason.trim().length === 0 ? t('cancel.reasonNeeded') : null} label={t('cancel.confirm')} tone="danger" onConfirm={() => actions?.onCancel?.()}>
      <ul className="fw-by-list">
        <li>{t('cancel.what', { workshop: order.workshop.name })}</li>
        {planned > 0 && <li>{t('cancel.kit', { count: planned })}</li>}
        <li>{t('cancel.pieces', { number: order.workOrder.number })}</li>
        <li>{t('cancel.final')}</li>
      </ul>
      <Field label={t('cancel.reason')} required hint={t('cancel.reasonHint')}>
        <Textarea rows={3} maxLength={500} value={dialog.reason} autoFocus onChange={(event) => actions?.onDialog?.({ kind: 'cancel', reason: event.target.value })} />
      </Field>
    </Frame>
  )
}

function CloseDialog({ order, model, actions, dialog }: DialogProps & { dialog: Of<'close'> }) {
  const t = useT('subcontract-order')
  return (
    <Frame model={model} actions={actions} title={t('close.title', { number: order.number })} held={null} label={t('close.confirm')} onConfirm={() => actions?.onClose?.()}>
      <ul className="fw-by-list">
        <li>{t('close.back', { good: order.pieces.backGood, defective: order.pieces.backDefective, scrapped: order.pieces.scrapped })}</li>
        <li>{t('close.balanceLater')}</li>
        <li>{t('close.final')}</li>
      </ul>
      <Field label={t('close.note')} hint={t('close.noteHint')}>
        <Textarea rows={2} maxLength={1000} value={dialog.note} onChange={(event) => actions?.onDialog?.({ kind: 'close', note: event.target.value })} />
      </Field>
    </Frame>
  )
}

function AddOperationDialog({ order, model, actions, dialog }: DialogProps & { dialog: Of<'addOperation'> }) {
  const t = useT('subcontract-order')
  const sayWords = useSay()
  const { draft } = dialog
  const held = addOperationHeld(draft, order)
  const outside = draft.outside.value
  const garments = outside ? outside.cells.reduce((sum, cell) => sum + cell.quantity, 0) : 0
  const onOrder = new Set(order.operations.map((operation) => operation.workOrderOperation.id))
  const options = outside ? outside.operations.filter((operation) => !onOrder.has(operation.id)) : []
  const set = (next: Partial<typeof draft>) => actions?.onDialog?.({ kind: 'addOperation', draft: { ...draft, ...next } })
  return (
    <Frame model={model} actions={actions} title={t('addOperation.title')} held={held ? sayWords(held) : null} label={t('addOperation.confirm')} onConfirm={() => actions?.onAddOperation?.()}>
      <p className="fw-by-hint">{t('addOperation.body', { number: order.workOrder.number })}</p>
      {draft.outside.problem ? (
        <Banner tone="danger" title={t(draft.outside.problem)} />
      ) : !outside ? (
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t('addOperation.loading')}
        </p>
      ) : options.length === 0 ? (
        <p className="fw-by-hint">{t('addOperation.none')}</p>
      ) : (
        <div className="fw-by-stack" role="radiogroup" aria-label={t('addOperation.operation')}>
          {options.map((operation) => {
            const left = garments - operation.ordered
            const picked = draft.operationId === operation.id
            return (
              <Button key={operation.id} size="sm" variant={picked ? 'tonal' : 'quiet'} active={picked} aria-pressed={picked} heldReason={left < 1 ? t('addOperation.full') : null} onClick={() => set({ operationId: operation.id, pieces: String(Math.max(0, left)) })}>
                <span className="fw-by-inline">
                  <b>{t('addOperation.line', { seq: operation.seq, code: operation.code, name: operation.name })}</b>
                  <span className="fw-by-hint">{t('addOperation.left', { left: Math.max(0, left), garments })}</span>
                  {operation.outside ? <Tag tone="info">{t('addOperation.outside', { workshop: operation.outside.workshop?.name ?? '—' })}</Tag> : <Tag tone="neutral">{t('addOperation.inHouse')}</Tag>}
                </span>
              </Button>
            )
          })}
        </div>
      )}
      {draft.operationId && (
        <Field label={t('addOperation.pieces')} hint={t('addOperation.piecesHint')}>
          <Input size="sm" inputMode="numeric" value={draft.pieces} onChange={(event) => set({ pieces: event.target.value })} />
        </Field>
      )}
    </Frame>
  )
}

function RemoveOperationDialog({ order, model, actions, dialog }: DialogProps & { dialog: Of<'removeOperation'> }) {
  const t = useT('subcontract-order')
  const operation = order.operations.find((entry) => entry.id === dialog.operationId)
  return (
    <Frame model={model} actions={actions} title={t('removeOperation.title', { line: operation?.seq ?? '—' })} held={null} label={t('removeOperation.confirm')} tone="danger" onConfirm={() => actions?.onRemoveOperation?.()}>
      <p>{operation ? t('removeOperation.body', { code: operation.workOrderOperation.code, name: operation.workOrderOperation.name, count: operation.pieces }) : ''}</p>
    </Frame>
  )
}

function SizesDialog({ order, model, actions, dialog }: DialogProps & { dialog: Of<'sizes'> }) {
  const t = useT('subcontract-order')
  const sayWords = useSay()
  const locale = useLocale()
  const { draft } = dialog
  const operation = order.operations.find((entry) => entry.id === draft.operationId)
  const held = sizesHeld(draft)
  const cells = draft.cells.value
  const colours = cells ? [...new Set(cells.map((cell) => cell.colourway))].map((key) => ({ key, label: key, offered: cells.filter((cell) => cell.colourway === key).map((cell) => cell.size) })) : []
  const sizes = cells ? [...new Set(cells.map((cell) => cell.size))].sort((a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : 0)).map((key) => ({ key, label: key })) : []
  const total = sizesOf(draft).pieces
  return (
    <Frame model={model} actions={actions} size="lg" title={t('sizes.title', { line: operation?.seq ?? '—' })} held={held ? sayWords(held) : null} label={t('sizes.confirm', { count: total })} onConfirm={() => actions?.onSaveSizes?.()}>
      <p className="fw-by-hint">{t('sizes.body', { number: order.workOrder.number })}</p>
      {draft.cells.problem ? (
        <Banner tone="danger" title={t(draft.cells.problem)} />
      ) : !cells ? (
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t('sizes.loading')}
        </p>
      ) : (
        <>
          <SizeGridEditor colours={colours} sizes={sizes} value={draft.value} onChange={(value) => actions?.onDialog?.({ kind: 'sizes', draft: { ...draft, value } })} locale={dateLocale(locale)} copy={gridCopy(t)} caption={t('sizes.caption')} />
          <p className="fw-by-hint">{t('sizes.max', { cells: cells.map((cell) => `${cell.colourway} ${cell.size} ≤ ${cell.quantity}`).join(' · ') })}</p>
        </>
      )}
    </Frame>
  )
}

function KitLineDialog({ model, actions, dialog }: DialogProps & { dialog: Of<'kitLine'> }) {
  const t = useT('subcontract-order')
  const sayWords = useSay()
  const { draft } = dialog
  const held = kitLineHeld(draft)
  const set = (next: Partial<typeof draft>) => actions?.onDialog?.({ kind: 'kitLine', draft: { ...draft, ...next } })
  const units = draft.material ? [...new Set([draft.material.units.base.uom, draft.material.units.consumption.uom, draft.material.units.purchase.uom])] : []
  return (
    <Frame model={model} actions={actions} title={t('kitLine.title')} held={held ? sayWords(held) : null} label={t('kitLine.confirm')} onConfirm={() => actions?.kitLine?.onSave?.()}>
      {!model.can.materials ? (
        <Banner tone="info" title={t('kitLine.noMaterials')} />
      ) : (
        <>
          <Field label={t('kitLine.material')} required>
            <Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} value={draft.query} placeholder={t('kitLine.search')} autoFocus onChange={(event) => actions?.kitLine?.onQuery?.(event.target.value)} />
          </Field>
          {draft.materialsProblem ? (
            <Banner tone="danger" title={t(draft.materialsProblem)} />
          ) : draft.materials === null ? (
            <p className="fw-by-hint" role="status">
              <Spinner size={14} /> {t('common.loading')}
            </p>
          ) : draft.materials.length === 0 ? (
            <p className="fw-by-hint">{t('kitLine.noMatch')}</p>
          ) : (
            <div className="fw-by-stack" role="radiogroup" aria-label={t('kitLine.material')}>
              {draft.materials.slice(0, 8).map((option) => {
                const picked = draft.material?.id === option.id
                return (
                  <Button key={option.id} size="sm" variant={picked ? 'tonal' : 'quiet'} active={picked} aria-pressed={picked} onClick={() => actions?.kitLine?.onMaterial?.(option.id)}>
                    <span className="fw-by-inline">
                      <span className="fw-by-code">{option.code}</span> {option.name}
                    </span>
                  </Button>
                )
              })}
            </div>
          )}
          {draft.material && (
            <div className="fw-by-fields">
              {draft.material.colours.some((colour) => colour.status === 'ACTIVE') && (
                <Field label={t('kitLine.colour')} required>
                  <Select size="sm" value={draft.itemColourId} onChange={(event) => set({ itemColourId: event.target.value })}>
                    <option value="">{t('kitLine.pickColour')}</option>
                    {draft.material.colours
                      .filter((colour) => colour.status === 'ACTIVE')
                      .map((colour) => (
                        <option key={colour.id} value={colour.id}>
                          {colour.code} · {colour.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              )}
              <Field label={t('kitLine.quantity')} required>
                <Input size="sm" inputMode="decimal" value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} />
              </Field>
              <Field label={t('kitLine.unit')}>
                <Select size="sm" value={draft.uom || draft.material.units.base.uom} onChange={(event) => set({ uom: event.target.value })}>
                  {units.map((unit) => (
                    <option key={unit} value={unit}>
                      {t(`uom.${unit}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          {draft.material?.tracking === 'HIDE' && <Banner tone="info" title={t('kitLine.hideNote')} />}
        </>
      )}
    </Frame>
  )
}

function RemoveKitDialog({ order, model, actions, dialog }: DialogProps & { dialog: Of<'removeKit'> }) {
  const t = useT('subcontract-order')
  const lines = order.kitLines.filter((line) => dialog.lineIds.includes(line.id))
  return (
    <Frame model={model} actions={actions} title={t('removeKit.title', { count: lines.length })} held={lines.some((line) => line.status !== 'PLANNED') ? t('removeKit.onlyPlanned') : null} label={t('removeKit.confirm', { count: lines.length })} tone="danger" onConfirm={() => actions?.onRemoveKit?.()}>
      <ul className="fw-by-list">
        {lines.map((line) => (
          <li key={line.id}>{t('removeKit.line', { seq: line.seq, code: line.item.code, name: line.item.name })}</li>
        ))}
      </ul>
    </Frame>
  )
}

function ReturnLineDialog({ order, model, actions, dialog }: DialogProps & { dialog: Of<'returnLine'> }) {
  const t = useT('subcontract-order')
  const line = order.kitLines.find((entry) => entry.id === dialog.lineId)
  const ddtLive = !!line?.ddt && !line.ddt.cancelled
  return (
    <Frame model={model} actions={actions} title={t('returnLine.title', { seq: line?.seq ?? '—' })} held={ddtLive ? t('returnLine.held.ddtLive', { number: line!.ddt!.number }) : dialog.reason.trim().length === 0 ? t('returnLine.held.reason') : null} label={t('returnLine.confirm')} onConfirm={() => actions?.onReturnLine?.()}>
      <ul className="fw-by-list">
        <li>{t('returnLine.what', { code: line?.item.code ?? '', name: line?.item.name ?? '' })}</li>
        <li>{t('returnLine.reverse')}</li>
        {ddtLive && <li>{t('returnLine.ddtFirst', { number: line!.ddt!.number })}</li>}
      </ul>
      <Field label={t('returnLine.reason')} required>
        <Textarea rows={2} maxLength={500} value={dialog.reason} onChange={(event) => actions?.onDialog?.({ kind: 'returnLine', lineId: dialog.lineId, reason: event.target.value })} />
      </Field>
    </Frame>
  )
}

function AnnulDialog({ order, model, actions, dialog }: DialogProps & { dialog: Of<'annul'> }) {
  const t = useT('subcontract-order')
  const ddt = order.ddts.find((entry) => entry.id === dialog.ddtId)
  const number = ddt?.number ?? ''
  const held = dialog.reason.trim().length < 3 ? t('annul.held.reason') : !phraseMatches(dialog.typed, number) ? t('annul.held.phrase') : null
  const set = (next: Partial<Of<'annul'>>) => actions?.onDialog?.({ ...dialog, ...next })
  return (
    <Frame model={model} actions={actions} title={t('annul.title', { number })} held={held} label={t('annul.confirm')} tone="danger" onConfirm={() => actions?.onAnnul?.()}>
      <ul className="fw-by-list">
        <li>{t('annul.keeps', { number })}</li>
        <li>{t('annul.lines')}</li>
        <li>{t('annul.replace')}</li>
      </ul>
      <Field label={t('annul.reason')} required>
        <Textarea rows={2} maxLength={500} value={dialog.reason} onChange={(event) => set({ reason: event.target.value })} />
      </Field>
      {/* The DS ConfirmPhraseField (B-W2b-18): the DDT's number as written, its state in the person's language. */}
      <ConfirmPhraseField phrase={number} value={dialog.typed} onChange={(typed) => set({ typed })} />
    </Frame>
  )
}
