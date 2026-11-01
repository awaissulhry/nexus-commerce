'use client'

import { useRef, type ReactNode } from 'react'
import { CheckCircle2, Clock3, FileText, Link2Off, Paperclip, Send, ShieldAlert, XCircle } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../lib/i18n/ds-parts'
import type { DeclineReason, LineAnswerKind } from '@nexus/factory-domain/purchasing/confirm/answer'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { LinkOrder, LinkOrderLine } from '../api'
import {
  answeredKey,
  answerPreview,
  declineHeld,
  draftProblems,
  expectedSpan,
  firstProblemKey,
  nameAsked,
  plainQuantity,
  quantityShown,
  sendHeld,
  summaryParts,
  type AnswerPreview,
  type DraftProblems,
  type LineDraft,
  type PoConfirmViewModel,
} from '../model'
import '../po-confirm.css'

export type { PoConfirmViewModel } from '../model'

/** What the page asks its container to do (the design index draws it without). */
export interface PoConfirmActions {
  onField?: (field: 'supplierRef' | 'typedName' | 'note', value: string) => void
  onOpenLine?: (lineId: string) => void
  onResetLine?: (lineId: string) => void
  onResetAll?: () => void
  onSheetKind?: (kind: LineAnswerKind) => void
  onSheetDraft?: (draft: LineDraft) => void
  onSheetSave?: () => void
  onSheetClose?: () => void
  onSend?: () => void
  onDecline?: (open: boolean) => void
  onDeclineDraft?: (reason: DeclineReason, note: string) => void
  onDeclineSend?: () => void
  onPickFile?: (file: File) => void
  onRemoveFile?: () => void
  onRetry?: () => void
  onNewLink?: () => void
}

const KINDS: readonly LineAnswerKind[] = ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT_DELIVER']
const DECLINES: readonly DeclineReason[] = ['NO_CAPACITY', 'MATERIAL_NOT_AVAILABLE', 'OTHER']
const NS = 'po-confirm-link'

/**
 * SCR-100 — Confirm a PO (design links.po in the link frame links.frame; SCM-085, SCM-086, SCM-090; Owner answers P2 and
 * C2): a supplier's page from the order's e-mail. The frame (the sender, the language, the privacy notice) around ONE
 * task — the order WITHOUT any price (deliver to, sent on, the version; the PDF is in the mail), its lines in the
 * supplier's terms (their codes first, quantity and unit, needed on, leather specs), then the answer: "Confirm all as
 * asked" in one tap, or per line another date or quantity, two deliveries, or "cannot deliver", each with its reason
 * (the buyer accepts or refuses a change); their number, their name, a note and their own confirmation PDF; the review
 * line before sending ("3 lines as asked · 1 later date"); Decline with a reason. Clear end states: confirmed, sent to the
 * buyer to decide, declined, answered before, a link that expired or no longer opens (Ask for a new link).
 */
export function PoConfirmView({ model, actions }: { model: PoConfirmViewModel; actions?: PoConfirmActions }) {
  return (
    <WithMessages namespaces={[NS]}>
      <PoConfirm model={model} actions={actions} />
    </WithMessages>
  )
}

const companyOf = (page: LinkOrder) => page.from.tradeName ?? page.from.legalName

function PoConfirm({ model, actions }: { model: PoConfirmViewModel; actions?: PoConfirmActions }) {
  const t = useT(NS)
  const page = model.page
  const sender = page ? { name: companyOf(page) } : null
  const title = page ? t('title', { number: page.order.documentNumber }) : null
  if (model.link === 'loading') {
    return <LinkFrameView model={{ sender, title, body: { kind: 'link', state: 'loading', purpose: 'PO_CONFIRM', expiresAt: null, usesLeft: null }, timeZone: model.timeZone }} />
  }
  return (
    <LinkFrameView model={{ sender, title, body: { kind: 'task' }, timeZone: model.timeZone }}>
      {model.link === 'error' ? (
        <ReadFailed actions={actions} />
      ) : model.link !== 'valid' || !page ? (
        <DeadLink model={model} actions={actions} />
      ) : (
        <Body page={page} model={model} actions={actions} />
      )}
    </LinkFrameView>
  )
}

// ---- words shared by the parts ---------------------------------------------------------------------------------------------

function useWords(model: PoConfirmViewModel) {
  const t = useT(NS)
  const locale = useLocale()
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale, timeZone: model.timeZone })
  const unit = (uom: string) => t(`uom.${uom}`)
  const qty = (value: string, uom: string) => t('lines.asked', { quantity: quantityShown(value, locale), unit: unit(uom) })
  const buyer = model.page?.from.buyerName ?? t('who.buyer')
  const buyerStart = model.page?.from.buyerName ?? t('who.buyerStart')
  return { t, locale, day, unit, qty, buyer, buyerStart }
}

/** A typed quantity shown back in the page's form ("1.200,5"), or as typed when it is no number. */
const typedShown = (typed: string, locale: Locale) => {
  const plain = plainQuantity(typed, locale)
  return plain === null ? typed : quantityShown(plain, locale)
}

// ---- the page ------------------------------------------------------------------------------------------------------------------

function Body({ page, model, actions }: { page: LinkOrder; model: PoConfirmViewModel; actions?: PoConfirmActions }) {
  const { t, locale, buyer } = useWords(model)
  const preview = page.canAnswer && !model.done ? answerPreview(page, model.answers, model.today, locale) : null
  const editable = page.canAnswer && !model.done
  return (
    <>
      {model.done ? (
        <DoneCard page={page} model={model} />
      ) : !page.canAnswer ? (
        <Answered page={page} model={model} />
      ) : (
        <Banner tone="info" icon={<Clock3 size={18} aria-hidden />} title={t('answerBy.title', { date: formatDateTime(page.expiresAt, { locale, timeZone: model.timeZone }) })}>
          {page.from.buyerName ? t('answerBy.body', { buyer, company: companyOf(page) }) : t('answerBy.bodyNoBuyer', { company: companyOf(page) })}
        </Banner>
      )}
      <OrderCard page={page} model={model} />
      <LinesCard page={page} model={model} actions={actions} editable={editable} />
      {editable && <AnswerCard page={page} model={model} preview={preview} actions={actions} />}
      {editable && model.sheet && <LineSheet page={page} model={model} actions={actions} />}
      {editable && model.declineOpen && <DeclineDialog page={page} model={model} actions={actions} />}
    </>
  )
}

function OrderCard({ page, model }: { page: LinkOrder; model: PoConfirmViewModel }) {
  const { t, locale, day } = useWords(model)
  const order = page.order
  const deliver = page.deliverTo
  const items = [
    { label: t('order.from'), value: companyOf(page) },
    ...(page.from.buyerName ? [{ label: t('order.buyer'), value: page.from.buyerName }] : []),
    ...(deliver
      ? [
          {
            label: t('order.deliverTo'),
            value: (
              <span className="fw-poc-address">
                <strong>{deliver.name}</strong>
                <span>{[deliver.line1, deliver.line2].filter(Boolean).join(', ')}</span>
                <span>{[deliver.postalCode, deliver.city, deliver.province, deliver.country].filter(Boolean).join(' ')}</span>
              </span>
            ),
          },
        ]
      : []),
    ...(order.sentAt ? [{ label: t('order.sentOn'), value: formatDateTime(order.sentAt, { locale, timeZone: model.timeZone }) }] : []),
    { label: t('order.version'), value: String(order.revision) },
    { label: t('order.orderDate'), value: day(order.orderDate) },
    ...(order.requestedDate ? [{ label: t('order.wanted'), value: day(order.requestedDate) }] : []),
    ...(order.incoterms ? [{ label: t('order.incoterms'), value: order.incoterms }] : []),
    ...(order.paymentTerms ? [{ label: t('order.paymentTerms'), value: order.paymentTerms }] : []),
    ...(order.note ? [{ label: t('order.note'), value: order.note }] : []),
  ]
  return (
    <Card padded className="fw-poc-card" aria-labelledby="fw-poc-order">
      <h2 id="fw-poc-order" className="fw-poc-h2">
        {t('order.title')}
      </h2>
      <KeyValue labelCase="sentence" columns={2} items={items} />
      {/* The API's `document` sentence is English: the page says it in its own words. */}
      <p className="fw-poc-hint fw-poc-pdf">
        <FileText size={16} aria-hidden /> <span>{t('order.pdf')}</span>
      </p>
      <p className="fw-poc-hint">{t('order.noPrices')}</p>
    </Card>
  )
}

function leatherFacts(line: LinkOrderLine, t: ReturnType<typeof useT>, locale: Locale): string[] {
  const mm = (value: string) => quantityShown(value, locale)
  const facts: string[] = []
  if (line.grade) facts.push(t('lines.grade', { grade: line.grade }))
  if (line.thicknessMinMm && line.thicknessMaxMm) facts.push(t('lines.thickness', { min: mm(line.thicknessMinMm), max: mm(line.thicknessMaxMm) }))
  else if (line.thicknessMinMm) facts.push(t('lines.thicknessFrom', { min: mm(line.thicknessMinMm) }))
  else if (line.thicknessMaxMm) facts.push(t('lines.thicknessUpTo', { max: mm(line.thicknessMaxMm) }))
  if (line.oneDyeBatch) facts.push(t('lines.oneDyeBatch'))
  if (line.areaTolerancePct) facts.push(t('lines.tolerance', { pct: quantityShown(line.areaTolerancePct, locale) }))
  if (line.estimatedHides !== null) facts.push(t('lines.hides', { count: line.estimatedHides }))
  return facts
}

function LinesCard({ page, model, actions, editable }: { page: LinkOrder; model: PoConfirmViewModel; actions?: PoConfirmActions; editable: boolean }) {
  const { t, locale, day, qty } = useWords(model)
  const answered = editable || model.done !== null
  return (
    <Card padded className="fw-poc-card" aria-labelledby="fw-poc-lines">
      <h2 id="fw-poc-lines" className="fw-poc-h2">
        {t('lines.title', { count: page.lines.length })}
      </h2>
      <ol className="fw-poc-lines">
        {page.lines.map((line) => {
          const draft = model.answers[line.id]
          const facts = leatherFacts(line, t, locale)
          const code = line.code ?? line.name ?? ''
          return (
            <li key={line.id} className="fw-poc-line">
              <div className="fw-poc-line-what">
                <span className="fw-poc-seq">{t('lines.line', { seq: line.seq })}</span>
                <strong className="fw-poc-article">{[code, line.name && line.name !== code ? line.name : null].filter(Boolean).join(' · ')}</strong>
                {line.colour && (
                  <span className="fw-poc-sub">
                    {t('lines.colour', { colour: [line.colour.supplierCode, line.colour.name].filter(Boolean).join(' · ') })}
                  </span>
                )}
                {line.description && <span className="fw-poc-sub">{line.description}</span>}
                {facts.length > 0 && <span className="fw-poc-sub">{facts.join(' · ')}</span>}
                {line.requiresCrViTest && <span className="fw-poc-sub fw-poc-strong">{t('lines.crVi')}</span>}
                {line.note && <span className="fw-poc-sub">{line.note}</span>}
              </div>
              <div className="fw-poc-line-ask">
                <span className="fw-poc-qty">{qty(line.quantity, line.uom)}</span>
                <span className="fw-poc-sub">{t('lines.needed', { date: day(line.needDate) })}</span>
                {!answered && line.confirmedQuantity !== null && (
                  <span className="fw-poc-sub fw-poc-strong">{t('lines.confirmed', { quantity: quantityShown(line.confirmedQuantity, locale), unit: t(`uom.${line.uom}`), date: line.confirmedDate ? day(line.confirmedDate) : '—' })}</span>
                )}
              </div>
              {answered && (
                <div className="fw-poc-line-answer">
                  <span className="fw-poc-label">{t('lines.yourAnswer')}</span>
                  <LineAnswer line={line} draft={draft} model={model} />
                  {editable && (
                    <span className="fw-poc-line-actions">
                      <Button size="sm" onClick={() => actions?.onOpenLine?.(line.id)} aria-label={t('lines.changeAria', { seq: line.seq })}>
                        {t('lines.change')}
                      </Button>
                      {draft && draft.kind !== 'AS_ASKED' && (
                        <Button size="sm" variant="quiet" onClick={() => actions?.onResetLine?.(line.id)} aria-label={t('lines.asAskedAgainAria', { seq: line.seq })}>
                          {t('lines.asAskedAgain')}
                        </Button>
                      )}
                    </span>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

function LineAnswer({ line, draft, model }: { line: LinkOrderLine; draft: LineDraft | undefined; model: PoConfirmViewModel }) {
  const { t, locale, day, unit } = useWords(model)
  if (!draft || draft.kind === 'AS_ASKED') return <span className="fw-poc-answer">{t('lines.answer.AS_ASKED')}</span>
  const delivery = (quantity: string, date: string) => t('lines.delivery', { quantity: typedShown(quantity, locale), unit: unit(line.uom), date: date ? day(date) : '—' })
  const words =
    draft.kind === 'OTHER'
      ? t('lines.answer.OTHER', { quantity: draft.quantity.trim() === '' ? quantityShown(line.quantity, locale) : typedShown(draft.quantity, locale), unit: unit(line.uom), date: day(draft.date.trim() === '' ? line.needDate : draft.date) })
      : draft.kind === 'SPLIT'
        ? t('lines.answer.SPLIT', { first: delivery(draft.deliveries[0].quantity, draft.deliveries[0].date), second: delivery(draft.deliveries[1].quantity, draft.deliveries[1].date) })
        : t('lines.answer.CANNOT_DELIVER')
  const preview = model.page ? answerPreview({ ...model.page, lines: [line] }, { [line.id]: draft }, model.today, locale) : null
  const changes = preview?.lines[0]?.changes ?? []
  return (
    <span className="fw-poc-answer">
      <span className="fw-poc-strong">{words}</span>
      {changes.length > 0 && (
        <span className="fw-poc-tags">
          {changes.map((change) => (
            <Tag key={change} tone={change === 'CANNOT_DELIVER' ? 'danger' : 'warning'}>
              {t(`lines.changes.${change}`)}
            </Tag>
          ))}
        </span>
      )}
      {draft.reason.trim() !== '' && <span className="fw-poc-sub">{t('lines.reason', { reason: draft.reason.trim() })}</span>}
    </span>
  )
}

// ---- the answer ------------------------------------------------------------------------------------------------------------------

function AnswerCard({ page, model, preview, actions }: { page: LinkOrder; model: PoConfirmViewModel; preview: AnswerPreview | null; actions?: PoConfirmActions }) {
  const { t, buyer } = useWords(model)
  const held = sendHeld(model, preview)
  const name = nameAsked(page, 'confirm')
  const outcome = preview?.outcome ?? 'PROPOSED'
  const changed = Object.keys(model.answers).length > 0
  const main = outcome === 'CONFIRMED' ? t('answer.confirmAll') : outcome === 'DECLINED' ? t('answer.sendDecline') : t('answer.sendChanges')
  const summary = preview ? summaryParts(preview.counts).map((part) => t(part.key, { count: part.count })).join(' · ') : null
  return (
    <Card padded className="fw-poc-card fw-poc-answer-card" aria-labelledby="fw-poc-answer">
      <form
        className="fw-poc-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) actions?.onSend?.()
        }}
      >
        <h2 id="fw-poc-answer" className="fw-poc-h2">
          {t('answer.title')}
        </h2>
        {summary && (
          <p className="fw-poc-review" role="status">
            <strong>{t('answer.review', { summary })}</strong> <span>{t(`answer.outcome.${outcome}`, { buyer })}</span>
          </p>
        )}
        <div className="fw-poc-fields">
          <Field label={t('answer.ref')} hint={t('answer.refHint')}>
            <Input value={model.supplierRef} onChange={(event) => actions?.onField?.('supplierRef', event.target.value)} maxLength={120} autoComplete="off" />
          </Field>
          {name !== 'none' && (
            <Field label={t(name === 'required' ? 'answer.name' : 'answer.nameOptional')} hint={t('answer.nameHint', { buyer })} required={name === 'required'}>
              <Input value={model.typedName} onChange={(event) => actions?.onField?.('typedName', event.target.value)} autoComplete="name" maxLength={200} />
            </Field>
          )}
        </div>
        <Field label={t('answer.note', { buyer })}>
          <Textarea value={model.note} onChange={(event) => actions?.onField?.('note', event.target.value)} rows={3} maxLength={2000} />
        </Field>
        <PdfChooser model={model} actions={actions} />
        {model.problem && <Banner tone={model.problem === 'changed' ? 'warning' : 'danger'} title={t(`problem.${model.problem}`)} />}
        <div className="fw-poc-actions">
          <Button type="submit" variant={outcome === 'DECLINED' ? 'danger' : 'primary'} heldReason={held ? t(held) : null}>
            {model.send === 'busy' ? <Spinner size={14} /> : outcome === 'CONFIRMED' ? <CheckCircle2 size={16} aria-hidden /> : <Send size={16} aria-hidden />} {model.send === 'busy' ? t('answer.busy') : main}
          </Button>
          {changed && (
            <Button variant="quiet" onClick={() => actions?.onResetAll?.()}>
              {t('answer.undoAll')}
            </Button>
          )}
          {outcome !== 'DECLINED' && (
            <Button variant="danger-outline" onClick={() => actions?.onDecline?.(true)}>
              {t('answer.decline')}
            </Button>
          )}
        </div>
      </form>
    </Card>
  )
}

const sizeWords = (bytes: number, t: ReturnType<typeof useT>, locale: Locale) =>
  bytes >= 1024 * 1024
    ? t('file.mb', { size: new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 1 }).format(bytes / 1024 / 1024) })
    : t('file.kb', { size: String(Math.max(1, Math.round(bytes / 1024))) })

/** A file chooser in this page's words (the DS FileDropzone speaks English only): a button, the state, what may be chosen. */
function PdfChooser({ model, actions }: { model: PoConfirmViewModel; actions?: PoConfirmActions }) {
  const { t, locale } = useWords(model)
  const input = useRef<HTMLInputElement>(null)
  const upload = model.upload
  const busy = upload.state === 'uploading'
  let state: ReactNode
  switch (upload.state) {
    case 'none':
      state = <span className="fw-poc-hint">{t('file.none')}</span>
      break
    case 'uploading':
      state = (
        <span className="fw-poc-file-state" role="status">
          <Spinner size={14} /> {t('file.uploading', { name: upload.name })}
        </span>
      )
      break
    case 'done':
      state = (
        <span className="fw-poc-file-state fw-poc-ok" role="status">
          <CheckCircle2 size={16} aria-hidden /> {t('file.done', { name: upload.name, size: sizeWords(upload.size, t, locale) })}
        </span>
      )
      break
    case 'quarantined':
      state = (
        <span className="fw-poc-file-state fw-poc-bad" role="alert">
          <ShieldAlert size={16} aria-hidden /> {t('file.quarantined', { name: upload.name })}
        </span>
      )
      break
    case 'failed':
      state = (
        <span className="fw-poc-file-state fw-poc-bad" role="alert">
          <XCircle size={16} aria-hidden /> {t('file.failed', { name: upload.name })}
        </span>
      )
      break
    case 'rejected':
      state = (
        <span className="fw-poc-file-state fw-poc-bad" role="alert">
          <XCircle size={16} aria-hidden /> {t(`file.rejected.${upload.problem}`, { name: upload.name })}
        </span>
      )
      break
  }
  return (
    <div className="fw-poc-file">
      <span className="fw-poc-label">{t('file.title')}</span>
      <span className="fw-poc-file-row">
        <Button size="sm" onClick={() => input.current?.click()} heldReason={busy ? t('answer.held.uploading') : null}>
          <Paperclip size={14} aria-hidden /> {upload.state === 'none' ? t('file.choose') : t('file.change')}
        </Button>
        {upload.state !== 'none' && !busy && (
          <Button size="sm" variant="quiet" onClick={() => actions?.onRemoveFile?.()}>
            {t('file.remove')}
          </Button>
        )}
      </span>
      {state}
      <span className="fw-poc-hint">{t('file.hint')}</span>
      <input
        ref={input}
        type="file"
        hidden
        accept="application/pdf,.pdf"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) actions?.onPickFile?.(file)
          event.target.value = ''
        }}
      />
    </div>
  )
}

// ---- a line's sheet ----------------------------------------------------------------------------------------------------------------

function LineSheet({ page, model, actions }: { page: LinkOrder; model: PoConfirmViewModel; actions?: PoConfirmActions }) {
  const { t, locale, day, unit, buyer } = useWords(model)
  const sheet = model.sheet!
  const line = page.lines.find((entry) => entry.id === sheet.lineId)
  if (!line) return null
  const draft = sheet.draft
  const problems: DraftProblems = sheet.tried ? draftProblems(line, draft, model.today, locale) : {}
  const first = sheet.tried ? firstProblemKey(draftProblems(line, draft, model.today, locale)) : null
  const set = (patch: Partial<LineDraft>) => actions?.onSheetDraft?.({ ...draft, ...patch })
  const setPart = (index: 0 | 1, patch: Partial<LineDraft['deliveries'][0]>) => {
    const parts = [...draft.deliveries] as [LineDraft['deliveries'][0], LineDraft['deliveries'][1]]
    parts[index] = { ...parts[index], ...patch }
    set({ deliveries: parts })
  }
  const word = (key: string | undefined, group: string) => (key ? t(`sheet.problem.${group}.${key}`) : undefined)
  const dateField = (value: string, onChange: (value: string) => void, error: string | undefined, label: string) => (
    <Field label={label} error={error}>
      <DateField value={value} onChange={onChange} locale={locale === 'it' ? 'it-IT' : 'en-GB'} min={model.today} clearable={false} ariaLabel={label} />
    </Field>
  )
  const quantityField = (value: string, onChange: (value: string) => void, error: string | undefined) => (
    <Field label={t('sheet.quantity', { unit: unit(line.uom) })} error={error}>
      <Input value={value} onChange={(event) => onChange(event.target.value)} inputMode="decimal" autoComplete="off" suffix={unit(line.uom)} />
    </Field>
  )
  const article = [line.code, line.name].filter(Boolean).join(' · ')
  return (
    <Modal
      open
      onClose={() => actions?.onSheetClose?.()}
      title={t('sheet.title', { seq: line.seq })}
      subtitle={article}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onSheetClose?.()}>{t('sheet.cancel')}</Button>
          <Button variant="primary" type="submit" form="fw-poc-sheet" heldReason={first ? t(first) : null}>
            {t('sheet.save')}
          </Button>
        </>
      }
    >
      <form
        id="fw-poc-sheet"
        className="fw-poc-sheet"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          if (!first) actions?.onSheetSave?.()
        }}
      >
        <KeyValue dense labelCase="sentence" items={[{ label: t('sheet.asked'), value: t('sheet.askedValue', { quantity: quantityShown(line.quantity, locale), unit: unit(line.uom), date: day(line.needDate) }) }]} />
        <div className="fw-poc-kinds" role="radiogroup" aria-label={t('sheet.kind')}>
          <span className="fw-poc-label">{t('sheet.kind')}</span>
          {KINDS.map((kind) => (
            <RadioCard
              key={kind}
              name={`fw-poc-kind-${line.id}`}
              value={kind}
              checked={draft.kind === kind}
              selected={draft.kind === kind}
              onChange={() => actions?.onSheetKind?.(kind)}
              title={t(`sheet.kinds.${kind}.title`)}
              description={kind === 'AS_ASKED' ? t('sheet.kinds.AS_ASKED.body', { quantity: quantityShown(line.quantity, locale), unit: unit(line.uom), date: day(line.needDate) }) : t(`sheet.kinds.${kind}.body`)}
            />
          ))}
        </div>
        {draft.kind === 'OTHER' && (
          <div className="fw-poc-pair">
            {quantityField(draft.quantity, (quantity) => set({ quantity }), word(problems.quantity, 'quantity'))}
            {dateField(draft.date, (date) => set({ date }), word(problems.date, 'date'), t('sheet.date'))}
          </div>
        )}
        {draft.kind === 'SPLIT' &&
          ([0, 1] as const).map((index) => (
            <fieldset key={index} className="fw-poc-delivery">
              <legend className="fw-poc-label">{t(index === 0 ? 'sheet.first' : 'sheet.second')}</legend>
              <div className="fw-poc-pair">
                {quantityField(draft.deliveries[index].quantity, (quantity) => setPart(index, { quantity }), word(problems.deliveries?.[index]?.quantity, 'quantity'))}
                {dateField(draft.deliveries[index].date, (date) => setPart(index, { date }), word(problems.deliveries?.[index]?.date, 'date') ?? (index === 1 && problems.whole === 'sameDay' ? t('sheet.problem.whole.sameDay') : undefined), t('sheet.date'))}
              </div>
            </fieldset>
          ))}
        {draft.kind !== 'AS_ASKED' && (
          <Field label={t('sheet.reason')} hint={t('sheet.reasonHint', { buyer })} error={word(problems.reason, 'reason')} required>
            <Textarea value={draft.reason} onChange={(event) => set({ reason: event.target.value })} rows={2} maxLength={600} />
          </Field>
        )}
        {problems.whole && problems.whole !== 'sameDay' && <Banner tone="warning" title={t(`sheet.problem.whole.${problems.whole}`)} />}
      </form>
    </Modal>
  )
}

// ---- decline ---------------------------------------------------------------------------------------------------------------------

function DeclineDialog({ page, model, actions }: { page: LinkOrder; model: PoConfirmViewModel; actions?: PoConfirmActions }) {
  const { t, buyerStart } = useWords(model)
  const held = declineHeld(model)
  const name = nameAsked(page, 'decline')
  const decline = model.decline
  return (
    <Modal
      open
      onClose={() => actions?.onDecline?.(false)}
      title={t('decline.title')}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onDecline?.(false)}>{t('decline.back')}</Button>
          <Button variant="danger" heldReason={held ? t(held) : null} onClick={() => actions?.onDeclineSend?.()}>
            {model.send === 'busy' ? <Spinner size={14} /> : null} {t('decline.go')}
          </Button>
        </>
      }
    >
      <div className="fw-poc-sheet">
        <p className="fw-poc-hint">{t('decline.body', { buyer: buyerStart })}</p>
        <Field label={t('decline.reason')}>
          <Select value={decline.reason} onChange={(event) => actions?.onDeclineDraft?.(event.target.value as DeclineReason, decline.note)}>
            {DECLINES.map((reason) => (
              <option key={reason} value={reason}>
                {t(`decline.reasons.${reason}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t(decline.reason === 'OTHER' ? 'decline.noteRequired' : 'decline.note')} required={decline.reason === 'OTHER'} error={decline.tried && held === 'decline.held.note' ? t(held) : undefined}>
          <Textarea value={decline.note} onChange={(event) => actions?.onDeclineDraft?.(decline.reason, event.target.value)} rows={3} maxLength={2000} />
        </Field>
        {name !== 'none' && (
          <Field label={t(name === 'required' ? 'answer.name' : 'answer.nameOptional')} required={name === 'required'}>
            <Input value={model.typedName} onChange={(event) => actions?.onField?.('typedName', event.target.value)} autoComplete="name" maxLength={200} />
          </Field>
        )}
        {model.problem && <Banner tone="danger" title={t(`problem.${model.problem}`)} />}
      </div>
    </Modal>
  )
}

// ---- end states --------------------------------------------------------------------------------------------------------------------

function DoneCard({ page, model }: { page: LinkOrder; model: PoConfirmViewModel }) {
  const { t, locale, day, buyer, buyerStart } = useWords(model)
  const done = model.done!
  const preview = done.outcome === 'CONFIRMED' ? answerPreview({ ...page, canAnswer: true }, model.answers, model.today, locale) : null
  const span = preview ? expectedSpan(preview.lines) : null
  const site = page.deliverTo?.name ?? null
  const summary = done.counts ? summaryParts(done.counts).map((part) => t(part.key, { count: part.count })).join(' · ') : ''
  const facts = [...(done.supplierRef ? [{ label: t('done.ref'), value: done.supplierRef }] : []), ...(done.fileName ? [{ label: t('done.file'), value: done.fileName }] : [])]
  const icon = done.outcome === 'CONFIRMED' ? <CheckCircle2 size={22} aria-hidden className="fw-poc-ok" /> : done.outcome === 'PROPOSED' ? <Send size={22} aria-hidden className="fw-poc-info" /> : <XCircle size={22} aria-hidden className="fw-poc-muted" />
  return (
    <Card padded className={`fw-poc-card fw-poc-done tone-${done.outcome}`} role="status">
      <h2 className="fw-poc-h2">
        {icon} {t(`done.${done.outcome}.title`, { buyer: buyerStart })}
      </h2>
      {done.outcome === 'CONFIRMED' && (
        <>
          <p className="fw-poc-hint">
            {t('done.CONFIRMED.body', { buyer: buyerStart })}{' '}
            {span ? (span.first === span.last ? (site ? t('done.CONFIRMED.expect', { site, date: day(span.last) }) : t('done.CONFIRMED.expectNoSite', { date: day(span.last) })) : site ? t('done.CONFIRMED.expectRange', { site, first: day(span.first), last: day(span.last) }) : t('done.CONFIRMED.expectNoSite', { date: day(span.last) })) : null}
          </p>
          <p className="fw-poc-hint">{t('done.CONFIRMED.later', { buyer })}</p>
        </>
      )}
      {done.outcome === 'PROPOSED' && <p className="fw-poc-hint">{t('done.PROPOSED.body', { buyer, summary })}</p>}
      {done.outcome === 'DECLINED' && <p className="fw-poc-hint">{t('done.DECLINED.body', { buyer: buyerStart })}</p>}
      {facts.length > 0 && <KeyValue dense labelCase="sentence" items={facts} />}
    </Card>
  )
}

function Answered({ page, model }: { page: LinkOrder; model: PoConfirmViewModel }) {
  const { t, buyer, buyerStart } = useWords(model)
  const key = answeredKey(page.order.status)
  const status = page.order.status
  const icon =
    status === 'CHANGES_PROPOSED' ? <Send size={28} aria-hidden /> : status === 'DECLINED' || status === 'CANCELLED' ? <XCircle size={28} aria-hidden /> : status === 'DRAFT' ? <Clock3 size={28} aria-hidden /> : <CheckCircle2 size={28} aria-hidden />
  return (
    <Card padded className="fw-poc-card fw-poc-done tone-answered" role="status">
      <EmptyState icon={icon} title={t(`${key}.title`, { buyer })} description={t(`${key}.body`, { buyer: buyerStart })} />
    </Card>
  )
}

function DeadLink({ model, actions }: { model: PoConfirmViewModel; actions?: PoConfirmActions }) {
  const { t, locale } = useWords(model)
  const shell = useT('shell')
  const sender = model.page ? companyOf(model.page) : null
  const state = model.link
  const expiredWhileOpen = state === 'expired' && model.page !== null
  const title = expiredWhileOpen ? t('dead.expiredTitle', { time: formatDateTime(model.page!.expiresAt, { locale, timeZone: model.timeZone }) }) : shell(`links.state.${state}.title`)
  const body = expiredWhileOpen ? (sender ? t('dead.expiredBody', { sender }) : t('dead.expiredBodyAnonymous')) : sender ? shell(`links.state.${state}.body`, { sender }) : shell(`links.state.${state}.bodyAnonymous`)
  const canAsk = state === 'expired' || state === 'unavailable' || state === 'used' || state === 'withdrawn'
  return (
    <Card padded className="fw-poc-card fw-poc-dead">
      <EmptyState
        icon={state === 'expired' ? <Clock3 size={28} aria-hidden /> : <Link2Off size={28} aria-hidden />}
        title={title}
        description={model.newLinkAsked ? (sender ? t('dead.asked', { sender }) : t('dead.askedAnonymous')) : body}
        action={
          canAsk && !model.newLinkAsked ? (
            <Button variant="primary" onClick={() => actions?.onNewLink?.()}>
              {t('dead.ask')}
            </Button>
          ) : undefined
        }
      />
      {model.problem && <Banner tone="danger" title={t(`problem.${model.problem}`)} />}
    </Card>
  )
}

function ReadFailed({ actions }: { actions?: PoConfirmActions }) {
  const t = useT(NS)
  return (
    <Card padded className="fw-poc-card fw-poc-dead">
      <EmptyState
        icon={<ShieldAlert size={28} aria-hidden />}
        title={t('error.title')}
        description={t('error.body')}
        action={
          <Button variant="primary" onClick={() => actions?.onRetry?.()}>
            {t('error.retry')}
          </Button>
        }
      />
    </Card>
  )
}
