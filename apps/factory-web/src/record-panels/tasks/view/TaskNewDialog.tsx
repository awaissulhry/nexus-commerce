'use client'

import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { Plus } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../i18n'
import type { PanelRead } from '../../model'
import { CHECKLIST_MAX, draftProblem, emptyDraft, type Assignable, type TaskDraft } from '../model'
import '../tasks.css'
// ---- F-SA-281: the N-records mode (one task on each record, POST /tasks/batch) ----
import { CheckCircle2, XCircle } from 'lucide-react'
import { batchHeld, batchReceipt, nextWorkingDay, withoutSupervisor, type BatchAnswer, type BatchAssignee, type BatchRecord } from '../model'
// ---- end F-SA-281
import Link from 'next/link' // F-CL-104: the receipt's names as doors
import { formatDate } from '../../../lib/i18n/format' // F-CL-104
import { batchWordOf } from '../model' // F-CL-104

export interface TaskNewDialogProps {
  /** The record it is on ("New task on Q-2026-0142"); null: a task of its own. */
  recordLabel: string | null
  /** Who may be given it (GET /tasks/assignees). */
  people: PanelRead<readonly Assignable[]>
  /** The person (the task is theirs unless they choose someone else). */
  me: string | null
  /** Why making it is held now, in words (offline, no right), or null. */
  held?: string | null
  busy?: boolean
  /** Design fixtures: the fields filled at once. */
  initial?: Partial<TaskDraft>
  /** Resolves true when it was made (the dialog closes itself then). */
  onCreate?: (draft: TaskDraft) => Promise<boolean> | void
  onRetryPeople?: () => void
  onClose: () => void
  /**
   * F-SA-281: many records at once ("Add task to N…"): one task on each (one batch), Assign to each record's supervisor (the default) or
   * one person of `people`; title, due (the next working day), note; a check line names the records with no supervisor; Send answers
   * with the receipt ("4 tasks made · 1 left out (…)"). The single mode's checklist is not offered (the batch has none).
   */
  batch?: {
    readonly records: readonly BatchRecord[]
    readonly today: string
    readonly onSend: (draft: TaskDraft, assignee: BatchAssignee) => Promise<BatchAnswer | null>
    // ---- F-CL-104 (customers list 13-backend §8.4, settle T12; the shape agreed with the Quotes & incoming lane): four additive
    // options, each optional — absent (null), the window reads and acts exactly as before (the Orders sheet is unchanged).
    /**
     * The record-noun words from the host's catalogue (`ns`, keys under `prefix`): title, assigneeHint, supervisor, noSupervisor,
     * where, held.none, held.tooMany (plus namesOther.* with `namesOther`, made / due with `hrefOf`); else `home-tasks` batch.*.
     */
    readonly words?: { readonly ns: string; readonly prefix: string } | null
    /**
     * The names of the ticked records the title or note names (R-47: one line never names two customers). With names and two
     * records or more, Make is held with words until the person ticks "This text names no other …" (the host's words).
     */
    readonly namesOther?: ((text: string) => readonly string[]) | null
    /** A record's page (its thread open): the receipt's names become doors, and the made ones are listed too. */
    readonly hrefOf?: ((record: { readonly type: string; readonly id: string }) => string | null) | null
    /** Who Assign to starts on: the person ('me') or each record's supervisor ('supervisor'); null: today's rule (the supervisor). */
    readonly defaultAssignee?: 'me' | 'supervisor' | null
    // ---- end F-CL-104
  } | null
}

/** "Nobody yet" in the assignee list (the API's null). */
const NOBODY = '__nobody__'

/**
 * New task (design shell.panels popup task-new "New task on Q-2026-0142" and home.tasks popup task-new; COL-037): a title,
 * who it is for (the person by default; only people who may keep it here and read its record are offered), a due day,
 * the checklist (one item per line) and a description. ⌘Enter / Ctrl Enter makes it; Esc closes. One view for a record's
 * panels and for My tasks: it draws what its host gives it and fetches nothing.
 */
export function TaskNewDialog(props: TaskNewDialogProps) {
  const hostWords = props.batch?.words?.ns ?? null // F-CL-104: the host's catalogue for its record-noun words
  return (
    <WithMessages namespaces={props.batch ? ['records', 'home-tasks', ...(hostWords ? [hostWords] : [])] /* F-SA-281 */ : ['records']}>
      {props.batch ? <BatchDialog {...props} batch={props.batch} /> : <Dialog {...props} />}
    </WithMessages>
  )
}

function Dialog({ recordLabel, people, me, held = null, busy = false, initial, onCreate, onRetryPeople, onClose }: TaskNewDialogProps) {
  const t = useT('records')
  const locale = useLocale()
  const [draft, setDraft] = useState<TaskDraft>({ ...emptyDraft(me), ...initial })
  const titleId = useId()
  useEffect(() => setDraft((current) => (current.assigneeId === null && current.title === '' && me ? { ...current, assigneeId: me } : current)), [me])
  const set = (change: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...change }))
  const problem = draftProblem(draft)
  const heldText = held ? held : busy ? t('tasks.held.busy') : problem ? t(problem.key, problem.params) : null
  const create = () => {
    if (heldText || !onCreate) return
    void Promise.resolve(onCreate(draft)).then((made) => {
      if (made !== false) onClose()
    })
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      create()
    }
  }
  const list = people.status === 'ready' ? people.data : []
  const mine = list.find((person) => person.me) ?? null
  const others = list.filter((person) => !person.me)

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={recordLabel ? t('tasks.new.titleOn', { record: recordLabel }) : t('tasks.new.title')}
      footer={
        <span className="fw-rtask-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('tasks.new.cancel')}
          </Button>
          <Button variant="primary" heldReason={heldText} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            <Plus size={14} aria-hidden /> {t('tasks.new.create')}
          </Button>
        </span>
      }
    >
      <div className="fw-rtask-form" onKeyDown={onKey}>
        <Field label={t('tasks.new.field.title')} required htmlFor={titleId}>
          <Input id={titleId} value={draft.title} onChange={(event) => set({ title: event.target.value })} autoFocus maxLength={400} placeholder={t('tasks.new.field.titlePlaceholder')} />
        </Field>
        <div className="fw-rtask-form-row">
          <Field label={t('tasks.new.field.assignee')} hint={t(recordLabel ? 'tasks.new.field.assigneeHintRecord' : 'tasks.new.field.assigneeHint')}>
            {people.status === 'loading' ? (
              <Skeleton height={32} />
            ) : people.status === 'error' ? (
              <Banner tone="danger" title={t(people.problem)} action={onRetryPeople ? <Button size="sm" onClick={onRetryPeople}>{t('panels.retry')}</Button> : undefined} />
            ) : (
              <Select value={draft.assigneeId ?? NOBODY} onChange={(event) => set({ assigneeId: event.target.value === NOBODY ? null : event.target.value })}>
                {mine && <option value={mine.id}>{t('tasks.new.field.me', { name: mine.name })}</option>}
                {others.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
                <option value={NOBODY}>{t('tasks.new.field.nobody')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('tasks.new.field.due')} hint={t('tasks.new.field.dueHint')}>
            <DateField value={draft.dueDate} onChange={(value) => set({ dueDate: value })} locale={INTL_LOCALE[locale]} clearable clearLabel={t('tasks.new.field.dueClear')} ariaLabel={t('tasks.new.field.due')} />
          </Field>
        </div>
        <Field label={t('tasks.new.field.checklist')} hint={t('tasks.new.field.checklistHint', { max: CHECKLIST_MAX })}>
          <Textarea value={draft.checklist} onChange={(event) => set({ checklist: event.target.value })} rows={3} />
        </Field>
        <Field label={t('tasks.new.field.description')}>
          <Textarea value={draft.description} onChange={(event) => set({ description: event.target.value })} rows={3} />
        </Field>
      </div>
    </Modal>
  )
}

// ---- F-SA-281 (sales page plan N5, pick P10; 11-customer-page §3.9): the N-records mode ----------------------------------------

/** The value of "Each record's supervisor" in the Assign to list. */
const SUPERVISOR = '__supervisor__'
/** At most this many record labels are listed; the rest are counted. */
const LISTED = 8

function BatchDialog({ people, held = null, busy = false, onRetryPeople, onClose, batch }: TaskNewDialogProps & { batch: NonNullable<TaskNewDialogProps['batch']> }) {
  const t = useT('records')
  const h = useT('home-tasks')
  const words = batch.words ?? null
  const host = useT(words?.ns ?? 'home-tasks') // F-CL-104
  /** A `batch.*` word: the host's own noun when it gives one (F-CL-104), else home-tasks'. */
  const w = (key: string, params?: Readonly<Record<string, string | number>>) => {
    const word = batchWordOf(key, words)
    return word.ns === 'home-tasks' ? h(word.key, params) : host(word.key, params)
  }
  const locale = useLocale()
  const titleId = useId()
  const [draft, setDraft] = useState<TaskDraft>({ ...emptyDraft(null), dueDate: nextWorkingDay(batch.today) })
  const [assignee, setAssignee] = useState<BatchAssignee>({ kind: 'SUPERVISOR' })
  const [sending, setSending] = useState(false)
  const [answer, setAnswer] = useState<BatchAnswer | null>(null)
  // ---- F-CL-104: Assign to starts on the person when the host asks (until the person picks); the R-47 check of the text.
  const [picked, setPicked] = useState(false)
  useEffect(() => {
    if (batch.defaultAssignee !== 'me' || picked || people.status !== 'ready') return
    const mine = people.data.find((person) => person.me)
    if (mine) setAssignee({ kind: 'PERSON', userId: mine.id })
  }, [batch.defaultAssignee, picked, people])
  const named = batch.namesOther && words && batch.records.length >= 2 ? batch.namesOther(`${draft.title}\n${draft.description}`) : []
  const namedKey = named.join('\n')
  const [noOther, setNoOther] = useState(false)
  useEffect(() => setNoOther(false), [namedKey])
  const namesHeld = named.length > 0 && !noOther && words ? host(`${words.prefix}.namesOther.held`) : null
  // ---- end F-CL-104
  const set = (change: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...change }))
  const records = batch.records
  const missing = assignee.kind === 'SUPERVISOR' ? withoutSupervisor(records) : []
  const problem = batchHeld(draft, assignee, records)
  const heldText = held ? held : busy || sending ? t('tasks.held.busy') : problem ? (problem.key.startsWith('batch.') ? w(problem.key.slice('batch.'.length), problem.params) : t(problem.key, problem.params)) : namesHeld
  const send = () => {
    if (heldText || answer) return
    setSending(true)
    void batch.onSend(draft, assignee).then((done) => {
      setSending(false)
      if (done) setAnswer(done)
    })
  }
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      send()
    }
  }
  const list = people.status === 'ready' ? people.data : []
  const labels = records.slice(0, LISTED).map((record) => record.label).join(', ')
  const receipt = answer ? batchReceipt(answer, locale === 'en' ? 'en' : 'it') : null
  // F-CL-104: with `hrefOf` the receipt names every record as a door — the made ones (for whom, due when) and the left-out ones (why).
  const doors = answer && batch.hrefOf ? receiptDoorsOf(answer, records, batch.hrefOf, locale === 'en' ? 'en' : 'it') : null
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={w('title', { count: records.length })}
      footer={
        <span className="fw-rtask-buttons">
          <Button variant="secondary" onClick={onClose}>
            {receipt ? h('batch.close') : t('tasks.new.cancel')}
          </Button>
          {!receipt && (
            <Button variant="primary" heldReason={heldText} onClick={send} aria-keyshortcuts="Meta+Enter Control+Enter">
              <Plus size={14} aria-hidden /> {h('batch.send', { count: records.length })}
            </Button>
          )}
        </span>
      }
    >
      {receipt ? (
        <div className="fw-rtask-form" role="status">
          <Banner tone={receipt.left === 0 ? 'success' : 'warning'} title={receipt.left === 0 ? h('batch.made', { count: receipt.made }) : h('batch.receipt', { made: receipt.made, left: receipt.left })} />
          {doors && words ? (
            <ul className="fw-rtask-receipt">
              {doors.map((line) => (
                <li key={line.id}>
                  {line.made ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}{' '}
                  {line.href ? (
                    <Link href={line.href} target="_blank" rel="noopener noreferrer">
                      {line.label}
                    </Link>
                  ) : (
                    line.label
                  )}
                  {': '}
                  {line.made ? [host(`${words.prefix}.made`, { name: line.assignee ?? '—' }), ...(line.due ? [host(`${words.prefix}.due`, { date: formatDate(line.due, { locale }) })] : [])].join(' · ') : line.why}
                </li>
              ))}
            </ul>
          ) : receipt.lines.length > 0 && (
            <ul className="fw-rtask-receipt">
              {receipt.lines.map((line) => (
                <li key={line}>
                  <XCircle size={14} aria-hidden /> {line}
                </li>
              ))}
            </ul>
          )}
          {receipt.made > 0 && (
            <p className="fw-rtask-hint">
              <CheckCircle2 size={14} aria-hidden /> {w('where')}
            </p>
          )}
        </div>
      ) : (
        <div className="fw-rtask-form" onKeyDown={onKey}>
          <p className="fw-rtask-hint">
            {labels}
            {records.length > LISTED ? ` ${h('batch.more', { count: records.length - LISTED })}` : ''}
          </p>
          <Field label={t('tasks.new.field.title')} required htmlFor={titleId}>
            <Input id={titleId} value={draft.title} onChange={(event) => set({ title: event.target.value })} autoFocus maxLength={400} placeholder={t('tasks.new.field.titlePlaceholder')} />
          </Field>
          <div className="fw-rtask-form-row">
            <Field label={h('batch.assignee')} hint={w('assigneeHint')}>
              {people.status === 'loading' ? (
                <Skeleton height={32} />
              ) : people.status === 'error' ? (
                <Banner tone="danger" title={t(people.problem)} action={onRetryPeople ? <Button size="sm" onClick={onRetryPeople}>{t('panels.retry')}</Button> : undefined} />
              ) : (
                <Select
                  value={assignee.kind === 'SUPERVISOR' ? SUPERVISOR : assignee.userId}
                  onChange={(event) => {
                    setPicked(true) // F-CL-104
                    setAssignee(event.target.value === SUPERVISOR ? { kind: 'SUPERVISOR' } : { kind: 'PERSON', userId: event.target.value })
                  }}
                >
                  <option value={SUPERVISOR}>{w('supervisor')}</option>
                  {list.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.me ? t('tasks.new.field.me', { name: person.name }) : person.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('tasks.new.field.due')} hint={h('batch.dueHint')}>
              <DateField value={draft.dueDate} onChange={(value) => set({ dueDate: value })} locale={INTL_LOCALE[locale]} clearable clearLabel={t('tasks.new.field.dueClear')} ariaLabel={t('tasks.new.field.due')} />
            </Field>
          </div>
          {missing.length > 0 && <Banner tone="warning" title={w('noSupervisor', { count: missing.length })}>{missing.slice(0, LISTED).map((record) => record.label).join(', ')}</Banner>}
          <Field label={h('batch.note')}>
            <Textarea value={draft.description} onChange={(event) => set({ description: event.target.value })} rows={3} />
          </Field>
          {named.length > 0 && words && (
            // F-CL-104 (R-47): the text names a ticked record; Make waits for the person's word that it names no other.
            <Banner tone="warning" title={host(`${words.prefix}.namesOther.warn`, { names: named.join(', ') })}>
              <Checkbox checked={noOther} onChange={(event) => setNoOther(event.target.checked)} label={host(`${words.prefix}.namesOther.tick`)} />
            </Banner>
          )}
        </div>
      )}
    </Modal>
  )
}
// ---- end F-SA-281

// ---- F-CL-104: the receipt with doors (a host gave `hrefOf`) ---------------------------------------------------------------------
interface ReceiptDoor {
  readonly id: string
  readonly label: string
  readonly href: string | null
  readonly made: boolean
  readonly assignee: string | null
  readonly due: string | null
  readonly why: string
}

/** Every record of the batch in the receipt: made (for whom, due when) or left out (why, in the API's words of the page's language). */
function receiptDoorsOf(answer: BatchAnswer, records: readonly BatchRecord[], hrefOf: (record: { readonly type: string; readonly id: string }) => string | null, locale: 'it' | 'en'): ReceiptDoor[] {
  const labelOf = (record: { readonly id: string }, fallback: string | null) => records.find((entry) => entry.id === record.id)?.label ?? fallback ?? record.id
  return [
    ...answer.made.map((made) => ({ id: made.record.id, label: labelOf(made.record, made.task.record?.label ?? null), href: hrefOf(made.record), made: true, assignee: made.task.assignee?.name ?? null, due: made.task.dueDate, why: '' })),
    ...answer.skipped.map((skip) => ({ id: skip.record.id, label: labelOf(skip.record, skip.label), href: skip.label ? hrefOf(skip.record) : null, made: false, assignee: null, due: null, why: skip.words[locale] })),
  ]
}
// ---- end F-CL-104
