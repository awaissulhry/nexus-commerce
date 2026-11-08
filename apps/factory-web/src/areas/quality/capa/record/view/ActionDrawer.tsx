'use client'

import { useEffect, useRef } from 'react'
import { ArrowDown, ArrowUp, BellRing, CheckCheck, Paperclip, Upload, X } from 'lucide-react'
import { Drawer, Field, KeyValue } from '@nexus/ui/components'
import { Button, Kbd, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ACTION_KINDS, CAPA_LIMITS, REMINDER_DAYS_BEFORE, REMINDER_HOUR } from '@nexus/factory-domain/quality/capa/rules'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { CapaRecord } from '../../api'
import { actionEditHeld, doneHeld, dueSay, remindHeld, uploadHeld } from '../../model'
import { CellMark, personWords, useCapaWords } from '../../parts'
import type { CapaRecordActions, CapaRecordModel } from '../view-model'

/**
 * The action (design pop:capa-action, a docked drawer opened by Enter on an action row; ⌘↑ / ⌘↓ between actions): owner,
 * due day, what to do and its kind (each autosaves with the action's version), the reminders (sent, the last one, Remind
 * now), the escalation path (a person, or the company's quality rule) and when it escalated, the evidence (the note, the
 * action's files, Add a file), its state with Done… and Cancel…, and its history. The DS Drawer in dock mode: no backdrop,
 * no focus trap, the list stays usable beside it.
 */
export function ActionDrawer({ model, record, actions }: { model: CapaRecordModel; record: CapaRecord; actions?: CapaRecordActions }) {
  const { t, say } = useCapaWords()
  const locale = useLocale()
  const file = useRef<HTMLInputElement>(null)
  const latest = useRef(actions)
  latest.current = actions
  const drawer = model.drawer
  const index = record.actions.findIndex((entry) => entry.id === drawer?.actionId)
  const action = index >= 0 ? record.actions[index]! : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        latest.current?.onStepAction?.(event.key === 'ArrowDown' ? 1 : -1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!drawer) return null
  const capa = record.capa
  const offline = model.live === 'offline'
  const people = model.people ?? []
  const nameOf = (id: string | null) => personWords([...record.people, ...people], id, model.me, t)
  const editHeld = action ? (say(actionEditHeld(action, capa, model.can)) ?? (offline ? t('held.offline') : null)) : null
  const done = action ? (say(doneHeld(action, capa, model.can, model.me)) ?? (offline ? t('held.offline') : null)) : null
  const remind = action ? (say(remindHeld(action, capa, model.can)) ?? (offline ? t('held.offline') : null)) : null
  const upload = action ? (say(uploadHeld(action, capa, model.can, model.me)) ?? (offline ? t('held.offline') : drawer.uploading ? t('common.working') : null)) : null
  const options = (id: string) => (people.some((person) => person.id === id) ? people : [{ id, name: nameOf(id), manages: false, remindable: false, me: false }, ...people])
  const due = action && action.status === 'OPEN' ? dueSay(action.dueOn, model.today) : null

  return (
    <Drawer
      mode="dock"
      open
      onClose={() => actions?.onOpenAction?.(null)}
      closeLabel={t('drawer.close')}
      width={440}
      title={action ? t('drawer.title', { seq: action.seq, kind: t(`kind.${action.kind}`) }) : t('drawer.missing')}
      subtitle={`${capa.number} · ${capa.title}`}
      footer={
        <span className="fw-capa-foot">
          <Button size="sm" heldReason={index > 0 ? null : t('drawer.first')} onClick={() => actions?.onStepAction?.(-1)} aria-label={t('drawer.previous')}>
            <ArrowUp size={13} aria-hidden /> {t('drawer.previous')}
            <span className="fw-capa-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↑</Kbd>
            </span>
          </Button>
          <Button size="sm" heldReason={index >= 0 && index < record.actions.length - 1 ? null : t('drawer.last')} onClick={() => actions?.onStepAction?.(1)} aria-label={t('drawer.next')}>
            <ArrowDown size={13} aria-hidden /> {t('drawer.next')}
            <span className="fw-capa-keys" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>↓</Kbd>
            </span>
          </Button>
        </span>
      }
    >
      {!action ? (
        <p className="fw-capa-hint">{t('drawer.missingBody')}</p>
      ) : (
        <div className="fw-capa-stack">
          <p className="fw-capa-row">
            <Tag tone={action.status === 'DONE' ? 'success' : action.status === 'CANCELLED' ? 'neutral' : action.overdue ? 'danger' : 'warning'}>{action.status === 'OPEN' && action.overdue ? t('actionStatus.OVERDUE') : t(`actionStatus.${action.status}`)}</Tag>
            {due && <span className={due.key === 'due.late' ? 'fw-capa-bad' : 'fw-capa-hint'}>{say(due)}</span>}
          </p>
          {editHeld && action.status === 'OPEN' && <p className="fw-capa-hint">{editHeld}</p>}

          <Field label={t('drawer.description')}>
            {editHeld ? (
              <span>{action.description}</span>
            ) : (
              <span className="fw-capa-cell">
                <Textarea key={`${action.id}:${action.version}`} defaultValue={action.description} rows={3} maxLength={CAPA_LIMITS.description} onBlur={(event) => actions?.onActionCell?.(action.id, 'description', event.target.value)} />
                <CellMark cell={model.cells[`${action.id}:description`]} />
              </span>
            )}
          </Field>
          <div className="fw-capa-form">
            <Field label={t('actions.col.kind')}>
              {editHeld ? (
                <span>{t(`kind.${action.kind}`)}</span>
              ) : (
                <span className="fw-capa-row">
                  <Select size="sm" value={action.kind} onChange={(event) => actions?.onActionCell?.(action.id, 'kind', event.target.value)}>
                    {ACTION_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`kind.${kind}`)}
                      </option>
                    ))}
                  </Select>
                  <CellMark cell={model.cells[`${action.id}:kind`]} />
                </span>
              )}
            </Field>
            <Field label={t('actions.col.owner')}>
              {editHeld ? (
                <span>{nameOf(action.ownerId)}</span>
              ) : (
                <span className="fw-capa-row">
                  <Select size="sm" value={action.ownerId} onChange={(event) => actions?.onActionCell?.(action.id, 'ownerId', event.target.value)}>
                    {options(action.ownerId).map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.id === model.me ? t('common.me', { name: person.name }) : person.name}
                      </option>
                    ))}
                  </Select>
                  <CellMark cell={model.cells[`${action.id}:ownerId`]} />
                </span>
              )}
            </Field>
            <Field label={t('actions.col.due')}>
              {editHeld ? (
                <span>{formatDate(action.dueOn, { locale })}</span>
              ) : (
                <span className="fw-capa-row">
                  <DateField key={`${action.id}:${action.version}`} value={action.dueOn} min={model.today} onChange={(value) => actions?.onActionCell?.(action.id, 'dueOn', value)} />
                  <CellMark cell={model.cells[`${action.id}:dueOn`]} />
                </span>
              )}
            </Field>
            <Field label={t('drawer.escalateTo')} hint={t('drawer.escalateHint')}>
              {editHeld ? (
                <span>{action.escalateToId ? nameOf(action.escalateToId) : t('actions.byRule')}</span>
              ) : (
                <span className="fw-capa-row">
                  <Select size="sm" value={action.escalateToId ?? ''} onChange={(event) => actions?.onActionCell?.(action.id, 'escalateToId', event.target.value)}>
                    <option value="">{t('actions.byRule')}</option>
                    {options(action.escalateToId ?? model.me)
                      .filter((person) => person.id !== '')
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.id === model.me ? t('common.me', { name: person.name }) : person.name}
                        </option>
                      ))}
                  </Select>
                  <CellMark cell={model.cells[`${action.id}:escalateToId`]} />
                </span>
              )}
            </Field>
          </div>

          <section className="fw-capa-block" aria-labelledby="capa-drawer-reminders">
            <h3 id="capa-drawer-reminders" className="fw-capa-h3">
              {t('drawer.reminders')}
            </h3>
            <p className="fw-capa-hint">{t('drawer.remindersRule', { days: REMINDER_DAYS_BEFORE[0], hour: REMINDER_HOUR })}</p>
            <KeyValue
              items={[
                { label: t('drawer.sent'), value: t('actions.reminders', { count: action.remindersSent }) },
                { label: t('drawer.lastReminder'), value: action.lastRemindedAt ? formatDateTime(action.lastRemindedAt, { locale }) : '—' },
                { label: t('drawer.escalated'), value: action.escalatedAt ? formatDateTime(action.escalatedAt, { locale }) : t('drawer.notEscalated') },
              ]}
            />
            <Button size="sm" heldReason={remind} onClick={() => actions?.onRemind?.(action.id)}>
              <BellRing size={13} aria-hidden /> {t('drawer.remind')}
            </Button>
          </section>

          <section className="fw-capa-block" aria-labelledby="capa-drawer-evidence">
            <h3 id="capa-drawer-evidence" className="fw-capa-h3">
              {t('drawer.evidence')}
            </h3>
            <p>{action.evidenceNote ?? <span className="fw-capa-hint">{t('drawer.noNote')}</span>}</p>
            {drawer.files.problem ? (
              <p className="fw-capa-bad">{t(drawer.files.problem)}</p>
            ) : drawer.files.items === null ? (
              <p className="fw-capa-hint" role="status">
                <Spinner size={12} /> {t('drawer.filesReading')}
              </p>
            ) : drawer.files.items.length === 0 ? (
              <p className="fw-capa-hint">{t('drawer.noFiles')}</p>
            ) : (
              <ul className="fw-capa-list">
                {drawer.files.items.map((entry) => (
                  <li key={entry.id}>
                    <Button size="xs" variant="quiet" heldReason={model.can.filesRead ? null : t('held.noFiles')} onClick={() => actions?.onOpenFile?.(entry.id)}>
                      <Paperclip size={13} aria-hidden /> {entry.name}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {action.status === 'OPEN' && (
              <>
                <input
                  ref={file}
                  type="file"
                  hidden
                  onChange={(event) => {
                    const picked = event.target.files?.[0]
                    if (picked) actions?.onUpload?.(picked)
                    event.target.value = ''
                  }}
                />
                <span className="fw-capa-row">
                  <Button size="sm" heldReason={upload} onClick={() => file.current?.click()}>
                    {drawer.uploading ? <Spinner size={12} /> : <Upload size={13} aria-hidden />} {t('drawer.addFile')}
                  </Button>
                  <Button size="sm" variant="primary" heldReason={done} onClick={() => actions?.onDialog?.({ kind: 'done', actionId: action.id, evidence: '', busy: false, notice: null })}>
                    <CheckCheck size={13} aria-hidden /> {t('actions.done')}
                  </Button>
                  <Button size="sm" variant="quiet" heldReason={editHeld} onClick={() => actions?.onDialog?.({ kind: 'cancelAction', actionId: action.id, reason: '', busy: false, notice: null })}>
                    <X size={13} aria-hidden /> {t('drawer.cancelAction')}
                  </Button>
                </span>
              </>
            )}
          </section>

          <section className="fw-capa-block" aria-labelledby="capa-drawer-history">
            <h3 id="capa-drawer-history" className="fw-capa-h3">
              {t('drawer.history')}
            </h3>
            <ul className="fw-capa-list">
              <li>{t('drawer.added', { date: formatDateTime(action.createdAt, { locale }) })}</li>
              {action.lastRemindedAt && <li>{t('drawer.remindedOn', { count: action.remindersSent, date: formatDateTime(action.lastRemindedAt, { locale }) })}</li>}
              {action.escalatedAt && <li>{t('drawer.escalatedOn', { date: formatDateTime(action.escalatedAt, { locale }) })}</li>}
              {action.doneAt && <li>{t('drawer.doneOn', { date: formatDateTime(action.doneAt, { locale }), name: nameOf(action.doneById) })}</li>}
              {action.status === 'CANCELLED' && <li>{t('actions.cancelledBecause', { reason: action.cancelReason ?? '—' })}</li>}
            </ul>
          </section>
        </div>
      )}
    </Drawer>
  )
}
