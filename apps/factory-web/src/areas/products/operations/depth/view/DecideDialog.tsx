'use client'

import { useState } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { decimalText, minutesText } from '../../../styles/model'
import type { OperationMinutesView, TimeVersionView } from '../api'
import { decideHeld, impactCounts, MAX_REASON, type MinutesActions, type MinutesModel } from '../model'
import { refusalTitle } from './ProposeDialog'

/**
 * Approve or reject an SMV change (B-W2b-235 on B-W2b-215's four eyes, PRD-113): old → new, from which day, why, who proposed
 * it and what it reaches; a note (required to reject). Never offered to the one who proposed it (the API refuses it too); a
 * version changed meanwhile (409) is read again. An approval whose day has come takes effect at once; a later one waits for
 * its day (said before the click). It fetches nothing.
 */
export function DecideDialog({ view, version, decision, model, actions }: { view: OperationMinutesView; version: TimeVersionView | null; decision: 'approve' | 'reject'; model: MinutesModel; actions?: MinutesActions }) {
  const t = useT('products-operations-depth')
  const tl = useT('library')
  const locale = useLocale()
  const [note, setNote] = useState('')
  const close = () => actions?.onDialog?.(null)
  if (!version) return null
  const held = decideHeld(version, view, model.userId)
  const reject = decision === 'reject'
  const noteMissing = reject && note.trim() === ''
  const buttonHeld = model.offline ? t('offline.held') : held ? t(held) : noteMissing ? t('decide.held.note') : note.trim().length > MAX_REASON ? t('propose.problem.reasonLong') : model.busy ? t('held.busy') : null
  const counts = impactCounts(view)
  const day = formatDate(version.effectiveFrom, { locale })
  const go = () => {
    if (buttonHeld) return
    void (reject ? actions?.onReject?.(version, note) : actions?.onApprove?.(version, note))
  }
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t(reject ? 'decide.rejectTitle' : 'decide.approveTitle', { number: version.number, code: view.operation.code })}
      footer={
        <>
          <Button onClick={close}>{tl('common.back')}</Button>
          <Button variant={reject ? 'danger' : 'primary'} heldReason={buttonHeld} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t(reject ? 'decide.reject' : 'decide.approve')}
          </Button>
        </>
      }
    >
      <div
        className="fw-opd-stack"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go()
          }
        }}
      >
        <KeyValue
          dense
          labelCase="sentence"
          columns={1}
          items={[
            { label: t('decide.change'), value: t('decide.oldNew', { from: minutesText(view.current.standardMinutes, locale), to: minutesText(version.standardMinutes, locale) }) },
            { label: t('decide.built'), value: t('versions.built', { basic: minutesText(version.basicMinutes, locale), personal: decimalText(version.personalPct, locale, 4), fatigue: decimalText(version.fatiguePct, locale, 4), delay: decimalText(version.delayPct, locale, 4) }) },
            { label: t('decide.from'), value: day },
            { label: t('decide.source'), value: t(`source.${version.source}`) },
            { label: t('decide.reason'), value: <span className="fw-opd-reason">{version.reason}</span> },
            { label: t('decide.proposedBy'), value: version.proposedBy.name },
            { label: t('decide.reaches'), value: t('decide.reachesValue', { routings: view.impact.routings.length, following: counts.following, rates: view.impact.pieceRates.count }) },
          ]}
        />
        {!reject && <p className="fw-opd-hint">{version.effectiveFrom <= view.today ? t('decide.atOnce') : t('decide.onDay', { day })}</p>}
        {reject && <p className="fw-opd-hint">{t('decide.rejectWhat')}</p>}
        <Field label={t(reject ? 'decide.noteRequired' : 'decide.note')} required={reject}>
          <Textarea value={note} rows={2} maxLength={MAX_REASON} autoFocus onChange={(event) => setNote(event.target.value)} />
        </Field>
        {held && <Banner tone="info" title={t(held)} />}
        {model.refused && (
          <Banner tone="danger" title={refusalTitle(model.refused.key, t, tl)}>
            {model.refused.messages.length > 0 && (
              <ul className="fw-opd-list">
                {model.refused.messages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
      </div>
    </Modal>
  )
}
