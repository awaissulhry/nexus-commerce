'use client'

import { Pencil, Trash2 } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useAccountingWords } from '../../checks/words'
import { MAPPING_NOTE_MAX, type MappingRow } from '../api'
import { addHeld, changeHeld, keyWordsOf, removeHeld } from '../model'
import type { KeyDialogModel, MappingActions, MappingPageModel } from '../view-model'

const dayInstant = (day: string): string => `${day}T12:00:00Z`

/**
 * One key of the account mapping in its dialog (`?open=KIND/KEY`; Esc closes and the focus goes back to the row): what it
 * is, the account in force today (or none: its lines go blank), the rows changing soon (each changed or removed before its
 * day), the earlier ones, and a new row from a day (a key's first row may start earlier and fills what had no account; a
 * change starts today or later, so what was handed over keeps its account). A key Nexus does not post is said so and
 * takes no new row.
 */
export function KeyDialog({ model, dialog, actions }: { model: MappingPageModel; dialog: KeyDialogModel; actions?: MappingActions }) {
  const t = useAccountingWords()
  const locale = useLocale()
  const key = dialog.key
  const words = keyWordsOf(key, locale)
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const mapped = key.current !== null || key.upcoming.length > 0 || key.earlier.length > 0
  const held = addHeld(key, dialog.draft, { today: model.today, can: model.can, busy: dialog.busy })
  const who = (row: MappingRow) => t('mapping.setBy', { who: row.createdBy?.name ?? t('history.someone'), at: formatDateTime(row.createdAt, { locale }) })
  return (
    <Modal open onClose={() => actions?.onClose?.()} title={words ?? t('mapping.notPosted')} subtitle={`${t(`mapping.kind.${key.kind}`)} · ${key.key}`} size="lg" footer={<><span className="grow" /><Button size="sm" onClick={() => actions?.onClose?.()}>{t('common.close')}</Button></>}>
      <div className="fw-fac-dialog">
        {!key.posted && (
          <Banner tone="info" title={t('mapping.otherTitle')}>
            {t('mapping.otherBody')}
          </Banner>
        )}
        {dialog.done && <Banner tone="success" title={t(dialog.done.key, dialog.done.params ? { ...dialog.done.params, day: day(String(dialog.done.params.day)) } : undefined)} />}

        <section className="fw-fac-stack" aria-labelledby="fw-fam-now">
          <h3 className="fw-fac-h3" id="fw-fam-now">
            {t('mapping.dialog.now')}
          </h3>
          {key.current ? (
            <KeyValue
              items={[
                { label: t('mapping.dialog.account'), value: <code className="fw-fam-account">{key.current.accountCode}</code> },
                { label: t('mapping.dialog.since'), value: day(key.current.validFrom), hint: t('mapping.dialog.fixed') },
                { label: t('mapping.dialog.note'), value: key.current.note ?? '—' },
                { label: t('mapping.dialog.by'), value: t('mapping.whoAt', { who: key.current.createdBy?.name ?? t('history.someone'), at: formatDateTime(key.current.createdAt, { locale }) }) },
              ]}
            />
          ) : key.posted ? (
            <Banner tone="warning" title={t('mapping.noAccount')}>
              {t('mapping.dialog.noAccountBody')}
            </Banner>
          ) : (
            <p className="fw-fac-muted">{t('mapping.nothingInForce')}</p>
          )}
        </section>

        {key.upcoming.length > 0 && (
          <section className="fw-fac-stack" aria-labelledby="fw-fam-soon">
            <h3 className="fw-fac-h3" id="fw-fam-soon">
              {t('mapping.dialog.soon')}
            </h3>
            <ul className="fw-fam-rows">
              {key.upcoming.map((row) => {
                const editing = dialog.editing?.rowId === row.id ? dialog.editing : null
                const removeHold = removeHeld(row, { can: model.can, busy: dialog.rowBusy !== null })
                const changeHold = editing ? changeHeld(row, editing, { can: model.can, busy: dialog.rowBusy !== null }) : null
                return (
                  <li key={row.id} className="fw-fam-row">
                    <span className="fw-fac-stack">
                      <span>
                        <code className="fw-fam-account">{row.accountCode}</code> <span className="fw-fac-muted">{t('mapping.from', { day: day(row.validFrom) })}</span>
                      </span>
                      <span className="fw-fac-muted">{[row.note, who(row)].filter(Boolean).join(' · ')}</span>
                    </span>
                    {editing ? (
                      <div className="fw-fac-form">
                        <Field label={t('mapping.dialog.account')}>
                          <Input value={editing.accountCode} autoComplete="off" spellCheck={false} onChange={(event) => actions?.onEditDraft?.({ accountCode: event.target.value })} />
                        </Field>
                        <Field label={t('mapping.dialog.note')}>
                          <Textarea value={editing.note} limit={MAPPING_NOTE_MAX} rows={2} onChange={(event) => actions?.onEditDraft?.({ note: event.target.value })} />
                        </Field>
                        <span className="fw-fac-actions">
                          <Button size="sm" variant="primary" heldReason={changeHold ? t(changeHold.key, changeHold.params) : undefined} onClick={() => actions?.onSaveEdit?.()}>
                            {t('mapping.dialog.save')}
                          </Button>
                          <Button size="sm" variant="quiet" onClick={() => actions?.onEdit?.(null)}>
                            {t('common.cancel')}
                          </Button>
                        </span>
                      </div>
                    ) : (
                      <span className="fw-fac-actions">
                        <Button size="sm" heldReason={model.can.manage ? undefined : t('mapping.held.noManage')} onClick={() => actions?.onEdit?.(row)}>
                          <Pencil size={13} aria-hidden /> {t('mapping.dialog.change')}
                        </Button>
                        <Button size="sm" variant="danger" heldReason={removeHold ? t(removeHold.key, removeHold.params) : undefined} onClick={() => actions?.onRemove?.(row)}>
                          <Trash2 size={13} aria-hidden /> {t('mapping.dialog.remove')}
                        </Button>
                      </span>
                    )}
                    {dialog.rowBusy === row.id && (
                      <span className="fw-fac-muted" role="status">
                        <Spinner size={12} /> {t('common.working')}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            {dialog.rowProblem && <Banner tone="danger" title={t(dialog.rowProblem.key, dialog.rowProblem.params)} />}
          </section>
        )}

        {key.earlier.length > 0 && (
          <section className="fw-fac-stack" aria-labelledby="fw-fam-earlier">
            <h3 className="fw-fac-h3" id="fw-fam-earlier">
              {t('mapping.dialog.earlier')}
            </h3>
            <ul className="fw-fam-rows">
              {key.earlier.map((row) => (
                <li key={row.id} className="fw-fam-row">
                  <span className="fw-fac-stack">
                    <span>
                      <code className="fw-fam-account">{row.accountCode}</code> <span className="fw-fac-muted">{t('mapping.from', { day: day(row.validFrom) })}</span>
                    </span>
                    <span className="fw-fac-muted">{[row.note, who(row)].filter(Boolean).join(' · ')}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {key.posted && (
          <section className="fw-fac-stack fw-fam-add" aria-labelledby="fw-fam-add">
            <h3 className="fw-fac-h3" id="fw-fam-add">
              {t(mapped ? 'mapping.dialog.addChange' : 'mapping.dialog.addFirst')}
            </h3>
            <p className="fw-fac-muted">{t(mapped ? 'mapping.dialog.addChangeHint' : 'mapping.dialog.addFirstHint')}</p>
            {model.can.manage ? (
              <>
                <div className="fw-fac-form">
                  <Field label={t('mapping.dialog.account')} hint={t('mapping.dialog.accountHint')} required>
                    <Input value={dialog.draft.accountCode} autoComplete="off" spellCheck={false} autoFocus={!key.current} onChange={(event) => actions?.onDraft?.({ accountCode: event.target.value })} />
                  </Field>
                  <Field label={t('mapping.dialog.from')} required>
                    <DateField value={dialog.draft.validFrom} min={mapped ? model.today : undefined} ariaLabel={t('mapping.dialog.from')} onChange={(value) => actions?.onDraft?.({ validFrom: value ?? '' })} />
                  </Field>
                </div>
                <Field label={t('mapping.dialog.note')}>
                  <Textarea value={dialog.draft.note} limit={MAPPING_NOTE_MAX} rows={2} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} />
                </Field>
                {dialog.problem && <Banner tone="danger" title={t(dialog.problem.key, dialog.problem.params)} />}
                <span className="fw-fac-actions">
                  <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : undefined} onClick={() => actions?.onAdd?.()}>
                    {dialog.draft.validFrom ? t('mapping.dialog.go', { day: day(dialog.draft.validFrom) }) : t('mapping.dialog.goNoDay')}
                  </Button>
                  {dialog.busy && (
                    <span className="fw-fac-muted" role="status">
                      <Spinner size={12} /> {t('common.working')}
                    </span>
                  )}
                </span>
              </>
            ) : (
              <p className="fw-fac-muted">{t('mapping.held.noManage')}</p>
            )}
          </section>
        )}
      </div>
    </Modal>
  )
}
