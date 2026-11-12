'use client'

import Link from 'next/link'
import { CheckCircle2, FilePlus2, Send } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { Combobox, DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import { ASK_NAMESPACE, materialOf, say, sendHeld, withMaterial, type AskActions, type AskModel } from '../model'
import '../../../../_shared/buying/buying.css'

/**
 * Ask to buy (B-W2b-332; design purchasing.requests pop:ask "Material, quantity, date, reason, work order — Send request";
 * Esc closes and returns the focus to the opener). Two modes:
 *
 *   OFFICE     the band's "Ask to buy": the site (when the person asks for more than one), the material (a combobox over the
 *              materials we buy) and its colour, how much in one of its units, words of one's own, by when, why, the work
 *              order it is for (optional), words for the approver. SCR-356.
 *   SHORTAGE   a line of "Short on open work orders": the work order, the material, what is short and by when are the
 *              list's (read again by the server), the person says why; a buyer picks "Draft a purchase order now" or "Send
 *              to the buyers" (RadioCard). SCR-357.
 *
 * After the send: what happened in words (it waits for the buyer, or for a yes first; or drafted into PO-…, with a link),
 * "Ask for something else" (OFFICE). "Send request" is held with the reason while something is missing. No money.
 */
export function AskDialog({ model, actions }: { model: AskModel; actions?: AskActions }) {
  return (
    <WithMessages namespaces={[ASK_NAMESPACE]}>
      <Ask model={model} actions={actions} />
    </WithMessages>
  )
}

function Ask({ model, actions }: { model: AskModel; actions?: AskActions }) {
  const t = useT(ASK_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const { draft, shortage } = model
  const options = model.options.status === 'ready' ? model.options.value : null
  const material = materialOf(options, draft.itemId)
  const held = sendHeld(model)
  const set = (change: Partial<typeof draft>) => actions?.onDraft?.({ ...draft, ...change })
  const close = () => actions?.onClose?.()
  const title = draft.mode === 'SHORTAGE' ? t('title.shortage') : t('title.office')

  if (model.done) {
    const done = model.done
    const request = done.request
    return (
      <Modal
        open
        onClose={close}
        title={title}
        size="md"
        footer={
          <>
            {draft.mode === 'OFFICE' && (
              <Button onClick={() => actions?.onAnother?.()}>
                <Send size={14} aria-hidden /> {t('done.another')}
              </Button>
            )}
            <span className="grow" />
            <Button variant="primary" onClick={close}>
              {t('common.close')}
            </Button>
          </>
        }
      >
        <div className="fw-by-dialog" role="status">
          <Banner tone={done.kind === 'waiting' ? 'warning' : 'success'} title={t(`done.${done.kind}.title`)}>
            {done.kind === 'drafted' ? (
              <>
                {t(done.order.created ? 'done.drafted.new' : 'done.drafted.added', { number: done.order.number })}{' '}
                <Link className="fw-by-link" href={`${model.prefix}/purchasing/orders/${encodeURIComponent(done.order.id)}`}>
                  {t('done.drafted.open', { number: done.order.number })}
                </Link>
              </>
            ) : (
              t(`done.${done.kind}.body`)
            )}
          </Banner>
          <KeyValue
            items={[
              { label: t('field.material'), value: `${request.item?.code ?? ''} ${request.item?.name ?? ''}${request.colour ? ` · ${request.colour.name}` : ''}` },
              { label: t('field.quantity'), value: `${quantity(request.quantity, locale, 4)} ${t(`uom.${request.uom}`)}` },
              { label: t('field.needDate'), value: formatDate(dayAt(request.needDate), place) },
              ...(request.workOrder ? [{ label: t('field.workOrder'), value: request.workOrder.number }] : []),
            ]}
          />
          {model.can.view && done.kind !== 'drafted' && (
            <p className="fw-by-hint">
              <CheckCircle2 size={13} aria-hidden /> {t('done.inQueue')}
            </p>
          )}
        </div>
      </Modal>
    )
  }

  const sendLabel = draft.mode === 'SHORTAGE' && draft.then === 'DRAFT' ? t('action.draft') : t('action.send')
  return (
    <Modal
      open
      onClose={close}
      title={title}
      size="lg"
      footer={
        <>
          <span className="fw-by-hint">{t('foot')}</span>
          <span className="grow" />
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? say(t, held) : null} onClick={() => actions?.onSend?.()}>
            {model.busy ? <Spinner size={12} /> : draft.mode === 'SHORTAGE' && draft.then === 'DRAFT' ? <FilePlus2 size={14} aria-hidden /> : <Send size={14} aria-hidden />} {sendLabel}
          </Button>
        </>
      }
    >
      <form
        className="fw-by-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) actions?.onSend?.()
        }}
      >
        {model.options.status === 'loading' && (
          <p className="fw-by-hint" role="status">
            <Spinner size={12} /> {t('common.reading')}
          </p>
        )}
        {model.options.status === 'error' && (
          <Banner
            tone="danger"
            title={t('options.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(model.options.problem)}
          </Banner>
        )}
        {!model.can.ask && <Banner tone="info" title={t('held.noAsk')} />}

        {shortage ? (
          <>
            <KeyValue
              items={[
                { label: t('field.workOrder'), value: shortage.workOrder.number },
                { label: t('field.material'), value: shortage.material.label },
                { label: t('shortage.short'), value: `${quantity(shortage.short, locale, 4)} ${t(`uom.${shortage.material.uom}`)}` },
                { label: t('shortage.neededBy'), value: formatDate(dayAt(shortage.neededBy), place) },
              ]}
            />
            <p className="fw-by-hint">{t(shortage.word === 'DELAYED' ? 'shortage.delayed' : 'shortage.notEnough')}</p>
            {model.can.draft && (
              <div className="fw-by-fields" role="radiogroup" aria-label={t('shortage.then')}>
                <RadioCard name="ask-then" checked={draft.then === 'DRAFT'} selected={draft.then === 'DRAFT'} onChange={() => set({ then: 'DRAFT' })} title={t('then.DRAFT.title')} description={t('then.DRAFT.body')} />
                <RadioCard name="ask-then" checked={draft.then === 'REQUEST'} selected={draft.then === 'REQUEST'} onChange={() => set({ then: 'REQUEST' })} title={t('then.REQUEST.title')} description={t('then.REQUEST.body')} />
              </div>
            )}
          </>
        ) : (
          <>
            {options && options.sites.length > 1 && (
              <Field label={t('field.site')} required>
                <Select value={draft.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
                  {options.sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.code} · {site.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="fw-by-fields">
              <Field label={t('field.material')} required hint={options?.more ? t('field.materialMore') : t('field.materialHint')}>
                {options ? (
                  <Combobox
                    options={options.materials.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` }))}
                    value={draft.itemId ?? ''}
                    placeholder={t('field.materialPlaceholder')}
                    onChange={(value) => actions?.onDraft?.(withMaterial(draft, materialOf(options, value || null)))}
                  />
                ) : (
                  <span className="fw-by-hint">—</span>
                )}
              </Field>
              {material && material.colours.length > 0 && (
                <Field label={t('field.colour')} required={material.colours.length > 1}>
                  <Select value={draft.itemColourId ?? ''} onChange={(event) => set({ itemColourId: event.target.value || null })}>
                    <option value="">{t('field.colourPick')}</option>
                    {material.colours.map((colour) => (
                      <option key={colour.id} value={colour.id}>
                        {colour.code} · {colour.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <div className="fw-by-fields">
              <Field label={t('field.quantity')} required>
                <Input inputMode="decimal" value={draft.quantity} placeholder="0" onChange={(event) => set({ quantity: event.target.value })} />
              </Field>
              <Field label={t('field.unit')} required>
                <Select value={draft.uom ?? ''} onChange={(event) => set({ uom: (event.target.value || null) as typeof draft.uom })} disabled={!material}>
                  {!material && <option value="">{t('field.unitFirst')}</option>}
                  {(material?.units ?? []).map((unit) => (
                    <option key={unit} value={unit}>
                      {t(`uom.${unit}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('field.needDate')} required hint={t('field.needDateHint')}>
                <DateField value={draft.needDate} min={options?.today} onChange={(value) => set({ needDate: value })} />
              </Field>
            </div>
            <Field label={t('field.description')} hint={t('field.descriptionHint')}>
              <Input value={draft.description} maxLength={2000} onChange={(event) => set({ description: event.target.value })} />
            </Field>
            <Field label={t('field.workOrder')} hint={t('field.workOrderHint')}>
              <Select value={draft.workOrderId ?? ''} onChange={(event) => set({ workOrderId: event.target.value || null })}>
                <option value="">{t('field.noWorkOrder')}</option>
                {(options?.workOrders ?? []).map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.number}
                    {order.style ? ` · ${order.style}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}

        <Field label={t('field.reason')} required hint={t('field.reasonHint')}>
          <Textarea rows={3} maxLength={2000} value={draft.reason} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
        {!(draft.mode === 'SHORTAGE' && draft.then === 'DRAFT') && (
          <Field label={t('field.note')} hint={t('field.noteHint')}>
            <Textarea rows={2} maxLength={4000} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        )}
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
      </form>
    </Modal>
  )
}
