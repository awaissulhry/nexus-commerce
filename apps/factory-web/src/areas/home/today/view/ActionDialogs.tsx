'use client'

import { useEffect, useId, useState } from 'react'
import { CheckCircle2, Eye, UserRound, UserX, XCircle } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, Kbd, Skeleton, Tag } from '@nexus/ui/primitives'
import { Combobox, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { resolveNoteProblem, type Assignee, type HandledView, type Loaded, type QueueItem } from '../model'

/**
 * The alert verbs' dialogs (design home.today popups `assign` and `resolve-note`, W1) and "Handled today" (needs-me
 * footer). Each draws what the container gives it and says what the person asked; the container sends it (Today.tsx).
 */

/** Assign to (design: a person, with who is responsible for this site suggested first; Combobox). */
export function AssignDialog({
  item,
  people,
  busy,
  held,
  onAssign,
  onRetry,
  onClose,
}: {
  item: QueueItem
  people: Loaded<readonly Assignee[]>
  busy: boolean
  /** Why the verb is held now (offline …), or null. */
  held: string | null
  onAssign: (assigneeId: string | null) => void
  onRetry: () => void
  onClose: () => void
}) {
  const t = useT('home')
  const labelId = useId()
  const current = item.actions.assigned?.to.id ?? null
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => setPicked(null), [item.key])
  const options =
    people.status === 'ready'
      ? people.data.map((person) => ({
          value: person.id,
          label: [person.name, person.me ? t('today.assign.you') : null, person.suggested ? t('today.assign.suggested') : null].filter(Boolean).join(' · '),
        }))
      : []
  const choice = picked ?? current ?? undefined
  const assignHeld = held ? t(held) : busy ? t('today.actions.held.busy') : !picked ? t('today.assign.pickFirst') : picked === current ? t('today.assign.already') : undefined
  return (
    <Modal
      open
      onClose={onClose}
      title={t('today.assign.title', { record: item.record.label })}
      footer={
        <span className="fw-today-decide-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('today.assign.cancel')}
          </Button>
          {current && (
            <Button variant="secondary" onClick={() => onAssign(null)} heldReason={held ? t(held) : busy ? t('today.actions.held.busy') : undefined}>
              <UserX size={14} aria-hidden /> {t('today.assign.takeBack')}
            </Button>
          )}
          <Button variant="primary" onClick={() => picked && onAssign(picked)} heldReason={assignHeld}>
            <UserRound size={14} aria-hidden /> {t('today.assign.confirm')}
          </Button>
        </span>
      }
    >
      <div className="fw-today-dialog">
        {item.actions.assigned && <p className="fw-today-muted">{t(item.actions.assigned.to.me ? 'today.assign.nowYou' : 'today.assign.now', { name: item.actions.assigned.to.name })}</p>}
        {people.status === 'loading' ? (
          <div aria-busy="true">
            <Skeleton height={36} />
          </div>
        ) : people.status === 'error' ? (
          <Banner tone="danger" title={t(people.problem)} action={<Button size="sm" onClick={onRetry}>{t('today.retry')}</Button>} />
        ) : people.data.length === 0 ? (
          <p className="fw-today-muted">{t('today.assign.nobody')}</p>
        ) : (
          <div className="fw-today-field">
            <span id={labelId} className="fw-today-field-label">
              {t('today.assign.person')}
            </span>
            <Combobox options={options} value={choice} onChange={setPicked} placeholder={t('today.assign.search')} labelledBy={labelId} />
            <span className="fw-today-muted">{t('today.assign.hint')}</span>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Resolve alert (design: a note saying what was done; the alert closes for everyone it went to). ⌘Enter resolves. */
export function ResolveDialog({ item, busy, held, onResolve, onClose }: { item: QueueItem; busy: boolean; held: string | null; onResolve: (note: string) => Promise<boolean>; onClose: () => void }) {
  const t = useT('home')
  const [note, setNote] = useState('')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    setNote('')
    setTried(false)
  }, [item.key])
  const problem = resolveNoteProblem(note)
  const send = async () => {
    setTried(true)
    if (problem || held || busy) return
    await onResolve(note)
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('today.resolve.title', { record: item.record.label })}
      footer={
        <span className="fw-today-decide-buttons">
          <Button variant="secondary" onClick={onClose}>
            {t('today.resolve.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void send()} heldReason={held ? t(held) : busy ? t('today.actions.held.busy') : undefined}>
            <CheckCircle2 size={14} aria-hidden /> {t('today.resolve.confirm')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-today-dialog">
        <Field label={t('today.resolve.note')} required hint={t('today.resolve.hint')} error={tried && problem ? t(problem) : undefined}>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void send()
              }
            }}
            rows={4}
            limit={1000}
            autoFocus
          />
        </Field>
      </div>
    </Modal>
  )
}

const HANDLED_ICON = { ASSIGNED: UserRound, UNASSIGNED: UserX, RESOLVED: CheckCircle2, ACKNOWLEDGED: Eye, APPROVED: CheckCircle2, REJECTED: XCircle } as const

/** "Handled today" (design: what I decided today, for my own record), newest first. */
export function HandledDialog({ list, onRetry, onClose }: { list: Loaded<HandledView>; onRetry: () => void; onClose: () => void }) {
  const t = useT('home')
  const locale = useLocale()
  const kindLabel = (code: string) => (t(`today.kind.${code}`) === `today.kind.${code}` ? code : t(`today.kind.${code}`))
  return (
    <Modal
      open
      onClose={onClose}
      title={list.status === 'ready' ? t('today.handled.title', { count: list.data.count }) : t('today.handled.titlePlain')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('today.handled.close')}
        </Button>
      }
    >
      {list.status === 'loading' ? (
        <div className="fw-today-dialog" aria-busy="true">
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      ) : list.status === 'error' ? (
        <Banner tone="danger" title={t(list.problem)} action={<Button size="sm" onClick={onRetry}>{t('today.retry')}</Button>} />
      ) : list.data.items.length === 0 ? (
        <EmptyState icon={<CheckCircle2 size={24} aria-hidden />} title={t('today.handled.empty.title')} description={t('today.handled.empty.body')} />
      ) : (
        <ul className="fw-today-handled">
          {list.data.items.map((entry) => {
            const Icon = HANDLED_ICON[entry.verb]
            return (
              <li key={`${entry.verb}-${entry.at}-${entry.record.id}`} className="fw-today-handled-row">
                <span className="fw-today-muted fw-today-handled-time">{formatTime(entry.at, { locale })}</span>
                <Icon size={16} aria-hidden />
                <span className="fw-today-handled-body">
                  <span>
                    <strong>{t(`today.handled.verb.${entry.verb}`, { name: entry.assignee?.name ?? '' })}</strong>{' '}
                    <a className="fw-today-record" href={entry.href}>
                      {entry.record.label}
                    </a>{' '}
                    <Tag tone="neutral">{kindLabel(entry.kind)}</Tag>
                  </span>
                  {entry.note && <span className="fw-today-muted">“{entry.note}”</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
