'use client'

import { Search } from 'lucide-react'
import { Banner, DateField, Field, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import type { PurchaseOrder } from '../../api'
import type { DetailsDraft, LineDraft, OrderRecordActions, OrderRecordModel } from '../../model'
import { useSay } from './DailyDialogs'

const dateLocale = (locale: string) => (locale === 'it' ? 'it-IT' : 'en-GB')

/**
 * The PO studio's dialogs: Send a new link (Cancel and the other changes after the send: DailyDialogs.tsx),
 * Add / change a line (a material, its colour, quantity and unit, need date, the price with the cost grain, the leather
 * specs), Remove lines, Edit details, Review the supplier's proposed changes with Accept / Refuse, and What the supplier
 * sees (the price-free copy of the link page). Each refusal is said inside its dialog, in this app's words.
 */
export function OrderDialogs({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const dialog = model.dialog
  if (!dialog || dialog.kind === 'send') return null
  switch (dialog.kind) {
    case 'newLink':
      return <NewLink order={order} model={model} actions={actions} message={dialog.message} />
    case 'line':
      return <LineDialog order={order} model={model} actions={actions} draft={dialog.draft} />
    case 'removeLines':
      return <RemoveLines order={order} model={model} actions={actions} lineIds={dialog.lineIds} />
    case 'details':
      return <Details order={order} model={model} actions={actions} draft={dialog.draft} />
    case 'review':
    case 'accept':
    case 'refuse':
      return <Review order={order} model={model} actions={actions} />
    case 'supplierView':
      return <SupplierCopy order={order} model={model} actions={actions} />
    default:
      // B-W2a-69's daily dialogs (DailyDialogs.tsx).
      return null
  }
}

function Footer({ model, actions, label, held, tone, onConfirm }: { model: OrderRecordModel; actions?: OrderRecordActions; label: string; held: string | null; tone?: 'danger'; onConfirm?: () => void }) {
  const t = useT('buying')
  return (
    <>
      <span className="grow" />
      <Button size="sm" onClick={() => actions?.onDialog?.(null)} heldReason={model.busy ? t('held.busy') : null}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" variant="primary" tone={tone} heldReason={model.busy ? t('held.busy') : held} onClick={onConfirm}>
        {model.busy && <Spinner size={12} />} {label}
      </Button>
    </>
  )
}

function Problem({ model }: { model: OrderRecordModel }) {
  const say = useSay('buying')
  return model.dialogProblem ? <Banner tone="danger" title={say(model.dialogProblem) ?? ''} /> : null
}

function NewLink({ order, model, actions, message }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; message: string }) {
  const t = useT('buying')
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('po.newLink.title', { supplier: order.supplier.name })} size="md" footer={<Footer model={model} actions={actions} label={t('po.newLink.send')} held={order.contact?.email ? null : t('po.check.NO_CONTACT_EMAIL')} onConfirm={() => actions?.onNewLink?.()} />}>
      <div className="fw-by-dialog">
        <p className="fw-by-hint">{t('po.newLink.body', { email: order.contact?.email ?? '—' })}</p>
        <Field label={t('po.newLink.message')} hint={t('po.newLink.messageHint')}>
          <Textarea rows={4} maxLength={2000} value={message} onChange={(event) => actions?.onDialog?.({ kind: 'newLink', message: event.target.value })} />
        </Field>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

/** A line's fields that problems hold back: material and colour chosen, a quantity above 0, a need date. */
export function lineHeld(draft: LineDraft, words: (key: string) => string): string | null {
  if (!draft.material) return words('po.lineForm.pickMaterial')
  if (draft.material.colours.some((colour) => colour.status === 'ACTIVE') && !draft.itemColourId) return words('po.lineForm.pickColour')
  if (!(Number(draft.quantity) > 0)) return words('po.lineForm.quantityNeeded')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.needDate)) return words('po.lineForm.needDateNeeded')
  return null
}

function LineDialog({ order, model, actions, draft }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; draft: LineDraft }) {
  const t = useT('buying')
  const locale = useLocale()
  const set = (patch: Partial<LineDraft>) => actions?.line?.onChange?.({ ...draft, ...patch })
  const material = draft.material
  const leather = material?.kind === 'LEATHER'
  const editing = draft.lineId !== null
  const units = material ? [...new Set([material.purchaseUom, material.baseUom, material.units.consumption.uom])] : []
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={editing ? t('po.lineForm.editTitle', { seq: order.lines.find((line) => line.id === draft.lineId)?.seq ?? '' }) : t('po.lineForm.addTitle')}
      subtitle={material ? `${material.code} · ${material.name}` : undefined}
      size="lg"
      footer={<Footer model={model} actions={actions} label={editing ? t('common.save') : t('po.lineForm.add')} held={lineHeld(draft, t)} onConfirm={() => actions?.line?.onSave?.()} />}
    >
      <div
        className="fw-by-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !lineHeld(draft, t) && !model.busy) {
            event.preventDefault()
            actions?.line?.onSave?.()
          }
        }}
      >
        {!editing && (
          <>
            <Field label={t('po.lineForm.material')} required hint={t('po.lineForm.materialHint')}>
              <Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} value={draft.materialQuery} onChange={(event) => actions?.line?.onMaterialQuery?.(event.target.value)} placeholder={t('po.lineForm.materialSearch')} autoFocus />
            </Field>
            {draft.materialProblem ? (
              <Banner tone="danger" title={t(draft.materialProblem)} />
            ) : draft.materials === null ? (
              <p className="fw-by-hint" role="status">
                <Spinner size={14} /> {t('common.loading')}
              </p>
            ) : draft.materials.length === 0 ? (
              <p className="fw-by-hint">{t('po.lineForm.noMaterial')}</p>
            ) : (
              <Select size="sm" aria-label={t('po.lineForm.material')} value={material?.id ?? ''} onChange={(event) => actions?.line?.onMaterial?.(event.target.value || null)}>
                <option value="">{t('po.lineForm.pickMaterial')}</option>
                {draft.materials.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.code} · {option.name}
                    {option.defaultSupplier && option.defaultSupplier.id !== order.partyId ? ` (${t('po.lineForm.otherSupplier', { supplier: option.defaultSupplier.name })})` : ''}
                  </option>
                ))}
              </Select>
            )}
          </>
        )}
        {material && (
          <>
            <div className="fw-by-fields">
              {material.colours.length > 0 && (
                <Field label={t('po.lineForm.colour')} required>
                  <Select size="sm" value={draft.itemColourId} onChange={(event) => set({ itemColourId: event.target.value })} disabled={editing}>
                    <option value="">{t('po.lineForm.pickColour')}</option>
                    {material.colours
                      .filter((colour) => colour.status === 'ACTIVE' || colour.id === draft.itemColourId)
                      .map((colour) => (
                        <option key={colour.id} value={colour.id}>
                          {colour.code} · {colour.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              )}
              <Field label={t('po.lineForm.quantity')} required>
                <Input size="sm" inputMode="decimal" value={draft.quantity} onChange={(event) => set({ quantity: event.target.value.replace(',', '.') })} />
              </Field>
              <Field label={t('po.lineForm.unit')} hint={t('po.lineForm.unitHint')}>
                <Select size="sm" value={draft.uom} onChange={(event) => set({ uom: event.target.value })}>
                  {units.map((unit) => (
                    <option key={unit} value={unit}>
                      {t(`uom.${unit}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('po.lineForm.needDate')} required>
                <DateField value={draft.needDate} onChange={(value) => set({ needDate: value })} locale={dateLocale(locale)} min={model.today} />
              </Field>
              {model.can.cost && (
                <Field label={t('po.lineForm.unitPrice', { currency: order.currency, unit: t(`uom.${draft.uom}`) })} hint={t('po.lineForm.unitPriceHint')}>
                  <Input size="sm" inputMode="decimal" value={draft.unitPrice} onChange={(event) => set({ unitPrice: event.target.value.replace(',', '.') })} />
                </Field>
              )}
              <Field label={t('po.lineForm.articleCode')}>
                <Input size="sm" value={draft.supplierArticleCode} maxLength={60} onChange={(event) => set({ supplierArticleCode: event.target.value })} />
              </Field>
              <Field label={t('po.lineForm.colourCode')}>
                <Input size="sm" value={draft.supplierColourCode} maxLength={60} onChange={(event) => set({ supplierColourCode: event.target.value })} />
              </Field>
            </div>
            {leather && (
              <fieldset className="fw-by-lot">
                <legend className="fw-by-h3">{t('po.lineForm.leather')}</legend>
                <div className="fw-by-fields">
                  <Field label={t('po.lineForm.grade')}>
                    <Input size="sm" value={draft.grade} maxLength={40} onChange={(event) => set({ grade: event.target.value })} />
                  </Field>
                  <Field label={t('po.lineForm.thicknessMin')}>
                    <Input size="sm" inputMode="decimal" value={draft.thicknessMinMm} onChange={(event) => set({ thicknessMinMm: event.target.value.replace(',', '.') })} />
                  </Field>
                  <Field label={t('po.lineForm.thicknessMax')}>
                    <Input size="sm" inputMode="decimal" value={draft.thicknessMaxMm} onChange={(event) => set({ thicknessMaxMm: event.target.value.replace(',', '.') })} />
                  </Field>
                  <Field label={t('po.lineForm.tolerance')} hint={t('po.lineForm.toleranceHint')}>
                    <Input size="sm" inputMode="decimal" value={draft.areaTolerancePct} onChange={(event) => set({ areaTolerancePct: event.target.value.replace(',', '.') })} />
                  </Field>
                </div>
                <Checkbox checked={draft.oneDyeBatch} onChange={(event) => set({ oneDyeBatch: event.target.checked })} label={t('po.lineForm.oneDyeBatch')} />
                {material.requiresCrViTest && <p className="fw-by-hint">{t('po.lineForm.crVi')}</p>}
              </fieldset>
            )}
            <Field label={t('po.lineForm.note')} hint={t('po.lineForm.noteHint')}>
              <Textarea rows={2} maxLength={500} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
            </Field>
          </>
        )}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function RemoveLines({ order, model, actions, lineIds }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; lineIds: string[] }) {
  const t = useT('buying')
  const lines = order.lines.filter((line) => lineIds.includes(line.id))
  const planned = lines.filter((line) => line.plan.length > 0).length
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('po.remove.title', { count: lines.length })} size="sm" footer={<Footer model={model} actions={actions} label={t('po.remove.confirm', { count: lines.length })} tone="danger" held={lines.length === 0 ? t('po.remove.none') : null} onConfirm={() => actions?.onRemoveLines?.()} />}>
      <div className="fw-by-dialog">
        <ul className="fw-by-list">
          {lines.map((line) => (
            <li key={line.id}>
              {line.seq} · {line.item.code} {line.item.name}
              {line.colour ? ` · ${line.colour.name}` : ''}
            </li>
          ))}
        </ul>
        {planned > 0 && <p className="fw-by-hint">{t('po.remove.plan', { count: planned })}</p>}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function Details({ order, model, actions, draft }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions; draft: DetailsDraft }) {
  const t = useT('buying')
  const locale = useLocale()
  const set = (patch: Partial<DetailsDraft>) => actions?.onDetails?.({ ...draft, ...patch })
  const draftOrder = order.status === 'DRAFT'
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('po.details.edit')} size="lg" footer={<Footer model={model} actions={actions} label={t('common.save')} held={null} onConfirm={() => actions?.onSaveDetails?.()} />}>
      <div className="fw-by-dialog">
        <div className="fw-by-fields">
          <Field label={t('po.details.requested')} hint={t('po.new.requestedHint')}>
            <DateField value={draft.requestedDate} onChange={(value) => set({ requestedDate: value })} locale={dateLocale(locale)} min={model.today} clearable clearLabel={t('common.clear')} disabled={!draftOrder} />
          </Field>
          <Field label={t('po.details.incoterms')}>
            <Input size="sm" value={draft.incoterms} maxLength={60} onChange={(event) => set({ incoterms: event.target.value })} readOnly={!draftOrder} />
          </Field>
          <Field label={t('po.details.paymentTerms')}>
            <Input size="sm" value={draft.paymentTerms} maxLength={200} onChange={(event) => set({ paymentTerms: event.target.value })} readOnly={!draftOrder} />
          </Field>
        </div>
        <Field label={t('po.details.note')} hint={t('po.details.noteHint')}>
          <Textarea rows={3} maxLength={1000} value={draft.note} onChange={(event) => set({ note: event.target.value })} readOnly={!draftOrder} />
        </Field>
        <Field label={t('po.details.internalNote')} hint={t('po.details.internalHint')}>
          <Textarea rows={3} maxLength={1000} value={draft.internalNote} onChange={(event) => set({ internalNote: event.target.value })} />
        </Field>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function Review({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('buying')
  const td = useT('purchasing-orders')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const dialog = model.dialog!
  const answer = model.answer.value
  const changed = answer?.lines.filter((line) => line.proposed) ?? []
  const held = model.can.poSend ? null : t('held.noSend')
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('po.review.title', { supplier: order.supplier.name })}
      size="xl"
      footer={
        dialog.kind === 'review' ? (
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
              {t('common.close')}
            </Button>
            <Button size="sm" heldReason={held} onClick={() => actions?.onDialog?.({ kind: 'refuse', note: '' })}>
              {t('po.answer.refuse')}
            </Button>
            {/* B-W2a-69: counter-propose = the next revision's draft from what was asked, to change and send. */}
            <Button size="sm" heldReason={held} onClick={() => actions?.onDialog?.({ kind: 'counter', note: '' })}>
              {td('counter.open')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDialog?.({ kind: 'accept', message: '' })}>
              {t('po.review.accept', { count: changed.length })}
            </Button>
          </>
        ) : dialog.kind === 'accept' ? (
          <Footer model={model} actions={actions} label={t('po.review.acceptConfirm')} held={held} onConfirm={() => actions?.onAccept?.()} />
        ) : (
          <Footer model={model} actions={actions} label={t('po.review.refuseConfirm')} tone="danger" held={held} onConfirm={() => actions?.onRefuse?.()} />
        )
      }
    >
      <div className="fw-by-dialog">
        {!answer ? (
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : (
          <>
            <p className="fw-by-hint">{t('po.review.body')}</p>
            <SummaryTable
              label={t('po.review.title', { supplier: order.supplier.name })}
              density="compact"
              stackOnPhone
              columns={[t('po.col.seq'), t('po.col.material'), t('po.answer.asked'), t('po.answer.proposedCol'), t('po.answer.what')]}
              align={['right', 'left', 'left', 'left', 'left']}
              rows={answer.lines.map((line) => ({
                id: line.id,
                cells: [
                  String(line.seq),
                  `${line.item.code} ${line.item.name}${line.colour ? ` · ${line.colour}` : ''}`,
                  `${quantity(line.asked.quantity, locale)} ${t(`uom.${line.asked.uom}`)} · ${formatDate(dayAt(line.asked.needDate), place)}`,
                  line.proposed
                    ? line.proposed.kind === 'SPLIT'
                      ? line.proposed.deliveries.map((delivery) => `${quantity(delivery.quantity, locale)} · ${delivery.date ? formatDate(dayAt(delivery.date), place) : '—'}`).join(' + ')
                      : line.proposed.kind === 'CANNOT_DELIVER'
                        ? t('po.answer.change.CANNOT_DELIVER')
                        : `${quantity(line.proposed.quantity, locale)} ${t(`uom.${line.asked.uom}`)} · ${line.proposed.date ? formatDate(dayAt(line.proposed.date), place) : '—'}`
                    : t('po.answer.asAsked'),
                  <span key="what" className="fw-by-cell">
                    <span>{line.proposed && line.proposed.changes.length > 0 ? line.proposed.changes.map((change) => t(`po.answer.change.${change}`)).join(' · ') : t('po.answer.asAsked')}</span>
                    {line.proposed?.reason && <span className="fw-by-cell-sub">{t('po.answer.reason', { reason: line.proposed.reason })}</span>}
                  </span>,
                ],
              }))}
            />
            <ul className="fw-by-list">
              <li>{t('po.review.acceptMeans')}</li>
              <li>{t('po.review.refuseMeans')}</li>
              <li>{td('counter.means', { revision: order.revision + 1 })}</li>
              <li>{t('po.review.planMeans')}</li>
            </ul>
          </>
        )}
        {dialog.kind === 'accept' && (
          <Field label={t('po.review.message')} hint={t('po.review.messageHint')}>
            <Textarea rows={3} maxLength={2000} value={dialog.message} onChange={(event) => actions?.onDialog?.({ kind: 'accept', message: event.target.value })} autoFocus />
          </Field>
        )}
        {dialog.kind === 'refuse' && (
          <Field label={t('po.review.note')} hint={t('po.review.noteHint')}>
            <Textarea rows={3} maxLength={1000} value={dialog.note} onChange={(event) => actions?.onDialog?.({ kind: 'refuse', note: event.target.value })} autoFocus />
          </Field>
        )}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function SupplierCopy({ order, model, actions }: { order: PurchaseOrder; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const dialog = model.dialog as Extract<NonNullable<OrderRecordModel['dialog']>, { kind: 'supplierView' }>
  const view = dialog.view
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('po.supplierView.title', { supplier: order.supplier.name })} subtitle={t('po.supplierView.subtitle')} size="xl" footer={<Button size="sm" variant="primary" onClick={() => actions?.onDialog?.(null)}>{t('common.close')}</Button>}>
      {view.status === 'loading' ? (
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : view.status !== 'ready' ? (
        <Banner tone="danger" title={t(view.status === 'error' ? view.problem : 'problem.gone')} />
      ) : (
        <div className="fw-by-dialog">
          <Banner tone="info" title={t('po.supplierView.noPrice')} />
          <SummaryTable
            label={t('po.supplierView.title', { supplier: order.supplier.name })}
            density="compact"
            stackOnPhone
            columns={[t('po.col.seq'), t('po.supplierView.article'), t('po.col.quantity'), t('po.col.specs'), t('po.col.need')]}
            align={['right', 'left', 'right', 'left', 'left']}
            rows={view.value.lines.map((line) => ({
              id: line.id,
              cells: [
                String(line.seq),
                `${line.code ?? '—'} ${line.name ?? ''}${line.colour?.name ? ` · ${line.colour.name}` : ''}${line.colour?.supplierCode ? ` (${line.colour.supplierCode})` : ''}`,
                `${quantity(line.quantity, locale)} ${t(`uom.${line.uom}`)}${line.estimatedHides !== null && line.uom !== 'HIDE' ? ` · ${t('plan.hides', { count: line.estimatedHides })}` : ''}`,
                [line.grade ? t('po.spec.grade', { grade: line.grade }) : null, line.thicknessMinMm ? t('po.spec.thickness', { mm: line.thicknessMinMm }) : null, line.oneDyeBatch ? t('po.spec.oneDyeBatch') : null, line.areaTolerancePct ? t('po.spec.tolerance', { pct: line.areaTolerancePct }) : null, line.requiresCrViTest ? t('po.spec.crVi') : null].filter(Boolean).join(' · ') || '—',
                formatDate(dayAt(line.needDate), place),
              ],
            }))}
          />
          <p className="fw-by-hint">{t('po.supplierView.canDo')}</p>
        </div>
      )}
    </Modal>
  )
}
