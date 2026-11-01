'use client'

import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { Plus } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../lib/i18n/locales'
import { useLocale, useT } from '../../lib/i18n/provider'
import { WithMessages } from '../i18n'
import type { PanelRead } from '../model'
import { CHECKLIST_MAX, draftProblem, emptyDraft, type Assignable, type TaskDraft } from '../tasks/model'
import '../record-panels.css'

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
  return (
    <WithMessages namespaces={['records']}>
      <Dialog {...props} />
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
        <span className="fw-rp-dialog-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('tasks.new.cancel')}
          </Button>
          <Button variant="primary" heldReason={heldText} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            <Plus size={14} aria-hidden /> {t('tasks.new.create')}
          </Button>
        </span>
      }
    >
      <div className="fw-rp-task-form" onKeyDown={onKey}>
        <Field label={t('tasks.new.field.title')} required htmlFor={titleId}>
          <Input id={titleId} value={draft.title} onChange={(event) => set({ title: event.target.value })} autoFocus maxLength={400} placeholder={t('tasks.new.field.titlePlaceholder')} />
        </Field>
        <div className="fw-rp-task-form-row">
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
