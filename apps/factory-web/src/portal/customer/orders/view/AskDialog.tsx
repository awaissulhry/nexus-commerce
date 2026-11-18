'use client'

import { useMemo, type KeyboardEvent } from 'react'
import { Banner, Field, KeyValue, type KeyValueItem } from '@nexus/ui/components'
import { SizeGridEditor, type SizeGridCopy } from '@nexus/ui/grid/size-grid/index'
import { Button, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { ChangeRules } from '../api'
import { askBodyOf, isProductionKind, sampleKindsOf, splitCells, splitLines, takesDate, type AskChoice, type AskDraft, type AskKind } from '../ask-model'
import { MAX_NOTE } from '../model'
import { useOrderWords, type OrderWords } from '../words'
import { AskImpact, type AskImpactModel } from './AskImpact'
import { Loading, ReadFailed } from './parts'

/**
 * F-PR-13 — the portal Ask dialog (production plan §3, §5; 06-tree B.2 P-ORD-ask; design: a DS Modal, a full-screen sheet on a
 * phone): step 1 what (change, cancel, and the production asks the customer's limits open — make it urgent, pause, resume, ship
 * what is ready, another sample), step 2 the details of a production ask, step 3 what it means before Send (AskImpact). A change
 * and a cancel go on in their own pop-ups (the size grid, the lines and reasons), each with the same step 3. A kind whose request
 * waits is not asked twice: Withdraw it here, or answer our counter-offer in Waiting for you. Every button that cannot act says
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
}

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
}

const STEP_KEY = { what: 'ask.step.what', details: 'ask.step.details', impact: 'ask.step.impact' } as const

export function AskDialog({ model, actions }: { model: AskDialogModel; actions?: AskDialogActions }) {
  const { t } = useOrderWords()
  const held = model.held ? t(model.held) : null
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (model.step === 'impact' && event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !held) {
      event.preventDefault()
      actions?.onSend?.()
    }
  }
  const footer =
    model.state !== 'ready' || !model.rules ? (
      <Button onClick={() => actions?.onClose?.()}>{t('dialog.close')}</Button>
    ) : model.step === 'what' ? (
      <>
        <Button onClick={() => actions?.onClose?.()}>{t('dialog.cancel')}</Button>
        <Button variant="primary" heldReason={held} onClick={() => actions?.onNext?.()}>
          {t('ask.next')}
        </Button>
      </>
    ) : model.step === 'details' ? (
      <>
        <Button onClick={() => actions?.onBack?.()}>{t('change.back')}</Button>
        <Button variant="primary" heldReason={held} onClick={() => actions?.onReview?.()}>
          {t('ask.review.go')}
        </Button>
      </>
    ) : (
      <>
        <Button onClick={() => actions?.onBack?.()} heldReason={model.busy ? t('held.busy') : null}>
          {t('change.back')}
        </Button>
        <Button variant="primary" heldReason={held} onClick={() => actions?.onSend?.()}>
          {model.busy ? <Spinner size={14} /> : null} {t('ask.send')}
        </Button>
      </>
    )
  return (
    <Modal open sheet size="lg" onClose={() => actions?.onClose?.()} title={t('ask.title', { number: model.number })} subtitle={t(STEP_KEY[model.step])} footer={footer} closeHeld={model.busy ? t('held.busy') : null}>
      <div className="fw-pord-dialog" onKeyDown={onKey}>
        <AskDialogBody model={model} actions={actions} />
        {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
      </div>
    </Modal>
  )
}

/** The dialog's body by its step (exported for the tests and the design cases: the Modal draws only in a browser). */
export function AskDialogBody({ model, actions }: { model: AskDialogModel; actions?: AskDialogActions }) {
  const words = useOrderWords()
  if (model.state === 'loading') return <Loading rows={3} height={56} />
  if (model.state === 'error' || !model.rules) return <ReadFailed title={words.t('ask.failed')} onRetry={actions?.onRetry} />
  if (model.step === 'what' || model.kind === null || !isProductionKind(model.kind)) return <AskWhat model={model} actions={actions} words={words} />
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

// ── step 2: the details of a production ask ─────────────────────────────────────────────────────────────────────────────
function AskDetails({ model, rules, kind, actions, words }: { model: AskDialogModel; rules: ChangeRules; kind: Exclude<AskKind, 'CHANGE' | 'CANCEL'>; actions?: AskDialogActions; words: OrderWords }) {
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
function AskReview({ model, rules, kind, actions, words }: { model: AskDialogModel; rules: ChangeRules; kind: Exclude<AskKind, 'CHANGE' | 'CANCEL'>; actions?: AskDialogActions; words: OrderWords }) {
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
