'use client'

import { useMemo, type KeyboardEvent } from 'react'
import { Banner, ChangeReview, Field, type KeyValueItem } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { PaymentPanel, type PaymentState } from '@nexus/ui/components/PaymentPanel/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { SignBlock } from '@nexus/ui/components/SignBlock/index'
import { SizeGridEditor, type SizeGridCopy } from '@nexus/ui/grid/size-grid/index'
import { Button, Checkbox, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, DetailModal, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useT } from '../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import { FAKE_SCENARIOS, type ApprovalPage, type ChangeRules, type FakeScenario, type RuleLine } from '../api'
import { cancelFeeOf, changedCells, MAX_NOTE, wantedSizes, type CancelDraft, type ChangeDraft, type ReconfirmDecision } from '../model'
import { useOrderWords, type OrderWords } from '../words'
import { RevisionReview } from './StatusTab'
import { Loading, ReadFailed } from './parts'

/**
 * The pop-ups of Orders & tracking (design portal.customer.orders pop:change-request, pop:cancel-request, pop:reconfirm,
 * pop:pay-deposit; a document's preview). Each a DS Modal (a bottom sheet on a phone) or DetailModal; Esc closes and the
 * focus goes back to the opener; a typed change asks before it is thrown away. Every button that cannot act says why.
 */

/** The DS size grid's words in the page's language (this catalogue's `size.*`, the stacked layout's from ds-words). */
function useSizeCopy(t: OrderWords['t']): Partial<SizeGridCopy> {
  const ds = useDsWords()
  return useMemo(
    () => ({
      caption: t('size.caption'),
      colourHeader: t('size.colour'),
      totalHeader: t('size.total'),
      cellName: (colour, size) => t('size.cellName', { colour, size }),
      notOffered: t('size.notOffered'),
      empty: t('size.empty'),
      totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }) => t('size.totals', { colour, rowTotal, size, columnTotal, grand }),
      notWhole: (cell, max) => t('size.notWhole', { cell, max }),
      cutToMax: (cell, max) => t('size.cutToMax', { cell, max }),
      pasteResult: ({ applied, notOffered, outside, invalid, clamped }) => t('size.pasted', { applied, skipped: notOffered + outside + invalid + clamped }),
      issuesHeading: t('size.issues'),
      ...ds.sizeGridStacked,
    }),
    [t, ds.sizeGridStacked],
  )
}

const lineTitle = (line: Pick<RuleLine, 'seq' | 'style' | 'colourway'>, t: OrderWords['t']) => t('change.line', { seq: line.seq, style: line.style?.code ?? '—', colour: line.colourway?.name ?? '' })

// ── Ask for a change ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface ChangeDialogModel {
  state: 'loading' | 'error' | 'ready'
  number: string
  rules: ChangeRules | null
  draft: ChangeDraft
  /** Why the change cannot go (a message key), or null. */
  held: string | null
  busy: boolean
  /** A refusal in our words (a message key). */
  problem: string | null
  /** Esc / Close with a typed change: Discard or Stay. */
  discard: boolean
  /** The delivery address as agreed now. */
  shipTo: readonly string[]
  /** Today (Europe/Rome): the earliest day to ask for. */
  today: string
}

export interface ChangeDialogActions {
  onCells?: (lineId: string, sizes: Record<string, number>) => void
  onDate?: (day: string) => void
  onShipTo?: (addressId: string) => void
  onNote?: (note: string) => void
  onReview?: () => void
  onBack?: () => void
  onSend?: () => void
  onClose?: () => void
  onDiscard?: () => void
  onStay?: () => void
  onRetry?: () => void
}

export function ChangeDialog({ model, actions }: { model: ChangeDialogModel; actions?: ChangeDialogActions }) {
  const words = useOrderWords()
  const { t, locale, day } = words
  const copy = useSizeCopy(t)
  const rules = model.rules
  const review = model.draft.step === 'review'
  const held = model.held ? t(model.held, { words: rules?.change.words[locale] ?? '' }) : null
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (review && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !held) {
      event.preventDefault()
      actions?.onSend?.()
    }
  }
  const footer =
    model.state !== 'ready' || !rules ? (
      <Button onClick={() => actions?.onClose?.()}>{t('dialog.close')}</Button>
    ) : review ? (
      <>
        <Button onClick={() => actions?.onBack?.()} heldReason={model.busy ? t('held.busy') : null}>
          {t('change.back')}
        </Button>
        <Button variant="primary" heldReason={held} onClick={() => actions?.onSend?.()}>
          {model.busy ? <Spinner size={14} /> : null} {t('change.send')}
        </Button>
      </>
    ) : (
      <>
        <Button onClick={() => actions?.onClose?.()}>{t('dialog.cancel')}</Button>
        <Button variant="primary" heldReason={held} onClick={() => actions?.onReview?.()}>
          {t('change.review')}
        </Button>
      </>
    )
  return (
    <>
      <Modal open sheet size="lg" onClose={() => actions?.onClose?.()} title={t('change.title', { number: model.number })} subtitle={review ? t('change.reviewStep') : t('change.editStep')} footer={footer} closeHeld={model.busy ? t('held.busy') : null}>
        <div className="fw-pord-dialog" onKeyDown={onKey}>
          {model.state === 'loading' ? (
            <Loading rows={3} height={56} />
          ) : model.state === 'error' || !rules ? (
            <ReadFailed title={t('change.failed')} onRetry={actions?.onRetry} />
          ) : !rules.change.possible ? (
            <Banner tone="warning" title={rules.change.words[locale]} />
          ) : review ? (
            <ChangeReviewStep model={model} rules={rules} words={words} />
          ) : (
            <>
              <p className="fw-pord-hint">{t('change.hint')}</p>
              {rules.lines.map((line) => (
                <section key={line.lineId} className="fw-pord-change-line" aria-label={lineTitle(line, t)} data-focus={model.draft.focusLine === line.lineId ? '' : undefined}>
                  <h3 className="fw-pord-h3">{lineTitle(line, t)}</h3>
                  {line.change.possible ? (
                    <SizeGridEditor
                      layout="auto"
                      colours={[{ key: line.lineId, label: line.colourway?.name ?? line.style?.code ?? '—', offered: line.sizes.filter((size) => size.offered || size.quantity > 0).map((size) => size.size) }]}
                      sizes={line.sizes.map((size) => ({ key: size.size, label: size.size }))}
                      value={{ [line.lineId]: wantedSizes(line, model.draft) }}
                      onChange={(next) => actions?.onCells?.(line.lineId, next[line.lineId] ?? {})}
                      issues={changedCells({ lines: [line] }, model.draft).map((cell) => ({ colour: line.lineId, size: cell.size, message: t('change.was', { count: cell.before }), tone: 'warning' as const }))}
                      caption={lineTitle(line, t)}
                      locale={INTL_LOCALE[locale]}
                      copy={copy}
                    />
                  ) : (
                    <p className="fw-pord-held">{line.change.words[locale]}</p>
                  )}
                </section>
              ))}
              <div className="fw-pord-fields">
                <Field label={t('change.date')} hint={rules.order.requestedDate ? t('change.dateNow', { date: day(rules.order.requestedDate) }) : t('change.dateNone')}>
                  <DateField value={model.draft.requestedDate} min={model.today} onChange={(value) => actions?.onDate?.(value)} clearable />
                </Field>
                <Field label={t('change.shipTo')} hint={model.shipTo.length > 0 ? t('change.shipToNow', { address: model.shipTo.join(', ') }) : t('change.newAddress')}>
                  <Select value={model.draft.shipToAddressId} onChange={(event) => actions?.onShipTo?.(event.target.value)}>
                    <option value="">{t('change.shipToSame')}</option>
                    {rules.addresses.map((address) => (
                      <option key={address.id} value={address.id}>
                        {address.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="fw-pord-note">
                <Field label={t('change.note')} hint={t('change.noteHint')} error={model.draft.note.length > MAX_NOTE ? t('change.problem.long') : undefined}>
                  <Textarea value={model.draft.note} rows={3} maxLength={MAX_NOTE + 200} onChange={(event) => actions?.onNote?.(event.target.value)} />
                </Field>
              </div>
            </>
          )}
          {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
        </div>
      </Modal>
      {model.discard ? (
        <Modal
          open
          size="sm"
          onClose={() => actions?.onStay?.()}
          title={t('discard.title')}
          footer={
            <>
              <Button onClick={() => actions?.onStay?.()}>{t('discard.stay')}</Button>
              <Button variant="danger" onClick={() => actions?.onDiscard?.()}>
                {t('discard.go')}
              </Button>
            </>
          }
        >
          <p className="fw-pord-hint">{t('discard.body')}</p>
        </Modal>
      ) : null}
    </>
  )
}

function ChangeReviewStep({ model, rules, words }: { model: ChangeDialogModel; rules: ChangeRules; words: OrderWords }) {
  const { t, day } = words
  const cells = changedCells(rules, model.draft)
  const items = rules.lines
    .filter((line) => cells.some((cell) => cell.lineId === line.lineId))
    .map((line) => {
      const mine = cells.filter((cell) => cell.lineId === line.lineId)
      const before = mine.reduce((sum, cell) => sum + cell.before, 0)
      const after = mine.reduce((sum, cell) => sum + cell.after, 0)
      const values: KeyValueItem[] = mine.map((cell) => ({ label: t('change.size', { size: cell.size }), value: t('revision.oldNew', { old: cell.before, new: cell.after }) }))
      return { id: line.lineId, label: lineTitle(line, t), status: t('change.pieces', { delta: after - before > 0 ? `+${after - before}` : String(after - before) }), note: line.style?.name ?? '', selectable: false, values }
    })
  const address = rules.addresses.find((entry) => entry.id === model.draft.shipToAddressId) ?? null
  const extra = [
    ...(model.draft.requestedDate && model.draft.requestedDate !== (rules.order.requestedDate ?? '')
      ? [{ id: 'date', label: t('change.date'), status: t('revision.change.CHANGED'), note: '', selectable: false, values: [{ label: t('revision.was'), value: rules.order.requestedDate ? day(rules.order.requestedDate) : '—' }, { label: t('revision.now'), value: day(model.draft.requestedDate) }] }]
      : []),
    ...(address ? [{ id: 'shipTo', label: t('change.shipTo'), status: t('revision.change.CHANGED'), note: '', selectable: false, values: [{ label: t('revision.was'), value: model.shipTo.join(', ') || '—' }, { label: t('revision.now'), value: address.label }] }] : []),
  ]
  return (
    <div className="fw-pord-stack">
      <p className="fw-pord-hint">{t('change.reviewHint')}</p>
      <ChangeReview label={t('change.reviewLabel')} items={[...items, ...extra]} selectedIds={[]} onSelectionChange={() => undefined} tick={false} />
      {model.draft.note.trim() ? <p className="fw-pord-sub">{t('requests.note', { note: model.draft.note.trim() })}</p> : null}
      <p className="fw-pord-sub">{t('change.sendKeys')}</p>
    </div>
  )
}

// ── Ask to cancel ────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CancelDialogModel {
  state: 'loading' | 'error' | 'ready'
  number: string
  rules: ChangeRules | null
  draft: CancelDraft
  held: { key: string; field: 'scope' | 'reason' | 'note' | null } | null
  busy: boolean
  problem: string | null
}

export interface CancelDialogActions {
  onDraft?: (draft: CancelDraft) => void
  onSend?: () => void
  onClose?: () => void
  onRetry?: () => void
}

export function CancelDialog({ model, actions }: { model: CancelDialogModel; actions?: CancelDialogActions }) {
  const words = useOrderWords()
  const { t, locale } = words
  const rules = model.rules
  const draft = model.draft
  const set = (over: Partial<CancelDraft>) => actions?.onDraft?.({ ...draft, ...over })
  const heldWords = model.held ? t(model.held.key, { words: rules?.cancel.words[locale] ?? '' }) : null
  const fieldError = (field: 'scope' | 'reason' | 'note') => (draft.tried && model.held?.field === field ? heldWords : undefined)
  const fee = rules ? cancelFeeOf(rules, draft) : null
  const reason = rules?.reasons.find((entry) => entry.code === draft.reasonCode) ?? null
  return (
    <Modal
      open
      sheet
      size="md"
      onClose={() => actions?.onClose?.()}
      title={t('cancel.title', { number: model.number })}
      closeHeld={model.busy ? t('held.busy') : null}
      footer={
        model.state !== 'ready' || !rules ? (
          <Button onClick={() => actions?.onClose?.()}>{t('dialog.close')}</Button>
        ) : (
          <>
            <Button onClick={() => actions?.onClose?.()}>{t('dialog.cancel')}</Button>
            <Button variant="danger" heldReason={model.held && (model.held.field === null || draft.tried) ? heldWords : null} onClick={() => actions?.onSend?.()}>
              {model.busy ? <Spinner size={14} /> : null} {t('cancel.send')}
            </Button>
          </>
        )
      }
    >
      <div className="fw-pord-dialog">
        {model.state === 'loading' ? (
          <Loading rows={3} height={48} />
        ) : model.state === 'error' || !rules ? (
          <ReadFailed title={t('cancel.failed')} onRetry={actions?.onRetry} />
        ) : (
          <>
            <p className="fw-pord-hint">{t('cancel.hint')}</p>
            <div className="fw-pord-stack" role="radiogroup" aria-label={t('cancel.what')}>
              <RadioCard name="cancel-scope" checked={draft.scope === 'ORDER'} selected={draft.scope === 'ORDER'} onChange={() => set({ scope: 'ORDER' })} title={t('cancel.whole')} description={rules.cancel.words[locale]} />
              <RadioCard name="cancel-scope" checked={draft.scope === 'LINES'} selected={draft.scope === 'LINES'} onChange={() => set({ scope: 'LINES' })} title={t('cancel.some')} description={t('cancel.someHint')} />
            </div>
            {draft.scope === 'LINES' ? (
              <fieldset className="fw-pord-lines-pick">
                <legend className="fw-pord-strong">{t('cancel.lines')}</legend>
                {rules.lines.map((line) => (
                  <label key={line.lineId} className="fw-pord-pick" data-held={line.cancel.possible ? undefined : ''}>
                    <Checkbox
                      checked={draft.lineIds.includes(line.lineId)}
                      disabled={!line.cancel.possible}
                      onChange={(event) => set({ lineIds: event.target.checked ? [...draft.lineIds, line.lineId] : draft.lineIds.filter((id) => id !== line.lineId) })}
                    />
                    <span className="fw-pord-stack">
                      <span>{lineTitle(line, t)}</span>
                      <span className={line.cancel.possible ? 'fw-pord-sub' : 'fw-pord-held'}>
                        {line.cancel.words[locale]}
                        {line.cancel.possible && rules.cancelFee?.pct && line.cancelFee != null ? ` · ${t('cancel.lineFee', { fee: words.money(line.cancelFee, rules.order.currency) })}` : ''}
                      </span>
                    </span>
                  </label>
                ))}
                {fieldError('scope') ? <p className="fw-pord-error">{fieldError('scope')}</p> : null}
              </fieldset>
            ) : fieldError('scope') ? (
              <p className="fw-pord-error">{fieldError('scope')}</p>
            ) : null}
            {rules.cancelFee ? (
              <p className={rules.cancelFee.pct ? 'fw-pord-strong' : 'fw-pord-sub'}>
                {rules.cancelFee.words[locale]}
                {fee != null && fee > 0 ? ` · ${t('cancel.fee', { fee: words.money(fee, rules.order.currency) })}` : ''}
              </p>
            ) : null}
            {rules.noWithdrawal ? <Banner tone="info" title={rules.noWithdrawal[locale]} /> : null}
            <Field label={t('cancel.reason')} required error={fieldError('reason')}>
              <Select value={draft.reasonCode} onChange={(event) => set({ reasonCode: event.target.value })}>
                <option value="">{t('cancel.reasonPick')}</option>
                {rules.reasons.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.words[locale]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="fw-pord-note">
              <Field label={t('cancel.note')} required={reason?.needsNote ?? false} hint={reason?.needsNote ? t('cancel.noteNeeded') : t('cancel.noteHint')} error={fieldError('note')}>
                <Textarea value={draft.note} rows={3} maxLength={MAX_NOTE + 200} onChange={(event) => set({ note: event.target.value })} />
              </Field>
            </div>
          </>
        )}
        {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
      </div>
    </Modal>
  )
}

// ── Re-confirm order version N ───────────────────────────────────────────────────────────────────────────────────────
export interface ReconfirmDialogModel {
  state: 'loading' | 'error' | 'ready'
  page: ApprovalPage | null
  number: string
  decision: ReconfirmDecision | null
  comment: string
  /** The answer cannot be given here: a message key. */
  held: string | null
  /** The page's own check (a message key), shown once Sign was pressed. */
  problem: string | null
  busy: boolean
  /** The signed answer: who and when (the end). */
  done: { decision: ReconfirmDecision; name: string; at: string } | null
}

export interface ReconfirmDialogActions {
  onDecision?: (decision: ReconfirmDecision) => void
  onComment?: (comment: string) => void
  onSign?: (name: string) => void
  onClose?: () => void
  onRetry?: () => void
}

export function ReconfirmDialog({ model, actions }: { model: ReconfirmDialogModel; actions?: ReconfirmDialogActions }) {
  const words = useOrderWords()
  const { t, day, at } = words
  const ds = useDsWords()
  const order = model.page?.content.revisedOrder ?? null
  const version = order?.revision ?? 0
  return (
    <DetailModal
      open
      onClose={() => actions?.onClose?.()}
      title={t('reconfirm.title', { version })}
      subtitle={model.page ? t('reconfirm.due', { number: model.number, date: day(model.page.request.dueAt) }) : model.number}
      loading={model.state === 'loading'}
      error={model.state === 'error' ? t('reconfirm.failed') : undefined}
      onRetry={actions?.onRetry}
    >
      {model.page && order ? (
        <div className="fw-pord-dialog">
          {model.done ? (
            <EndState
              tone={model.done.decision === 'APPROVED' ? 'success' : 'warning'}
              title={t(`reconfirm.done.${model.done.decision}`, { version })}
              body={t('reconfirm.done.signed', { name: model.done.name, when: at(model.done.at) })}
              next={t(`reconfirm.done.next.${model.done.decision}`)}
              labels={ds.endState}
            />
          ) : (
            <>
              {model.page.request.question ? <blockquote className="fw-pord-quote">{model.page.request.question}</blockquote> : null}
              {order.reason ? <p className="fw-pord-sub">{t('reconfirm.why', { reason: order.reason })}</p> : null}
              <RevisionReview page={model.page} words={words} />
              <div className="fw-pord-stack" role="radiogroup" aria-label={t('reconfirm.choose')}>
                <RadioCard name="reconfirm" checked={model.decision === 'APPROVED'} selected={model.decision === 'APPROVED'} onChange={() => actions?.onDecision?.('APPROVED')} title={t('reconfirm.approve', { version })} description={t('reconfirm.approveHint')} disabled={model.held !== null} />
                <RadioCard name="reconfirm" checked={model.decision === 'REFUSED'} selected={model.decision === 'REFUSED'} onChange={() => actions?.onDecision?.('REFUSED')} title={t('reconfirm.decline')} description={t('reconfirm.declineHint')} disabled={model.held !== null} />
              </div>
              {model.decision === 'REFUSED' ? (
                <div className="fw-pord-note">
                  <Field label={t('reconfirm.reason')} required error={model.problem === 'reconfirm.problem.why' || model.problem === 'reconfirm.problem.long' ? t(model.problem) : undefined}>
                    <Textarea value={model.comment} rows={3} onChange={(event) => actions?.onComment?.(event.target.value)} />
                  </Field>
                </div>
              ) : null}
              <SignBlock
                title={t('reconfirm.sign')}
                legal={<p className="fw-pord-hint">{t(model.decision === 'REFUSED' ? 'reconfirm.legalDecline' : 'reconfirm.legal', { version })}</p>}
                nameLabel={t('reconfirm.name')}
                nameEmptyLabel={t('reconfirm.nameEmpty')}
                acceptLabel={model.decision === 'REFUSED' ? t('reconfirm.go.REFUSED') : model.decision === 'APPROVED' ? t('reconfirm.go.APPROVED', { version }) : t('reconfirm.go.choose')}
                onAccept={(acceptance) => actions?.onSign?.(acceptance.name)}
                state={model.busy ? 'busy' : 'idle'}
                busyLabel={t('held.busy')}
                heldReason={model.held ? t(model.held) : null}
                message={model.problem && model.problem !== 'reconfirm.problem.why' ? t(model.problem) : undefined}
                messageTone="danger"
              />
            </>
          )}
        </div>
      ) : null}
    </DetailModal>
  )
}

// ── Pay the deposit (the FAKE provider's fields) ─────────────────────────────────────────────────────────────────────
export interface PayDialogModel {
  /** What is paid: the amount written, the order. */
  amount: string
  number: string
  methods: readonly ('CARD' | 'SEPA_DEBIT')[]
  method: 'CARD' | 'SEPA_DEBIT' | null
  state: PaymentState
  /** The FAKE provider (local and test): its scenario buttons are the provider's fields. */
  fake: boolean
  held: string | null
  /** FAILED: the reason in our words. */
  failure: string | null
  /** A refusal of the start (a message key). */
  problem: string | null
}

export interface PayDialogActions {
  onMethod?: (method: 'CARD' | 'SEPA_DEBIT') => void
  onStart?: () => void
  onScenario?: (scenario: FakeScenario) => void
  onRetry?: () => void
  onClose?: () => void
}

export function PayDialog({ model, actions }: { model: PayDialogModel; actions?: PayDialogActions }) {
  const { t } = useOrderWords()
  const ds = useDsWords()
  const scenarios: readonly FakeScenario[] = model.method === 'SEPA_DEBIT' ? ['succeed', 'settle'] : FAKE_SCENARIOS.filter((scenario) => scenario !== 'settle')
  return (
    <Modal open sheet size="md" onClose={() => actions?.onClose?.()} title={t('pay.title')} closeHeld={model.state === 'paying' || model.state === 'starting' ? t('held.busy') : null} footer={<Button onClick={() => actions?.onClose?.()}>{t('dialog.close')}</Button>}>
      <div className="fw-pord-dialog">
        <PaymentPanel
          amount={model.amount}
          purpose={t('pay.purpose', { number: model.number })}
          providerName={model.fake ? t('pay.fakeProvider') : undefined}
          methods={model.methods.map((method) => ({ id: method, label: t(`pay.method.${method}`), description: t(`pay.methodHint.${method}`) }))}
          method={model.method}
          onMethod={(id) => actions?.onMethod?.(id as 'CARD' | 'SEPA_DEBIT')}
          state={model.state}
          heldReason={model.held}
          onStart={() => actions?.onStart?.()}
          fields={
            model.fake ? (
              <div className="fw-pord-fake">
                <p className="fw-pord-hint">{t('pay.fakeNote')}</p>
                <div className="fw-pord-buttons">
                  {scenarios.map((scenario) => (
                    <Button key={scenario} variant={scenario === 'succeed' ? 'primary' : 'secondary'} size="sm" heldReason={model.state === 'paying' ? t('held.busy') : null} onClick={() => actions?.onScenario?.(scenario)}>
                      {t(`pay.scenario.${scenario}`)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null
          }
          failure={model.failure}
          onRetry={() => actions?.onRetry?.()}
          succeeded={model.state === 'succeeded' ? { words: t('pay.paid') } : null}
          labels={ds.paymentPanel}
        />
        {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
      </div>
    </Modal>
  )
}

// ── a document's preview (PDF) ───────────────────────────────────────────────────────────────────────────────────────
export interface PreviewModel {
  title: string
  state: 'loading' | 'error' | 'ready'
  bytes: Uint8Array | null
}

export function PreviewDialog({ model, onClose, onDownload, onRetry }: { model: PreviewModel; onClose?: () => void; onDownload?: () => void; onRetry?: () => void }) {
  const { t } = useOrderWords()
  const shell = useT('shell')
  return (
    <Modal open size="xl" onClose={() => onClose?.()} title={model.title} footer={<Button onClick={() => onClose?.()}>{t('dialog.close')}</Button>}>
      {model.state === 'loading' ? (
        <Loading rows={1} height={320} />
      ) : model.state === 'error' || !model.bytes ? (
        <ReadFailed title={t('docs.previewFailed')} onRetry={onRetry} />
      ) : (
        <PdfViewer src={model.bytes} title={model.title} onDownload={onDownload} labels={pdfViewerLabels(shell)} height="min(70vh, 760px)" />
      )}
    </Modal>
  )
}
