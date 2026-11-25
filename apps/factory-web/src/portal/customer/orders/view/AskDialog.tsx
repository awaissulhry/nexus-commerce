'use client'

import { useMemo, type KeyboardEvent } from 'react'
import { Banner, Field, KeyValue, type KeyValueItem } from '@nexus/ui/components'
import { SizeGridEditor, type SizeGridCopy } from '@nexus/ui/grid/size-grid/index'
import { Button, CheckboxCard, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { ChangeRules, ProductionAskKind } from '../api'
import { askBodyOf, sampleKindsOf, splitCells, splitLines, takesDate, type AskChoice, type AskDraft, type AskKind } from '../ask-model'
// F-SA-246: the design change — its lines, their words, its files (from the device through the order's conversation, or already on it).
import { designBodyOf, MAX_DESIGN_FILES, MAX_DESIGN_WORDS, takesSteps, type PickableFile } from '../ask-model'
// B-SA-046b: which pieces a design change is for.
import { appliesToOf, APPLIES_TO_CHOICES } from '../ask-model'
import { ComposeFiles, type ComposeFilesModel } from '../../../../lib/request-compose/view/ComposeFiles'
import { MAX_NOTE } from '../model'
import { useOrderWords, type OrderWords } from '../words'
import { AskImpact, type AskImpactModel } from './AskImpact'
import { ChangeDiscard, ChangeStep, ChangeStepFooter, type ChangeDialogActions, type ChangeDialogModel } from './Dialogs' // pp-fx4 (walk W-05)
import { Loading, ReadFailed } from './parts'
// B-SA-046d: the line's picture, the ONE picture part (src/lib), drawn from the address the portal's own read holds.
import { RecordPicture } from '../../../../lib/record-picture/view/RecordPicture'
import type { RowPicture } from '../../../../lib/record-picture/model'

/**
 * F-PR-13 — the portal Ask dialog (production plan §3, §5; 06-tree B.2 P-ORD-ask; design: a DS Modal, a full-screen sheet on a
 * phone): step 1 what (change, cancel, and the production asks the customer's limits open — make it urgent, pause, resume, ship
 * what is ready, another sample), step 2 the details of a production ask, step 3 what it means before Send (AskImpact). A change
 * goes on in this same pop-up (pp-fx4, walk W-05: its sizes are step 2); a cancel in its own (the lines and reasons), with the same
 * step 3. A kind whose request waits is not asked twice: Withdraw it here, or answer our counter-offer in Waiting for you. Every button that cannot act says
 * why; Esc closes; Ctrl/⌘ + Enter sends on step 3.
 */

export interface AskDialogModel {
  state: 'loading' | 'error' | 'ready'
  /** The customer's own name of the order ("Your order 12"). */
  number: string
  rules: ChangeRules | null
  step: 'what' | 'details' | 'impact'
  kind: AskKind | null
  choices: readonly AskChoice[]
  draft: AskDraft
  /** Why the step's main button cannot act (a key), or null. */
  held: string | null
  impact: AskImpactModel | null
  busy: boolean
  /** A refusal in our words (a key). */
  problem: string | null
  /** Waiting for you (our counter-offer is answered there). */
  waitingHref: string
  /** Why Withdraw cannot act (words), or null; the request being withdrawn now. */
  withdrawHeld: string | null
  withdrawing: string | null
  /** Today (Europe/Rome): the earliest day to ask for. */
  today: string
  /** F-SA-246: a design change's files (absent or null: not a design change, or not read yet). */
  design?: DesignAskModel | null
}

// ---- F-SA-246 (R6; 14-change-flow §2.4): the design change's files ----
export interface DesignAskModel {
  /** The files already on the order it may name (the order's own and its lines', shared with the customer). */
  orderFiles: { state: 'loading' | 'error' | 'ready'; files: readonly PickableFile[] }
  /** The files from the device, sent through the order's conversation's upload route (closed until the virus scanner runs). */
  upload: ComposeFilesModel
  /** Our uploads that go with it (sent: clean). */
  uploaded: readonly string[]
  /** Our uploads still held for the virus scan: they stay on the order, this request carries the others. */
  scanning: number
}
// ---- end F-SA-246

export interface AskDialogActions {
  onKind?: (kind: AskKind) => void
  onNext?: () => void
  onBack?: () => void
  onReview?: () => void
  onSend?: () => void
  onDraft?: (draft: AskDraft) => void
  onWithdraw?: (requestId: string) => void
  onClose?: () => void
  onRetry?: () => void
  onRetryImpact?: () => void
  // F-SA-246: a design change's files from the device, and the order's files read again.
  onUpload?: (files: File[]) => void
  onUploadRemove?: (key: string) => void
  onUploadRetry?: () => void
  onRetryOrderFiles?: () => void
}

const STEP_KEY = { what: 'ask.step.what', details: 'ask.step.details', impact: 'ask.step.impact' } as const

/**
 * pp-fx4 (walk W-05): the ONE Ask pop-up — the band's "Ask for a change…" and a line's ⋯ open it. A change is its steps 2 and 3 (the
 * sizes, then what it means: `ChangeStep`), drawn in this same frame and Modal, so the pop-up stays one as it moves between its steps.
 */
export type AskFlow = { kind: 'ask'; model: AskDialogModel; actions?: AskDialogActions } | { kind: 'change'; model: ChangeDialogModel; actions?: ChangeDialogActions }

export function AskDialog({ flow }: { flow: AskFlow }) {
  const { t, locale } = useOrderWords()
  const change = flow.kind === 'change' ? flow : null
  const step: AskDialogModel['step'] = change ? (change.model.draft.step === 'review' ? 'impact' : 'details') : flow.kind === 'ask' ? flow.model.step : 'what'
  const heldKey = flow.model.held
  const held = heldKey ? (change ? t(heldKey, { words: change.model.rules?.change.words[locale] ?? '' }) : t(heldKey)) : null
  const close = () => flow.actions?.onClose?.()
  const send = () => flow.actions?.onSend?.()
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (step === 'impact' && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !held) {
      event.preventDefault()
      send()
    }
  }
  const footer = change ? <ChangeStepFooter model={change.model} actions={change.actions} held={held} /> : flow.kind === 'ask' ? <AskFooter model={flow.model} actions={flow.actions} held={held} /> : null
  return (
    <>
      <Modal open sheet size="lg" onClose={close} title={t('ask.title', { number: flow.model.number })} subtitle={t(STEP_KEY[step])} footer={footer} closeHeld={flow.model.busy ? t('held.busy') : null}>
        <div className="fw-pord-dialog" onKeyDown={onKey}>
          {change ? <ChangeStep model={change.model} actions={change.actions} /> : flow.kind === 'ask' ? <AskDialogBody model={flow.model} actions={flow.actions} /> : null}
          {flow.model.problem ? <Banner tone="danger" title={t(flow.model.problem)} /> : null}
        </div>
      </Modal>
      {change?.model.discard ? <ChangeDiscard actions={change.actions} /> : null}
    </>
  )
}

function AskFooter({ model, actions, held }: { model: AskDialogModel; actions?: AskDialogActions; held: string | null }) {
  const { t } = useOrderWords()
  if (model.state !== 'ready' || !model.rules) return <Button onClick={() => actions?.onClose?.()}>{t('dialog.close')}</Button>
  if (model.step === 'what')
    return (
      <>
        <Button onClick={() => actions?.onClose?.()}>{t('dialog.cancel')}</Button>
        <Button variant="primary" heldReason={held} onClick={() => actions?.onNext?.()}>
          {t('ask.next')}
        </Button>
      </>
    )
  if (model.step === 'details')
    return (
      <>
        <Button onClick={() => actions?.onBack?.()}>{t('change.back')}</Button>
        <Button variant="primary" heldReason={held} onClick={() => actions?.onReview?.()}>
          {t('ask.review.go')}
        </Button>
      </>
    )
  return (
    <>
      <Button onClick={() => actions?.onBack?.()} heldReason={model.busy ? t('held.busy') : null}>
        {t('change.back')}
      </Button>
      <Button variant="primary" heldReason={held} onClick={() => actions?.onSend?.()}>
        {model.busy ? <Spinner size={14} /> : null} {t('ask.send')}
      </Button>
    </>
  )
}

/** The dialog's body by its step (exported for the tests and the design cases: the Modal draws only in a browser). */
export function AskDialogBody({ model, actions }: { model: AskDialogModel; actions?: AskDialogActions }) {
  const words = useOrderWords()
  if (model.state === 'loading') return <Loading rows={3} height={56} />
  if (model.state === 'error' || !model.rules) return <ReadFailed title={words.t('ask.failed')} onRetry={actions?.onRetry} />
  // F-SA-246: the production asks and the design change have their own steps 2 and 3 here.
  if (model.step === 'what' || model.kind === null || !takesSteps(model.kind)) return <AskWhat model={model} actions={actions} words={words} />
  if (model.kind === 'DESIGN') return model.step === 'details' ? <DesignDetails model={model} rules={model.rules} actions={actions} words={words} /> : <DesignReview model={model} rules={model.rules} actions={actions} words={words} />
  if (model.step === 'details') return <AskDetails model={model} rules={model.rules} kind={model.kind} actions={actions} words={words} />
  return <AskReview model={model} rules={model.rules} kind={model.kind} actions={actions} words={words} />
}

// ── step 1: what ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function AskWhat({ model, actions, words }: { model: AskDialogModel; actions?: AskDialogActions; words: OrderWords }) {
  const { t, locale, day } = words
  const heldText = (choice: AskChoice): string | null => {
    if (!choice.held) return null
    if ('words' in choice.held) return choice.held.words[locale]
    const params = choice.held.params?.day ? { day: day(choice.held.params.day) } : undefined
    return t(choice.held.key, params)
  }
  return (
    <div className="fw-pord-stack">
      <p className="fw-pord-hint">{t('ask.hint')}</p>
      <div className="fw-pord-stack" role="radiogroup" aria-label={t('ask.what')}>
        {model.choices.map((choice) => {
          const held = heldText(choice)
          return (
            <div key={choice.kind} className="fw-pord-stack">
              <RadioCard
                name="ask-kind"
                value={choice.kind}
                checked={model.kind === choice.kind}
                selected={model.kind === choice.kind}
                disabled={!choice.possible}
                onChange={() => actions?.onKind?.(choice.kind)}
                title={t(`ask.kind.${choice.kind}.title`)}
                description={held ?? t(`ask.kind.${choice.kind}.hint`)}
              />
              {choice.waiting ? (
                <div className="fw-pord-request-head">
                  <span className="fw-pord-sub">{choice.waiting.day ? t('ask.waiting', { day: day(choice.waiting.day) }) : t('ask.waitingNoDay')}</span>
                  {choice.waiting.status === 'COUNTERED' ? (
                    <Button asChild size="sm" variant="quiet" className="fw-pord-push">
                      <a href={model.waitingHref}>{t('ask.counter')}</a>
                    </Button>
                  ) : (
                    <Button size="sm" variant="quiet" className="fw-pord-push" heldReason={model.withdrawing === choice.waiting.requestId ? t('held.busy') : model.withdrawHeld} onClick={() => choice.waiting && actions?.onWithdraw?.(choice.waiting.requestId)}>
                      {t('requests.withdraw')}
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
      {/* F-PR-23b (B-PR-27a): a colour is asked in the change, per line, where the style has another colourway; else write to us. */}
      {model.choices.some((choice) => choice.kind === 'CHANGE') ? <p className="fw-pord-sub">{t(model.rules?.lines.some((line) => (line.colourways?.length ?? 0) > 0) ? 'ask.colourPick' : 'ask.colourNote')}</p> : null}
    </div>
  )
}

/** The DS size grid's words for the first part of a ship-what-is-ready. */
function useSplitCopy(t: OrderWords['t']): Partial<SizeGridCopy> {
  const ds = useDsWords()
  return useMemo(
    () => ({
      caption: t('ask.split.caption'),
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

const lineName = (line: ChangeRules['lines'][number], t: OrderWords['t']) => t('change.line', { seq: line.seq, style: line.style?.code ?? '—', colour: line.colourway?.name ?? '' })

// ── B-SA-046d (14-change-flow §2.4 "which lines (with picture)"): a line named with its small picture ──
/** The line's picture as the one picture part reads it (no file id: the portal holds only the small preview's address). */
export function linePictureOf(line: Pick<ChangeRules['lines'][number], 'style' | 'picture'>): RowPicture | null {
  if (!line.picture) return null
  return { styleId: '', styleCode: line.style?.code ?? '', styleName: line.style?.name ?? '', fileId: null, small: line.picture.small !== null }
}

function LineTitle({ line, t }: { line: ChangeRules['lines'][number]; t: OrderWords['t'] }) {
  const name = lineName(line, t)
  return (
    <span className="fw-pord-line-title">
      <RecordPicture source="order" recordId={line.lineId} number={name} picture={linePictureOf(line)} held={line.picture?.small ?? null} size="line" />
      <span>{name}</span>
    </span>
  )
}
// ── end B-SA-046d ──

// ── step 2: the details of a production ask ─────────────────────────────────────────────────────────────────────────────
function AskDetails({ model, rules, kind, actions, words }: { model: AskDialogModel; rules: ChangeRules; kind: ProductionAskKind; actions?: AskDialogActions; words: OrderWords }) {
  const { t, locale, day } = words
  const copy = useSplitCopy(t)
  const draft = model.draft
  const set = (over: Partial<AskDraft>) => actions?.onDraft?.({ ...draft, ...over })
  const line = rules.lines.find((entry) => entry.lineId === draft.lineId) ?? null
  const noteRequired = kind === 'HOLD'
  return (
    <div className="fw-pord-stack">
      <p className="fw-pord-hint">{t(`ask.details.${kind}`)}</p>
      {kind === 'SPLIT_SHIPMENT'
        ? splitLines(rules).map((entry) => (
            <section key={entry.lineId} className="fw-pord-change-line" aria-label={lineName(entry, t)}>
              <h3 className="fw-pord-h3">{lineName(entry, t)}</h3>
              <SizeGridEditor
                layout="auto"
                colours={[{ key: entry.lineId, label: entry.colourway?.name ?? entry.style?.code ?? '—', offered: entry.sizes.filter((size) => size.quantity > 0).map((size) => size.size) }]}
                sizes={entry.sizes.map((size) => ({ key: size.size, label: size.size }))}
                value={{ [entry.lineId]: draft.cells[entry.lineId] ?? {} }}
                onChange={(next) => set({ cells: { ...draft.cells, [entry.lineId]: next[entry.lineId] ?? {} } })}
                issues={entry.sizes.filter((size) => (draft.cells[entry.lineId]?.[size.size] ?? 0) > size.quantity).map((size) => ({ colour: entry.lineId, size: size.size, message: t('ask.split.most', { count: size.quantity }), tone: 'warning' as const }))}
                caption={lineName(entry, t)}
                locale={INTL_LOCALE[locale]}
                copy={copy}
              />
            </section>
          ))
        : null}
      {kind === 'SAMPLE_ROUND' ? (
        <>
          <Field label={t('ask.sample.line')} required>
            <Select value={draft.lineId} onChange={(event) => set({ lineId: event.target.value, sampleKind: '' })}>
              <option value="">{t('ask.sample.linePick')}</option>
              {rules.lines.map((entry) => (
                <option key={entry.lineId} value={entry.lineId}>
                  {lineName(entry, t)}
                </option>
              ))}
            </Select>
          </Field>
          {line ? (
            <div className="fw-pord-stack" role="radiogroup" aria-label={t('ask.sample.kind')}>
              {sampleKindsOf(line).map((entry) => (
                <RadioCard
                  key={entry.sampleKind}
                  name="ask-sample-kind"
                  value={entry.sampleKind}
                  checked={draft.sampleKind === entry.sampleKind}
                  selected={draft.sampleKind === entry.sampleKind}
                  disabled={!entry.verdict.possible}
                  onChange={() => set({ sampleKind: entry.sampleKind })}
                  title={t(`ask.sample.kinds.${entry.sampleKind}`)}
                  description={entry.verdict.possible ? t(`ask.sample.hints.${entry.sampleKind}`) : entry.verdict.code === 'CUT' || entry.verdict.code === 'LEATHER_CUT' ? t(entry.verdict.day ? `ask.verdict.${entry.verdict.code}` : `ask.verdict.${entry.verdict.code}_NO_DAY`, entry.verdict.day ? { day: day(entry.verdict.day) } : undefined) : entry.verdict.words[locale]}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
      {takesDate(kind) ? (
        <div className="fw-pord-fields">
          <Field label={t(`ask.date.${kind}`)} hint={rules.order.promiseDate ? t('ask.date.promise', { date: day(rules.order.promiseDate) }) : t('ask.date.optional')}>
            <DateField value={draft.requestedDate} min={model.today} onChange={(value) => set({ requestedDate: value })} clearable />
          </Field>
        </div>
      ) : null}
      <div className="fw-pord-note">
        <Field label={t(noteRequired ? 'ask.note.why' : 'ask.note.label')} required={noteRequired} hint={t(noteRequired ? 'ask.note.whyHint' : 'ask.note.hint')} error={draft.note.length > MAX_NOTE ? t('ask.problem.long') : undefined}>
          <Textarea value={draft.note} rows={3} maxLength={MAX_NOTE + 200} onChange={(event) => set({ note: event.target.value })} />
        </Field>
      </div>
    </div>
  )
}

// ── step 3: what it means, before Send ──────────────────────────────────────────────────────────────────────────────────
function AskReview({ model, rules, kind, actions, words }: { model: AskDialogModel; rules: ChangeRules; kind: ProductionAskKind; actions?: AskDialogActions; words: OrderWords }) {
  const { t, day } = words
  const body = askBodyOf(kind, rules, model.draft)
  const line = body.lineId ? rules.lines.find((entry) => entry.lineId === body.lineId) ?? null : null
  const items: KeyValueItem[] = [
    { label: t('ask.review.what'), value: t(`ask.kind.${kind}.title`) },
    ...(kind === 'SPLIT_SHIPMENT'
      ? [{ label: t('ask.review.first'), value: splitCells(rules, model.draft).map((cell) => t('ask.review.cell', { seq: rules.lines.find((entry) => entry.lineId === cell.lineId)?.seq ?? '—', size: cell.size, count: cell.quantity })).join(' · ') }]
      : []),
    ...(line ? [{ label: t('ask.sample.line'), value: lineName(line, t) }] : []),
    ...(body.sampleKind ? [{ label: t('ask.sample.kind'), value: t(`ask.sample.kinds.${body.sampleKind}`) }] : []),
    ...(body.requestedDate ? [{ label: t(`ask.date.${kind}`), value: day(body.requestedDate) }] : []),
    ...(body.note ? [{ label: t('ask.note.label'), value: body.note }] : []),
  ]
  return (
    <div className="fw-pord-stack">
      <p className="fw-pord-hint">{t('ask.review.hint')}</p>
      <KeyValue labelCase="sentence" items={items} />
      {model.impact ? <AskImpact model={model.impact} onRetry={actions?.onRetryImpact} /> : null}
      <p className="fw-pord-sub">{t('change.sendKeys')}</p>
    </div>
  )
}

// ── F-SA-246 (sales page plan R6, R3, P21; 14-change-flow §2.4; review OW-8): a design change ──────────────────────────────────
/**
 * Step 2 of a design change: the lines it is for, what to change (their words, required), and up to ten files — from the device
 * (through the order's conversation's upload route: each file is checked by the virus scanner before we open it; while uploads
 * from outside are closed the file's row says the API's sentence) or already on the order. Nothing of another order is offered.
 */
function DesignDetails({ model, rules, actions, words }: { model: AskDialogModel; rules: ChangeRules; actions?: AskDialogActions; words: OrderWords }) {
  const { t } = words
  const draft = model.draft
  const design = model.design ?? null
  const set = (over: Partial<AskDraft>) => actions?.onDraft?.({ ...draft, ...over })
  const pick = (list: readonly string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((entry) => entry !== id))
  return (
    <div className="fw-pord-stack">
      <p className="fw-pord-hint">{t('ask.details.DESIGN')}</p>
      <div className="fw-pord-stack" role="group" aria-label={t('ask.design.lines')}>
        <h3 className="fw-pord-h3">{t('ask.design.lines')}</h3>
        <p className="fw-pord-sub">{t('ask.design.linesHint')}</p>
        {rules.lines.map((line) => {
          const on = draft.lineIds.includes(line.lineId)
          return (
            <CheckboxCard
              key={line.lineId}
              variant="row"
              checked={on}
              selected={on}
              onChange={(event) => set({ lineIds: pick(draft.lineIds, line.lineId, event.target.checked) })}
              title={<LineTitle line={line} t={t} /> /* B-SA-046d */}
              description={t('ask.design.linePieces', { count: line.sizes.reduce((sum, size) => sum + size.quantity, 0) })}
            />
          )
        })}
      </div>
      <div className="fw-pord-note">
        <Field label={t('ask.design.what')} required hint={t('ask.design.whatHint')} error={draft.note.trim().length > MAX_DESIGN_WORDS ? t('ask.design.problem.long') : undefined}>
          <Textarea value={draft.note} rows={5} maxLength={MAX_DESIGN_WORDS + 200} onChange={(event) => set({ note: event.target.value })} />
        </Field>
      </div>
      {/* B-SA-046b (14-change-flow §2.4): the pieces not started yet (the default), or also the pieces already made (rework may cost). */}
      <div className="fw-pord-stack" role="radiogroup" aria-label={t('ask.design.appliesTo.label')}>
        <h3 className="fw-pord-h3">{t('ask.design.appliesTo.label')}</h3>
        {APPLIES_TO_CHOICES.map((choice) => (
          <RadioCard
            key={choice}
            name="ask-design-applies-to"
            value={choice}
            checked={appliesToOf(draft) === choice}
            selected={appliesToOf(draft) === choice}
            onChange={() => set({ appliesTo: choice })}
            title={t(`ask.design.appliesTo.${choice}`)}
            description={t(`ask.design.appliesTo.hint.${choice}`)}
          />
        ))}
      </div>
      <section className="fw-pord-stack" aria-label={t('ask.design.files')}>
        <h3 className="fw-pord-h3">{t('ask.design.files')}</h3>
        <p className="fw-pord-sub">{t('ask.design.filesHint', { max: MAX_DESIGN_FILES })}</p>
        <Banner tone="info" title={t('ask.design.checked')} />
        {design ? (
          <>
            <ComposeFiles model={design.upload} title={false} actions={{ onDrop: (files) => actions?.onUpload?.(files), onRemove: (key) => actions?.onUploadRemove?.(key), onRetry: () => actions?.onUploadRetry?.(), onSend: () => actions?.onUploadRetry?.() }} />
            <h4 className="fw-pord-strong">{t('ask.design.orderFiles')}</h4>
            {design.orderFiles.state === 'loading' ? (
              <Loading rows={1} height={40} />
            ) : design.orderFiles.state === 'error' ? (
              <ReadFailed title={t('ask.design.orderFilesFailed')} onRetry={actions?.onRetryOrderFiles} />
            ) : design.orderFiles.files.length === 0 ? (
              <p className="fw-pord-sub">{t('ask.design.orderFilesNone')}</p>
            ) : (
              <div className="fw-pord-stack" role="group" aria-label={t('ask.design.orderFiles')}>
                {design.orderFiles.files.map((file) => {
                  const on = draft.fileIds.includes(file.id)
                  return (
                    <CheckboxCard
                      key={file.id}
                      variant="row"
                      checked={on}
                      selected={on}
                      onChange={(event) => set({ fileIds: pick(draft.fileIds, file.id, event.target.checked) })}
                      title={file.name}
                      description={file.line !== null ? t('ask.design.fileOnLine', { seq: file.line }) : t('ask.design.fileOnOrder')}
                    />
                  )
                })}
              </div>
            )}
          </>
        ) : (
          <Loading rows={1} height={40} />
        )}
      </section>
    </div>
  )
}

/** Step 3 of a design change: what is asked (lines, their words, the files), then what it means — never a guessed date. */
function DesignReview({ model, rules, actions, words }: { model: AskDialogModel; rules: ChangeRules; actions?: AskDialogActions; words: OrderWords }) {
  const { t } = words
  const design = model.design ?? null
  const body = designBodyOf(rules, model.draft, design?.uploaded ?? [])
  const count = body.fileIds?.length ?? 0
  const items: KeyValueItem[] = [
    { label: t('ask.review.what'), value: t('ask.kind.DESIGN.title') },
    { label: t('ask.design.lines'), value: rules.lines.filter((line) => body.lineIds.includes(line.lineId)).map((line) => lineName(line, t)).join(' · ') },
    { label: t('ask.design.what'), value: body.note },
    // B-SA-046b: which pieces it is for.
    { label: t('ask.design.appliesTo.label'), value: t(`ask.design.appliesTo.${appliesToOf(model.draft)}`) },
    { label: t('ask.design.files'), value: count > 0 ? t('ask.design.review.files', { count }) : t('ask.design.review.noFiles') },
  ]
  return (
    <div className="fw-pord-stack">
      <p className="fw-pord-hint">{t('ask.review.hint')}</p>
      <KeyValue labelCase="sentence" items={items} />
      {design && design.scanning > 0 ? <Banner tone="info" title={t('ask.design.scanningLeft', { count: design.scanning })} /> : null}
      {model.impact ? <AskImpact model={model.impact} onRetry={actions?.onRetryImpact} /> : null}
      <p className="fw-pord-sub">{t('change.sendKeys')}</p>
    </div>
  )
}
// ── end F-SA-246 ──
