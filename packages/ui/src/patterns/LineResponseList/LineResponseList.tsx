'use client'

/**
 * LineResponseList — answer a request line by line (B-W2b-155, design part LineResponseList): a purchase order on its
 * link (links.po) and in the supplier portal (portal.supplier.orders) answer with this one part, lifted from W1's PO link
 * (factory-web links/po-confirm).
 *
 *   <LineResponseList lines={lines} answers={answers} today={today} kinds={[...DEFAULT_LINE_KINDS, 'SUBSTITUTE']}
 *                     onAnswer={(id, draft) => …} onAllAsAsked={() => …} parseQuantity={plainQuantityIt}
 *                     formatDate={day} locale="it-IT" labels={ds.lineResponseList} />
 *
 * - Every line: what (its title, facts, note, tags), the ASKED value beside the ANSWER (in words, with tags for what it
 *   changes — later date, less, two deliveries … — and the reason), then Change and As asked again. A line with no
 *   answer is as asked. A locked line (confirmed before) says so and takes no answer.
 * - "All as asked" puts every line back to as asked in one tap (held, with the words, when every line already is).
 * - Change opens the line's editor: a DS Modal, a bottom sheet on a phone. The asked value, the kinds as radio cards,
 *   the fields of the kind, the reason; Save is held with the first problem once tried, each problem under its field
 *   (`lineResponseListModel.ts` has the rules). Save hands the answer to `onAnswer` (null: as asked again).
 * - The review line before sending ("Your answer: 3 lines as asked · 1 later date.") is a polite status. Sending (their
 *   number, their name, the PDF, Send and Decline) stays the page's: hold its Send with `lineDraftProblems` and say what
 *   it comes to with `lineResponseOutcome`.
 *
 * Data in, events out: no fetch, no money. Every word comes through `labels` (and the DS parts' own labels props).
 */
import { useId, useState } from 'react'
import { Check, PencilLine, RotateCcw } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { Input } from '../../primitives/Input'
import { RadioCard } from '../../primitives/RadioCard'
import { Select } from '../../primitives/Select'
import { Tag } from '../../primitives/Tag'
import { Textarea } from '../../primitives/Textarea'
import type { TextareaLabels } from '../../primitives/TextareaLabels'
import { Banner } from '../../components/Banner'
import { DateField } from '../../components/DateField'
import type { DateFieldLabels } from '../../components/DateFieldLabels'
import { Field } from '../../components/Field'
import { KeyValue } from '../../components/KeyValue'
import { Modal } from '../../components/Modal'
import type { ModalLabels } from '../../components/ModalLabels'
import { LINE_RESPONSE_LIST_LABELS, type LineResponseListLabels } from './LineResponseListLabels'
import {
  DEFAULT_LINE_KINDS,
  LINE_RULE_DEFAULTS,
  firstLineProblem,
  lineAnswerChanges,
  lineDraftFor,
  lineDraftHasProblems,
  lineDraftProblems,
  lineDraftSaved,
  lineResponseChanged,
  lineResponseSummary,
  lineResponseSummaryParts,
  lineSeq,
  type DateProblem,
  type LineAnswerKind,
  type LineDelivery,
  type LineDraft,
  type LineDraftProblems,
  type LineProblemKey,
  type LineRequest,
  type LineRules,
  type QuantityProblem,
} from './lineResponseListModel'
import './lineResponseList.css'

export interface LineResponseListProps {
  lines: readonly LineRequest[]
  /** The answers by line id; a line with none (or AS_ASKED) is as asked. */
  answers: Readonly<Record<string, LineDraft | undefined>>
  /** A line's answer was saved (null: as asked again). */
  onAnswer?: (lineId: string, draft: LineDraft | null) => void
  /** "All as asked": every line back to as asked. Omitted: no such button. */
  onAllAsAsked?: () => void
  /** False: the answers are shown, nothing can be changed. Default true. */
  editable?: boolean
  /** The kinds this request allows (default AS_ASKED, OTHER, SPLIT, CANNOT; the portal adds SUBSTITUTE and CHANGE). */
  kinds?: readonly LineAnswerKind[]
  /** The partner's today (ISO): no date before it. */
  today: string
  /** The host's parse of a typed quantity (its language) → a plain decimal, or null. */
  parseQuantity?: LineRules['parseQuantity']
  /** A chosen ISO day written in the page's language. Default: the ISO day. */
  formatDate?: (iso: string) => string
  /** BCP 47 locale for the date picker's month names ("it-IT"). */
  locale?: string
  /** The review line under the list. Default true. */
  showSummary?: boolean
  maxDaysAhead?: number
  maxReason?: number
  maxSubstitute?: number
  labels?: Partial<LineResponseListLabels>
  modalLabels?: Partial<ModalLabels>
  textareaLabels?: Partial<TextareaLabels>
  dateFieldLabels?: Partial<DateFieldLabels>
  className?: string
  id?: string
}

interface Sheet {
  lineId: string
  draft: LineDraft
  tried: boolean
}

export function LineResponseList({
  lines, answers, onAnswer, onAllAsAsked, editable = true, kinds = DEFAULT_LINE_KINDS, today, parseQuantity, formatDate,
  locale, showSummary = true, maxDaysAhead, maxReason, maxSubstitute, labels, modalLabels, textareaLabels, dateFieldLabels,
  className, id,
}: LineResponseListProps) {
  const lw = mergeLabels(LINE_RESPONSE_LIST_LABELS, labels)
  const rules: LineRules = { today, parseQuantity, maxDaysAhead, maxReason, maxSubstitute }
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const changed = lineResponseChanged(lines, answers)
  const summary = lineResponseSummaryParts(lineResponseSummary(lines, answers, rules))
    .map((part) => lw.summary[part.key](part.count))
    .join(lw.summaryJoin)
  const sheetLine = sheet ? lines.find((line) => line.id === sheet.lineId) : undefined
  const sheetIndex = sheetLine ? lines.indexOf(sheetLine) : -1

  const open = (line: LineRequest) => {
    const previous = answers[line.id]
    const start = previous && previous.kind !== 'AS_ASKED' ? previous : lineDraftFor(line, kinds.includes('OTHER') ? 'OTHER' : 'AS_ASKED')
    setSheet({ lineId: line.id, draft: start, tried: false })
  }
  const save = () => {
    if (!sheet || !sheetLine) return
    if (lineDraftHasProblems(lineDraftProblems(sheetLine, sheet.draft, rules))) {
      setSheet({ ...sheet, tried: true })
      return
    }
    onAnswer?.(sheet.lineId, lineDraftSaved(sheet.draft))
    setSheet(null)
  }

  return (
    <div id={id} className={['nds-lrl', className].filter(Boolean).join(' ')} data-editable={editable ? 'true' : 'false'}>
      {editable && onAllAsAsked ? (
        <div className="nds-lrl-top">
          <Button size="sm" onClick={onAllAsAsked} heldReason={changed ? null : lw.allAsAskedHeld}>
            <Check size={14} aria-hidden /> {lw.allAsAsked}
          </Button>
        </div>
      ) : null}
      <ol className="nds-lrl-lines" aria-label={lw.list}>
        {lines.map((line, index) => (
          <LineRow
            key={line.id}
            line={line}
            seq={lineSeq(line, index)}
            draft={answers[line.id]}
            editable={editable}
            rules={rules}
            formatDate={formatDate}
            lw={lw}
            onChange={() => open(line)}
            onReset={() => onAnswer?.(line.id, null)}
          />
        ))}
      </ol>
      {showSummary && summary ? (
        <p className="nds-lrl-review" role="status">
          {lw.review(summary)}
        </p>
      ) : null}
      {editable && sheet && sheetLine ? (
        <LineEditor
          line={sheetLine}
          seq={lineSeq(sheetLine, sheetIndex)}
          sheet={sheet}
          kinds={kinds}
          rules={rules}
          locale={locale}
          lw={lw}
          modalLabels={modalLabels}
          textareaLabels={textareaLabels}
          dateFieldLabels={dateFieldLabels}
          onDraft={(draft) => setSheet({ ...sheet, draft })}
          onSave={save}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </div>
  )
}

// ---- one line ---------------------------------------------------------------------------------------------------------------

interface RowProps {
  line: LineRequest
  seq: string
  draft: LineDraft | undefined
  editable: boolean
  rules: LineRules
  formatDate?: (iso: string) => string
  lw: LineResponseListLabels
  onChange: () => void
  onReset: () => void
}

function LineRow({ line, seq, draft, editable, rules, formatDate, lw, onChange, onReset }: RowProps) {
  const locked = line.locked !== undefined && line.locked !== false
  const asAsked = !draft || draft.kind === 'AS_ASKED'
  return (
    <li className="nds-lrl-line" data-kind={asAsked ? 'AS_ASKED' : draft.kind} data-locked={locked ? 'true' : undefined}>
      <div className="nds-lrl-what">
        <span className="nds-lrl-seq">{lw.line(seq)}</span>
        <strong className="nds-lrl-title">{line.title}</strong>
        {line.tags?.length ? (
          <span className="nds-lrl-tags">
            {line.tags.map((tag, i) => (
              <Tag key={i} tone={tag.tone ?? 'neutral'}>
                {tag.label}
              </Tag>
            ))}
          </span>
        ) : null}
        {line.details?.map((detail, i) => (
          <span key={i} className="nds-lrl-sub">
            {detail}
          </span>
        ))}
        {line.note ? <span className="nds-lrl-sub">{line.note}</span> : null}
      </div>
      <div className="nds-lrl-asked">
        <span className="nds-lrl-label">{lw.asked}</span>
        <span className="nds-lrl-value">{lw.askedValue(line.asked.quantity, line.asked.unit, line.asked.dateText)}</span>
      </div>
      <div className="nds-lrl-answer">
        <span className="nds-lrl-label">{lw.yourAnswer}</span>
        {locked ? (
          <span className="nds-lrl-value nds-lrl-locked">{typeof line.locked === 'string' ? line.locked : lw.locked}</span>
        ) : (
          <LineAnswerWords line={line} draft={draft} rules={rules} formatDate={formatDate} lw={lw} />
        )}
      </div>
      {editable && !locked ? (
        <div className="nds-lrl-actions">
          <Button size="sm" onClick={onChange} aria-label={lw.changeAria(seq)}>
            <PencilLine size={14} aria-hidden /> {lw.change}
          </Button>
          {!asAsked ? (
            <Button size="sm" variant="quiet" onClick={onReset} aria-label={lw.asAskedAgainAria(seq)}>
              <RotateCcw size={14} aria-hidden /> {lw.asAskedAgain}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/** A line's answer in words, with tags for what it changes and the reason. */
export function LineAnswerWords({ line, draft, rules, formatDate, lw }: { line: LineRequest; draft: LineDraft | undefined; rules: Pick<LineRules, 'parseQuantity'>; formatDate?: (iso: string) => string; lw: LineResponseListLabels }) {
  if (!draft || draft.kind === 'AS_ASKED') return <span className="nds-lrl-value">{lw.answerAsAsked}</span>
  const day = (iso: string | undefined) => (iso && iso.trim() !== '' ? (formatDate ? formatDate(iso.trim()) : iso.trim()) : line.asked.dateText)
  const qty = (typed: string | undefined) => (typed && typed.trim() !== '' ? typed.trim() : line.asked.quantity)
  let words: string
  switch (draft.kind) {
    case 'OTHER':
      words = lw.answerOther(qty(draft.quantity), line.asked.unit, day(draft.date))
      break
    case 'SPLIT': {
      const [a, b] = draft.deliveries ?? [{ quantity: '', date: '' }, { quantity: '', date: '' }]
      words = lw.answerSplit(lw.delivery(qty(a.quantity), line.asked.unit, day(a.date)), lw.delivery(qty(b.quantity), line.asked.unit, day(b.date)))
      break
    }
    case 'CANNOT':
      words = lw.answerCannot
      break
    case 'SUBSTITUTE': {
      const chosen = draft.substituteId ? line.substitutes?.find((s) => s.id === draft.substituteId)?.label : undefined
      const what = [chosen, draft.substitute?.trim()].filter((part): part is string => !!part).join(' — ')
      words = lw.answerSubstitute(what, lw.delivery(qty(draft.quantity), line.asked.unit, day(draft.date)))
      break
    }
    case 'CHANGE':
      words = lw.answerChange
      break
  }
  const changes = lineAnswerChanges(line, draft, rules)
  const reason = draft.reason?.trim() ?? ''
  return (
    <span className="nds-lrl-value">
      <span className="nds-lrl-strong">{words}</span>
      {changes.length ? (
        <span className="nds-lrl-tags">
          {changes.map((change) => (
            <Tag key={change} tone={change === 'CANNOT' ? 'danger' : 'warning'}>
              {lw.changes[change]}
            </Tag>
          ))}
        </span>
      ) : null}
      {reason ? <span className="nds-lrl-sub">{draft.kind === 'CHANGE' ? lw.changeSaid(reason) : lw.reason(reason)}</span> : null}
    </span>
  )
}

// ---- the line's editor --------------------------------------------------------------------------------------------------------

/** A problem key → its words. */
export function lineProblemWords(key: LineProblemKey | null | undefined, lw: LineResponseListLabels, rules: Pick<LineRules, 'maxReason' | 'maxSubstitute'> = {}, kind?: LineAnswerKind): string | null {
  switch (key) {
    case null:
    case undefined:
      return null
    case 'whole.nothing':
      return lw.problems.nothing
    case 'whole.same':
      return lw.problems.same
    case 'whole.sameDay':
      return lw.problems.sameDay
    case 'quantity.number':
      return lw.problems.quantityNumber
    case 'quantity.positive':
      return lw.problems.quantityPositive
    case 'date.missing':
      return lw.problems.dateMissing
    case 'date.past':
      return lw.problems.datePast
    case 'date.far':
      return lw.problems.dateFar
    case 'reason.missing':
      return kind === 'CHANGE' ? lw.problems.changeMissing : lw.problems.reasonMissing
    case 'reason.long':
      return lw.problems.reasonLong(rules.maxReason ?? LINE_RULE_DEFAULTS.maxReason)
    case 'substitute.missing':
      return lw.problems.substituteMissing
    case 'substitute.long':
      return lw.problems.substituteLong(rules.maxSubstitute ?? LINE_RULE_DEFAULTS.maxSubstitute)
  }
}

interface EditorProps {
  line: LineRequest
  seq: string
  sheet: Sheet
  kinds: readonly LineAnswerKind[]
  rules: LineRules
  locale?: string
  lw: LineResponseListLabels
  modalLabels?: Partial<ModalLabels>
  textareaLabels?: Partial<TextareaLabels>
  dateFieldLabels?: Partial<DateFieldLabels>
  onDraft: (draft: LineDraft) => void
  onSave: () => void
  onClose: () => void
}

function LineEditor({ line, seq, sheet, kinds, rules, locale, lw, modalLabels, textareaLabels, dateFieldLabels, onDraft, onSave, onClose }: EditorProps) {
  const formId = `${useId()}-lrl-sheet`
  const problems: LineDraftProblems = sheet.tried ? lineDraftProblems(line, sheet.draft, rules) : {}
  const first = sheet.tried ? lineProblemWords(firstLineProblem(problems), lw, rules, sheet.draft.kind) : null
  return (
    <Modal
      open
      sheet
      size="sm"
      onClose={onClose}
      title={lw.sheetTitle(seq)}
      subtitle={line.title}
      labels={modalLabels}
      footer={
        <>
          <Button onClick={onClose}>{lw.cancel}</Button>
          <Button variant="primary" type="submit" form={formId} heldReason={first}>
            {lw.save}
          </Button>
        </>
      }
    >
      <LineAnswerForm
        formId={formId}
        line={line}
        draft={sheet.draft}
        problems={problems}
        kinds={kinds}
        rules={rules}
        locale={locale}
        lw={lw}
        textareaLabels={textareaLabels}
        dateFieldLabels={dateFieldLabels}
        onDraft={onDraft}
        onSave={onSave}
      />
    </Modal>
  )
}

export interface LineAnswerFormProps {
  formId: string
  line: LineRequest
  draft: LineDraft
  /** The problems to show (after the first Save try; empty before). */
  problems: LineDraftProblems
  kinds: readonly LineAnswerKind[]
  rules: LineRules
  locale?: string
  lw: LineResponseListLabels
  textareaLabels?: Partial<TextareaLabels>
  dateFieldLabels?: Partial<DateFieldLabels>
  onDraft: (draft: LineDraft) => void
  onSave: () => void
}

/** The editor's body: the asked value, the kinds, the kind's fields and the reason (drawn inside the Modal). */
export function LineAnswerForm({ formId, line, draft, problems, kinds, rules, locale, lw, textareaLabels, dateFieldLabels, onDraft, onSave }: LineAnswerFormProps) {
  const name = `${useId()}-kind`
  const set = (patch: Partial<LineDraft>) => onDraft({ ...draft, ...patch })
  const deliveries: readonly [LineDelivery, LineDelivery] = draft.deliveries ?? [{ quantity: '', date: line.asked.date }, { quantity: '', date: '' }]
  const setPart = (index: 0 | 1, patch: Partial<LineDelivery>) => {
    const parts: [LineDelivery, LineDelivery] = [deliveries[0], deliveries[1]]
    parts[index] = { ...parts[index], ...patch }
    set({ deliveries: parts })
  }
  const qWords = (problem: QuantityProblem | undefined) => (problem ? lineProblemWords(`quantity.${problem}`, lw, rules) : undefined)
  const dWords = (problem: DateProblem | undefined) => (problem ? lineProblemWords(`date.${problem}`, lw, rules) : undefined)
  const quantityField = (value: string, onChange: (value: string) => void, error: string | null | undefined, hint?: string) => (
    <Field label={lw.quantity(line.asked.unit)} error={error ?? undefined} hint={hint}>
      <Input value={value} onChange={(event) => onChange(event.target.value)} inputMode="decimal" autoComplete="off" suffix={line.asked.unit} />
    </Field>
  )
  const dateField = (value: string, onChange: (value: string) => void, error: string | null | undefined, label: string) => (
    <Field label={label} error={error ?? undefined}>
      <DateField value={value} onChange={onChange} locale={locale} min={rules.today} clearable={false} ariaLabel={label} labels={dateFieldLabels} />
    </Field>
  )
  const reasonRequired = draft.kind !== 'SUBSTITUTE'
  const reasonLabel = draft.kind === 'CHANGE' ? lw.changeField : reasonRequired ? lw.reasonField : lw.reasonOptional
  const reasonError = problems.reason ? lineProblemWords(`reason.${problems.reason}`, lw, rules, draft.kind) : undefined
  return (
    <form
      id={formId}
      className="nds-lrl-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      <KeyValue dense labelCase="sentence" items={[{ label: lw.asked, value: lw.askedValue(line.asked.quantity, line.asked.unit, line.asked.dateText) }]} />
      <div className="nds-lrl-kinds" role="radiogroup" aria-label={lw.kind}>
        <span className="nds-lrl-label" aria-hidden>
          {lw.kind}
        </span>
        {kinds.map((kind) => (
          <RadioCard
            key={kind}
            name={name}
            value={kind}
            checked={draft.kind === kind}
            selected={draft.kind === kind}
            onChange={() => onDraft(lineDraftFor(line, kind, draft))}
            title={lw.kinds[kind]}
            description={kind === 'AS_ASKED' ? lw.askedValue(line.asked.quantity, line.asked.unit, line.asked.dateText) : lw.kindHints[kind]}
          />
        ))}
      </div>
      {draft.kind === 'OTHER' ? (
        <div className="nds-lrl-pair">
          {quantityField(draft.quantity ?? '', (quantity) => set({ quantity }), qWords(problems.quantity))}
          {dateField(draft.date ?? '', (date) => set({ date }), dWords(problems.date), lw.date)}
        </div>
      ) : null}
      {draft.kind === 'SPLIT'
        ? ([0, 1] as const).map((index) => (
            <fieldset key={index} className="nds-lrl-delivery">
              <legend className="nds-lrl-label">{index === 0 ? lw.first : lw.second}</legend>
              <div className="nds-lrl-pair">
                {quantityField(deliveries[index].quantity, (quantity) => setPart(index, { quantity }), qWords(problems.deliveries?.[index]?.quantity))}
                {dateField(
                  deliveries[index].date,
                  (date) => setPart(index, { date }),
                  dWords(problems.deliveries?.[index]?.date) ?? (index === 1 && problems.whole === 'sameDay' ? lw.problems.sameDay : undefined),
                  lw.date,
                )}
              </div>
            </fieldset>
          ))
        : null}
      {draft.kind === 'SUBSTITUTE' ? (
        <>
          {line.substitutes?.length ? (
            <Field label={lw.substituteChoice}>
              <Select value={draft.substituteId ?? ''} onChange={(event) => set({ substituteId: event.target.value })}>
                <option value="">{lw.substituteChoiceNone}</option>
                {line.substitutes.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label={lw.substitute} hint={lw.substituteHint} error={problems.substitute ? (lineProblemWords(`substitute.${problems.substitute}`, lw, rules) ?? undefined) : undefined} required={!line.substitutes?.length}>
            <Textarea value={draft.substitute ?? ''} onChange={(event) => set({ substitute: event.target.value })} rows={2} honourRows labels={textareaLabels} />
          </Field>
          <div className="nds-lrl-pair">
            {quantityField(draft.quantity ?? '', (quantity) => set({ quantity }), qWords(problems.quantity), lw.substituteKeep)}
            {dateField(draft.date ?? '', (date) => set({ date }), dWords(problems.date), lw.date)}
          </div>
        </>
      ) : null}
      {draft.kind !== 'AS_ASKED' ? (
        <Field label={reasonLabel} hint={lw.reasonHint} error={reasonError ?? undefined} required={reasonRequired}>
          <Textarea value={draft.reason} onChange={(event) => set({ reason: event.target.value })} rows={2} honourRows limit={rules.maxReason ?? LINE_RULE_DEFAULTS.maxReason} labels={textareaLabels} />
        </Field>
      ) : null}
      {problems.whole && problems.whole !== 'sameDay' ? <Banner tone="warning" title={lineProblemWords(`whole.${problems.whole}`, lw, rules)} /> : null}
    </form>
  )
}
