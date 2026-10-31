'use client'

import { FileCheck2 } from 'lucide-react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Spinner, Textarea } from '@nexus/ui/primitives'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { useT } from '../../../../lib/i18n/provider'
import { SnoozeDialog } from '../../../home/today/view/SnoozeDialog'
import { noteProblem, sentenceOf, whatOf, type Words } from '../model'
import type { ExceptionsActions, ExceptionsModel } from '../view-model'

/** The longest snooze offered (the API sets none; three months, as Today's). */
export const SNOOZE_MAX_DAYS = 90

/**
 * The queue's dialogs: Snooze until (design pop:snooze: the ONE "Snooze until" dialog of the Office, with "After the
 * next run" as its last choice — the API's `until: null`), Resolve with a note (3 to 1000 characters, said before the
 * click), and the keyboard keys.
 */
export function ExceptionDialogs({ model, actions, ownKeys, words }: { model: ExceptionsModel; actions?: ExceptionsActions; ownKeys: readonly ListKey[]; words: Words }) {
  const { t } = words
  const lists = useT('lists')
  const dialog = model.dialog
  if (!dialog) return null
  const rowOf = (id: string) => (model.detail?.loaded.status === 'ready' && model.detail.id === id ? model.detail.loaded.value : model.rows.find((row) => row.id === id))
  if (dialog.kind === 'snooze') {
    const row = rowOf(dialog.id)
    return (
      <SnoozeDialog
        what={row ? whatOf(row, words) : t('snooze.this')}
        now={model.now}
        untilChange
        untilChangeLabel={t('snooze.nextRun')}
        maxDays={SNOOZE_MAX_DAYS}
        held={model.busy.length > 0 ? t('held.busy') : null}
        onSnooze={(until) => actions?.onSnoozeConfirm?.(until)}
        onClose={() => actions?.onCloseDialog?.()}
      />
    )
  }
  if (dialog.kind === 'resolve') {
    const row = rowOf(dialog.id)
    const problem = noteProblem(dialog.note)
    const held = dialog.busy ? t('held.busy') : problem ? t(problem) : null
    return (
      <Modal
        open
        onClose={() => actions?.onCloseDialog?.()}
        title={t('resolve.title')}
        subtitle={row ? whatOf(row, words) : undefined}
        size="md"
        footer={
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onCloseDialog?.()}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onResolveConfirm?.()}>
              {dialog.busy ? <Spinner size={12} /> : <FileCheck2 size={13} aria-hidden />} {t('resolve.confirm')}
            </Button>
          </>
        }
      >
        <div className="fw-px-note">
          {row && <p className="fw-px-text">{sentenceOf(row, words)}</p>}
          <p className="fw-px-hint">{t('resolve.body')}</p>
          <Field label={t('resolve.note')} required hint={t('resolve.noteHint')} error={dialog.problem && dialog.problem.startsWith('resolve.') ? t(dialog.problem) : undefined}>
            <Textarea rows={4} maxLength={1000} value={dialog.note} onChange={(event) => actions?.onResolveNote?.(event.target.value)} />
          </Field>
          {dialog.problem && !dialog.problem.startsWith('resolve.') && <Banner tone="danger" title={t(dialog.problem)} />}
        </div>
      </Modal>
    )
  }
  return (
    <Modal open onClose={() => actions?.onCloseDialog?.()} title={t('page.keys')} size="sm">
      <ul className="fw-px-list">
        {listKeys(ownKeys, true).map((entry) => (
          <li key={entry.does}>
            <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
          </li>
        ))}
        <li>
          <b>J K</b> — {t('keys.walk')}
        </li>
      </ul>
    </Modal>
  )
}
