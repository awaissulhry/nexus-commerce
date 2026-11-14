'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Input } from '@nexus/ui/primitives'
import { DateField, JobProgress, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { useAccountingWords } from '../../checks/words'
import { MAPPING_NOTE_MAX } from '../api'
import { bulkHeld, keyId, keyWordsOf } from '../model'
import type { BulkDialogModel, MappingActions, MappingPageModel } from '../view-model'

const dayInstant = (day: string): string => `${day}T12:00:00Z`

/**
 * "Map N keys" (the list's bulk action): one account for every key chosen, from one day — each key its own row (one
 * request each; a key refused says why in words, the others are made). A key Nexus does not post cannot be chosen into
 * it; a key mapped already changes from today or later. Esc closes once nothing is running.
 */
export function BulkDialog({ model, bulk, actions }: { model: MappingPageModel; bulk: BulkDialogModel; actions?: MappingActions }) {
  const t = useAccountingWords()
  const locale = useLocale()
  const held = bulkHeld(bulk.keys, bulk.draft, { today: model.today, can: model.can, busy: bulk.busy })
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const name = (id: string) => {
    const key = bulk.keys.find((entry) => keyId(entry) === id)
    return key ? `${keyWordsOf(key, locale) ?? t('mapping.notPosted')} (${key.key})` : id
  }
  return (
    <Modal
      open
      onClose={() => actions?.onBulkClose?.()}
      closeHeld={bulk.busy ? t('mapping.held.running') : null}
      title={t('mapping.bulk.title', { count: bulk.keys.length })}
      size="md"
      footer={
        <>
          <Button size="sm" variant="quiet" heldReason={bulk.busy ? t('mapping.held.running') : undefined} onClick={() => actions?.onBulkClose?.()}>
            {t(bulk.done ? 'common.done' : 'common.cancel')}
          </Button>
          <span className="grow" />
          {!bulk.done && (
            <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : undefined} onClick={() => actions?.onBulkGo?.()}>
              {bulk.draft.validFrom ? t('mapping.bulk.go', { count: bulk.keys.length, day: day(bulk.draft.validFrom) }) : t('mapping.bulk.goNoDay', { count: bulk.keys.length })}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-fac-dialog">
        <p className="fw-fac-muted">{t('mapping.bulk.lead')}</p>
        <ul className="fw-fac-list fw-fam-picked" aria-label={t('mapping.bulk.chosen')}>
          {bulk.keys.map((key) => (
            <li key={keyId(key)}>{name(keyId(key))}</li>
          ))}
        </ul>
        {bulk.done ? (
          <>
            <Banner tone={bulk.done.refused.length > 0 ? 'warning' : 'success'} title={t('mapping.bulk.done', { made: bulk.done.made.length, refused: bulk.done.refused.length })} />
            {bulk.done.refused.length > 0 && (
              <ul className="fw-fac-list" aria-label={t('mapping.bulk.refused')}>
                {bulk.done.refused.map((entry) => (
                  <li key={entry.id}>{`${name(entry.id)}: ${t(entry.problem.key, entry.problem.params)}`}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <div className="fw-fac-form">
              <Field label={t('mapping.dialog.account')} hint={t('mapping.dialog.accountHint')} required>
                <Input value={bulk.draft.accountCode} autoComplete="off" spellCheck={false} autoFocus onChange={(event) => actions?.onBulkDraft?.({ accountCode: event.target.value })} />
              </Field>
              <Field label={t('mapping.dialog.from')} hint={t('mapping.bulk.fromHint')} required>
                <DateField value={bulk.draft.validFrom} ariaLabel={t('mapping.dialog.from')} onChange={(value) => actions?.onBulkDraft?.({ validFrom: value ?? '' })} />
              </Field>
            </div>
            <Field label={t('mapping.dialog.note')}>
              <Textarea value={bulk.draft.note} limit={MAPPING_NOTE_MAX} rows={2} onChange={(event) => actions?.onBulkDraft?.({ note: event.target.value })} />
            </Field>
            {bulk.busy && <JobProgress label={t('mapping.bulk.running', { sent: bulk.sent, count: bulk.keys.length })} value={bulk.sent} max={bulk.keys.length} />}
          </>
        )}
      </div>
    </Modal>
  )
}
