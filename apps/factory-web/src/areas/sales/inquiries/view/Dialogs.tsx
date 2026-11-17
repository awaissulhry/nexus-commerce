'use client'

import { useEffect, type ReactNode } from 'react'
import { FilePlus2, PackagePlus, Shirt, XCircle } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, FileRow, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import type { Assignees, InquiryFile, InquiryLine, ScaleOption } from '../api'
// B-TH-228: Make order, Make style draft.
import type { OrderDraft, StyleDraftDraft } from '../model'
import { DECLINE_REASONS, declineHeld, lostHeld, type DeclineDraft, type DeclineReason, type Loaded, type Notice, type Phrase, type QuotePreview } from '../model'
import type { MessageReach } from '../model' // B-TH-234
// th-backend-g step 2: the decline's message starts from the mail template (the reason where "…" stands); the five languages' names.
import { hasBlank, type DeclineStart } from '../model'
import { MESSAGE_LANGUAGES } from '@nexus/factory-domain/templates/message-languages'
import { NoticeLine, useWords } from '../parts'
import { ListboxPanel } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/** ⌘↵ / Ctrl+↵ inside a dialog: its primary action (the design's kb). */
function useSubmitKey(onSubmit: () => void, held: boolean) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !held) {
        event.preventDefault()
        onSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSubmit, held])
}

function Buttons({ onClose, children }: { onClose?: () => void; children: ReactNode }) {
  const { t } = useWords()
  return (
    <span className="fw-inq-buttons">
      <Button variant="secondary" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      {children}
    </span>
  )
}

// ---- Assign ----------------------------------------------------------------------------------------------------------------

export interface AssignModel {
  /** "INQ-2026-0001", or how many a selection holds. */
  readonly subject: Phrase
  /** Who has it now (one inquiry): its name inside the record; null with nobody or a selection. */
  readonly current: { readonly id: string; readonly name: string } | null
  readonly people: Loaded<Assignees>
  readonly busy: boolean
  readonly notice: Notice | null
  readonly offline: boolean
}

export interface AssignActions {
  onAssign?: (assigneeId: string | null) => void
  onRetry?: () => void
  onClose?: () => void
}

const NOBODY = '__nobody__'

/**
 * Assign (design pop:inquiries.assign, a ListboxPanel; row verb, bulk): the people who keep inquiries here, by name — me
 * first as "Me" — and "Nobody" to take it off. ↑ ↓ and Enter choose. Nobody is counted (no per-person figure in a list:
 * the brief's rule and B-W2b-295's decision), so the design's "open inquiries count" is left out.
 */
export function AssignDialog({ model, actions }: { model: AssignModel; actions?: AssignActions }) {
  const { t, say } = useWords()
  const people = model.people.status === 'ready' ? model.people.value.people : []
  const options = [
    ...[...people].sort((a, b) => Number(b.me) - Number(a.me)).map((person) => ({ value: person.id, label: person.me ? t('assign.me', { name: person.name }) : person.name, disabled: person.id === model.current?.id })),
    ...(model.current ? [{ value: NOBODY, label: t('assign.nobody') }] : []),
  ]
  const held = model.busy ? t('common.working') : model.offline ? t('held.offline') : null
  return (
    <Modal open onClose={() => actions?.onClose?.()} size="sm" title={t('assign.title')} subtitle={say(model.subject) ?? undefined} footer={<Buttons onClose={actions?.onClose}>{null}</Buttons>}>
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <p className="fw-inq-hint">{model.current ? t('assign.now', { name: model.current.name }) : t('assign.nobodyNow')}</p>
        {model.people.status === 'loading' && <Skeleton height={120} />}
        {model.people.status === 'error' && (
          <Banner
            tone="danger"
            title={t(model.people.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        )}
        {model.people.status === 'ready' && people.length === 0 && <p className="fw-inq-hint">{t('assign.noPeople')}</p>}
        {model.people.status === 'ready' && people.length > 0 && (
          <div className="fw-inq-people">
            <ListboxPanel
              options={options}
              onCommit={(value) => {
                if (held) return
                actions?.onAssign?.(value === NOBODY ? null : value)
              }}
              onCancel={() => actions?.onClose?.()}
              ariaLabel={t('assign.listLabel')}
              searchPlaceholder={t('assign.search')}
              style={{ position: 'relative', width: '100%' }}
            />
          </div>
        )}
        {held && <p className="fw-inq-hint">{held}</p>}
        {model.people.status === 'ready' && !model.people.value.complete && <p className="fw-inq-hint">{t('assign.partial')}</p>}
        <p className="fw-inq-hint">{t('assign.hint')}</p>
      </div>
    </Modal>
  )
}

// ---- Decline ---------------------------------------------------------------------------------------------------------------

export interface DeclineModel {
  readonly subject: Phrase
  readonly draft: DeclineDraft
  /** Who the optional message reaches, or why it is held (a selection, a prospect, no e-mail, no right). B-TH-234: how (portal or mail) and in which language. */
  readonly message: Pick<MessageReach, 'to' | 'held'> & Partial<Pick<MessageReach, 'via' | 'language'>>
  /** th-backend-g step 2: the message started from the mail template request.declined (null: not read, or typed by the person). */
  readonly start?: DeclineStart | null
  readonly busy: boolean
  readonly notice: Notice | null
  readonly offline: boolean
}

export interface DeclineActions {
  onDraft?: (patch: Partial<DeclineDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * Decline inquiry (design pop:inquiries.decline; row verb D, the detail, Decline N): the reason (capacity, lead time, not our
 * product, price, other — Other says it in words) and an optional message to the customer, previewed, sent through the
 * inquiry's thread after the decline (the decline itself sends nothing; B-W2b-295). ⌘↵ declines.
 */
export function DeclineDialog({ model, actions }: { model: DeclineModel; actions?: DeclineActions }) {
  const { t, say, locale } = useWords()
  const heldPhrase = model.busy ? { key: 'common.working' } : declineHeld(model.draft, model.offline)
  const held = say(heldPhrase)
  const submit = () => actions?.onSubmit?.()
  useSubmitKey(submit, !!heldPhrase)
  const reasons: DeclineReason[] = [...DECLINE_REASONS]
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t('decline.title')}
      subtitle={say(model.subject) ?? undefined}
      footer={
        <Buttons onClose={actions?.onClose}>
          <Button variant="danger" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter">
            <XCircle size={14} aria-hidden /> {t('decline.go')}
          </Button>
        </Buttons>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <fieldset className="fw-inq-stack" aria-label={t('decline.reason')}>
          <legend className="fw-inq-h3">{t('decline.reason')}</legend>
          <div className="fw-inq-form-grid">
            {reasons.map((reason) => (
              <RadioCard key={reason} name="decline-reason" value={reason} checked={model.draft.reason === reason} selected={model.draft.reason === reason} onChange={() => actions?.onDraft?.({ reason })} title={t(`decline.${reason}`)} description={t(`decline.hint.${reason}`)} />
            ))}
          </div>
        </fieldset>
        <Field label={t('decline.note')} hint={model.draft.reason === 'OTHER' ? t('decline.noteOther') : t('decline.noteHint')}>
          <Textarea value={model.draft.note} rows={3} honourRows maxLength={2000} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
        </Field>
        {/* B-TH-234 (B-TH-043): ONE message in the decline's own command, only when "Send to the customer" is ticked (off); "Not an
            order" sends nothing; a selection never sends (one customer at a time); the confirm names who reads it, and how. */}
        {(() => {
          const notAnOrder = model.draft.reason === 'NOT_AN_ORDER'
          const held = notAnOrder ? { key: 'decline.message.notAnOrder' } : model.message.held
          const portal = model.message.via === 'PORTAL'
          const reader = portal ? t('decline.messagePortal') : t('decline.messageTo', { to: model.message.to ?? '' })
          return (
            <>
              <Checkbox checked={!!model.draft.send && !held} disabled={!!held} onChange={(event) => actions?.onDraft?.({ send: event.target.checked })} label={t('decline.send')} />
              <p className="fw-inq-hint">{held ? say(held) : reader}</p>
              {model.draft.send && !held && (
                <Field label={t('decline.messageLabel')} hint={model.message.language ? t('decline.messageLanguage', { language: (MESSAGE_LANGUAGES as readonly string[]).includes(model.message.language) ? t(`decline.language.${model.message.language}`) : model.message.language.toUpperCase() }) : reader}>
                  <Textarea value={model.draft.message} rows={4} honourRows maxLength={4000} onChange={(event) => actions?.onDraft?.({ message: event.target.value })} />
                </Field>
              )}
              {/* th-backend-g step 2 (B-TH-279): the message starts from the company's e-mail template; the reason goes where "…" stands. */}
              {model.draft.send && !held && hasBlank(model.draft.message) && <p className="fw-inq-hint">{t('decline.blankHint')}</p>}
              {model.draft.send && !held && model.start?.fellBack && (
                <p className="fw-inq-hint">{model.start.fellBack[locale === 'it' ? 'it' : 'en']}</p>
              )}
              {model.draft.send && !held && model.draft.message.trim() && (
                <Banner tone="info" title={portal ? t('decline.previewPortal') : t('decline.preview', { to: model.message.to ?? '' })}>
                  <p className="fw-inq-text">{model.draft.message.trim()}</p>
                </Banner>
              )}
              <p className="fw-inq-hint">{model.draft.send && !held ? t('decline.finalSend') : t('decline.final')}</p>
            </>
          )
        })()}
      </div>
    </Modal>
  )
}

// ---- Lost ------------------------------------------------------------------------------------------------------------------

export interface LostModel {
  readonly subject: Phrase
  readonly note: string
  readonly busy: boolean
  readonly notice: Notice | null
  readonly offline: boolean
}

export interface LostActions {
  onNote?: (note: string) => void
  onSubmit?: () => void
  onClose?: () => void
}

/** Mark as lost: the customer went away before a quote — why, in words. ⌘↵ marks it. */
export function LostDialog({ model, actions }: { model: LostModel; actions?: LostActions }) {
  const { t, say } = useWords()
  const heldPhrase = model.busy ? { key: 'common.working' } : lostHeld(model.note, model.offline)
  const submit = () => actions?.onSubmit?.()
  useSubmitKey(submit, !!heldPhrase)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t('lost.title')}
      subtitle={say(model.subject) ?? undefined}
      footer={
        <Buttons onClose={actions?.onClose}>
          <Button variant="danger" heldReason={say(heldPhrase)} onClick={submit} aria-keyshortcuts="Meta+Enter">
            {t('lost.go')}
          </Button>
        </Buttons>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <Field label={t('lost.note')} hint={t('lost.noteHint')}>
          <Textarea value={model.note} rows={3} honourRows maxLength={2000} onChange={(event) => actions?.onNote?.(event.target.value)} />
        </Field>
        <p className="fw-inq-hint">{t('decline.final')}</p>
      </div>
    </Modal>
  )
}

// ---- Make quote ------------------------------------------------------------------------------------------------------------

export interface QuoteModel {
  readonly subject: Phrase
  /** The customer and contact the quote is made for. */
  readonly customer: string
  readonly contact: string | null
  readonly wantedDate: string | null
  readonly preview: QuotePreview
  readonly customerRef: string
  /** Why Make quote is held (a prospect, closed, no right, offline), else null. */
  readonly held: Phrase | null
  readonly busy: boolean
  readonly notice: Notice | null
}

export interface QuoteActions {
  onRef?: (customerRef: string) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * Make quote (Q; design "Make quote (pre-filled: customer, contact, styles, sizes, target date)"): what goes over — the
 * customer, the contact, each style line with its sizes (at the customer's list price, else 0), the wanted day as the
 * promise date — and what is left out and why (factory-domain quotableLines, the API's own rule). ONE command makes the
 * quote and closes the inquiry as Quoted. ⌘↵ makes it.
 */
export function QuoteDialog({ model, actions }: { model: QuoteModel; actions?: QuoteActions }) {
  const { t, say, day } = useWords()
  const held = model.busy ? t('common.working') : say(model.held)
  const submit = () => actions?.onSubmit?.()
  useSubmitKey(submit, !!held)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="lg"
      title={t('quote.title')}
      subtitle={say(model.subject) ?? undefined}
      footer={
        <Buttons onClose={actions?.onClose}>
          <Button variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter">
            <FilePlus2 size={14} aria-hidden /> {t('quote.go')}
          </Button>
        </Buttons>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <div className="fw-inq-form-grid">
          <Field label={t('quote.customer')}>
            <span className="fw-inq-value">{model.customer}</span>
          </Field>
          <Field label={t('quote.contact')}>
            <span className="fw-inq-value">{model.contact ?? '—'}</span>
          </Field>
          <Field label={t('quote.promise')} hint={t('quote.promiseHint')}>
            <span className="fw-inq-value">{day(model.wantedDate)}</span>
          </Field>
          <Field label={t('quote.customerRef')} hint={t('quote.customerRefHint')}>
            <Input size="sm" value={model.customerRef} maxLength={100} onChange={(event) => actions?.onRef?.(event.target.value)} />
          </Field>
        </div>
        <h3 className="fw-inq-h3">{t('quote.copied', { count: model.preview.copied.length })}</h3>
        {model.preview.copied.length > 0 ? (
          <SummaryTable
            label={t('quote.copiedLabel')}
            columns={[t('line.col.n'), t('quote.col.style'), t('line.col.pieces')]}
            rows={model.preview.copied.map((line) => ({ id: String(line.seq), cells: [String(line.seq / 10), line.label, <span key="n" className="fw-inq-num">{line.pieces}</span>] }))}
          />
        ) : (
          <p className="fw-inq-hint">{t('quote.emptyDraft')}</p>
        )}
        {model.preview.leftOut.length > 0 && (
          <Banner tone="warning" title={t('quote.leftOut', { count: model.preview.leftOut.length })}>
            <ul className="fw-inq-lines">
              {model.preview.leftOut.map((line) => (
                <li key={line.seq}>{say(line.phrase)}</li>
              ))}
            </ul>
          </Banner>
        )}
        <p className="fw-inq-hint">{t('quote.closes')}</p>
      </div>
    </Modal>
  )
}

// ---- B-TH-228: Make order ------------------------------------------------------------------------------------------------------

export interface OrderModel {
  readonly subject: Phrase
  readonly customer: string
  readonly contact: string | null
  /** The request's lines: each goes on the order (a line not ready holds the button, in the API's words). */
  readonly lines: readonly InquiryLine[]
  readonly draft: OrderDraft
  /** The price grain: prices typed per line; without it the customer's list price, said. */
  readonly prices: boolean
  readonly currency: string
  readonly files: readonly InquiryFile[]
  /** Why Make order waits (a line not ready: "make the style draft first"; no right; a price that is not one; offline), else null. */
  readonly held: Phrase | null
  readonly busy: boolean
  readonly notice: Notice | null
}

export interface OrderActions {
  onDraft?: (patch: Partial<OrderDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * Make order (pane-actions-F02; B-TH-025): the order made straight from the request — its lines with their pieces, a unit price per
 * line (blank = the customer's list price; the price the customer was shown is filled in; prices only with the price grain), the
 * promise date (the wanted date while it is ahead), their PO, and the request's files going with it. The order goes through the
 * normal checks and comes out Confirmed or Waiting for approval: the receipt says which (never "confirmed" while it waits). ⌘↵ makes it.
 */
export function OrderDialog({ model, actions }: { model: OrderModel; actions?: OrderActions }) {
  const { t, say } = useWords()
  const held = model.busy ? t('common.working') : say(model.held)
  const submit = () => actions?.onSubmit?.()
  useSubmitKey(submit, !!held)
  const pieces = (line: InquiryLine) => Object.values(line.sizes).reduce((sum, value) => sum + value, 0) || (line.quantity ?? 0)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="lg"
      title={t('order.title')}
      subtitle={say(model.subject) ?? undefined}
      footer={
        <Buttons onClose={actions?.onClose}>
          <Button variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter">
            <PackagePlus size={14} aria-hidden /> {t('order.go')}
          </Button>
        </Buttons>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <div className="fw-inq-form-grid">
          <Field label={t('order.customer')}>
            <span className="fw-inq-value">{model.customer}</span>
          </Field>
          <Field label={t('order.contact')}>
            <span className="fw-inq-value">{model.contact ?? '—'}</span>
          </Field>
          <Field label={t('order.promise')} hint={t('order.promiseHint')}>
            <DateField value={model.draft.promiseDate ?? ''} clearable onChange={(value) => actions?.onDraft?.({ promiseDate: value || null })} />
          </Field>
          {/* A refusal naming their PO (the customer's terms want one on every order) marks this field, in words. */}
          <Field label={t('order.customerRef')} hint={t('order.customerRefHint')} error={model.notice?.lines?.some((line) => line.key.endsWith('.customerRef')) ? t('order.poRequired') : undefined}>
            <Input size="sm" value={model.draft.customerRef} maxLength={100} onChange={(event) => actions?.onDraft?.({ customerRef: event.target.value })} />
          </Field>
        </div>
        <h3 className="fw-inq-h3">{t('order.lines', { count: model.lines.length })}</h3>
        <SummaryTable
          label={t('order.linesLabel')}
          columns={[t('order.col.n'), t('order.col.style'), t('order.col.pieces'), ...(model.prices ? [t('order.col.price')] : [])]}
          rows={model.lines.map((line) => ({
            id: String(line.seq),
            cells: [
              String(line.seq / 10),
              line.style ? `${line.style.code}${line.colourway ? ` · ${line.colourway.code}` : ''}` : (line.description ?? '—'),
              <span key="n" className="fw-inq-num">{pieces(line)}</span>,
              ...(model.prices
                ? [
                    <Input
                      key="p"
                      size="sm"
                      inputMode="decimal"
                      aria-label={`${t('order.col.price')} · ${t('order.col.n')} ${line.seq / 10}`}
                      placeholder={t('order.pricePlaceholder')}
                      value={model.draft.prices[line.seq] ?? ''}
                      onChange={(event) => actions?.onDraft?.({ prices: { ...model.draft.prices, [line.seq]: event.target.value } })}
                    />,
                  ]
                : []),
            ],
          }))}
        />
        <p className="fw-inq-hint">{model.prices ? `${t('order.priceHint')} (${model.currency})` : t('order.priceHidden')}</p>
        <h3 className="fw-inq-h3">{t('order.files', { count: model.files.length })}</h3>
        {model.files.length === 0 ? (
          <p className="fw-inq-hint">{t('order.noFiles')}</p>
        ) : (
          <>
            <Checkbox checked={model.draft.carryFiles} onChange={(event) => actions?.onDraft?.({ carryFiles: event.target.checked })} label={t('order.carry')} />
            <div className="fw-inq-files">
              {model.files.map((file) => (
                <FileRow key={file.id} name={file.originalName} size={file.sizeBytes} />
              ))}
            </div>
          </>
        )}
        <Banner tone="info" title={t('order.checks')} />
        <p className="fw-inq-hint">{t('order.closes')}</p>
      </div>
    </Modal>
  )
}

// ---- B-TH-228: Make style draft --------------------------------------------------------------------------------------------------

export const PRODUCT_TYPES = ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER'] as const

export interface StyleDraftModel {
  readonly subject: Phrase
  /** The request's own customer: the label on the garment (never another brand; the API takes it from the request). */
  readonly customer: string
  readonly draft: StyleDraftDraft
  readonly scales: Loaded<readonly ScaleOption[]>
  readonly files: readonly InquiryFile[]
  readonly held: Phrase | null
  readonly busy: boolean
  readonly notice: Notice | null
}

export interface StyleDraftActions {
  onDraft?: (patch: Partial<StyleDraftDraft>) => void
  onSubmit?: () => void
  onClose?: () => void
}

/**
 * Make style draft (pane-actions-F04; B-TH-026): a DRAFT style for the request's own customer's label (shown, not chosen: W12), its
 * code, name (the request's first line), product type, an optional size scale and season, and which of the request's photos and
 * files go with it. The request stays open and names the draft; a style needs a released version and a colourway before an order
 * takes it (said). The production manager may make one. ⌘↵ makes it.
 */
export function StyleDraftDialog({ model, actions }: { model: StyleDraftModel; actions?: StyleDraftActions }) {
  const { t, say } = useWords()
  const held = model.busy ? t('common.working') : say(model.held)
  const submit = () => actions?.onSubmit?.()
  useSubmitKey(submit, !!held)
  const picked = new Set(model.draft.fileIds)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="lg"
      title={t('styleDraft.title')}
      subtitle={say(model.subject) ?? undefined}
      footer={
        <Buttons onClose={actions?.onClose}>
          <Button variant="primary" heldReason={held} onClick={submit} aria-keyshortcuts="Meta+Enter">
            <Shirt size={14} aria-hidden /> {t('styleDraft.go')}
          </Button>
        </Buttons>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={model.notice} />
        <div className="fw-inq-form-grid">
          <Field label={t('styleDraft.code')} hint={t('styleDraft.codeHint')} required>
            <Input size="sm" value={model.draft.code} maxLength={24} autoCapitalize="characters" onChange={(event) => actions?.onDraft?.({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('styleDraft.name')} hint={t('styleDraft.nameHint')}>
            <Input size="sm" value={model.draft.name} maxLength={200} onChange={(event) => actions?.onDraft?.({ name: event.target.value })} />
          </Field>
          <Field label={t('styleDraft.type')} required>
            <Select size="sm" value={model.draft.productType} onChange={(event) => actions?.onDraft?.({ productType: event.target.value })}>
              <option value="">{t('styleDraft.typeChoose')}</option>
              {PRODUCT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`styleDraft.types.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('styleDraft.scale')} required hint={model.scales.status === 'error' ? t('styleDraft.scalesFailed') : model.scales.status === 'loading' ? t('styleDraft.scalesLoading') : t('styleDraft.scaleHint')}>
            <Select size="sm" value={model.draft.sizeScaleId} disabled={model.scales.status !== 'ready'} onChange={(event) => actions?.onDraft?.({ sizeScaleId: event.target.value })}>
              <option value="">{t('styleDraft.typeChoose')}</option>
              {model.scales.status === 'ready' &&
                model.scales.value.map((scale) => (
                  <option key={scale.id} value={scale.id}>
                    {scale.code} · {scale.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('styleDraft.season')} hint={t('styleDraft.seasonHint')}>
            <Input size="sm" value={model.draft.season} maxLength={20} onChange={(event) => actions?.onDraft?.({ season: event.target.value })} />
          </Field>
          <Field label={t('styleDraft.brand')}>
            <span className="fw-inq-value">{t('styleDraft.brandValue', { customer: model.customer })}</span>
          </Field>
        </div>
        <h3 className="fw-inq-h3">{t('styleDraft.files', { count: picked.size })}</h3>
        {model.files.length === 0 ? (
          <p className="fw-inq-hint">{t('styleDraft.noFiles')}</p>
        ) : (
          <div className="fw-inq-files">
            {model.files.map((file) => (
              <FileRow
                key={file.id}
                name={file.originalName}
                size={file.sizeBytes}
                actions={
                  <Checkbox
                    checked={picked.has(file.id)}
                    aria-label={file.originalName}
                    onChange={(event) => actions?.onDraft?.({ fileIds: event.target.checked ? [...model.draft.fileIds, file.id] : model.draft.fileIds.filter((id) => id !== file.id) })}
                  />
                }
              />
            ))}
          </div>
        )}
        <Banner tone="info" title={t('styleDraft.released')} />
        <p className="fw-inq-hint">{t('styleDraft.stays')}</p>
      </div>
    </Modal>
  )
}
