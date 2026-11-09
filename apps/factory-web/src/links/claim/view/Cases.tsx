'use client'

import { Card } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { CaseDocument, ClaimPage } from '../api'
import { caseStateKey, caseTone, type ClaimActions, type ClaimViewModel } from '../model'

/** The documents of a complaint the customer may open: the current answer letter and every 8D shared. */
function documentsOf(page: ClaimPage, complaintId: string): CaseDocument[] {
  const documents = page.complaints.find((complaint) => complaint.id === complaintId)?.investigation?.documents ?? []
  return documents.filter((document) => (document.role === 'ANSWER_LETTER' && document.current) || document.role === 'EIGHT_D')
}

/**
 * The reports this link made (design sec:done "the case number and the next step"; 192's `cases` and `complaints`): each
 * case's number, type, where it stands and the next step (the API's words in the reader's language: they carry the day
 * and the office's reason), the return instructions to print once a return is approved, and a complaint's answer letter
 * and 8D once shared. Shown above the steps when the link made reports before, and under the end after a send.
 */
export function CasesCard({ page, model, actions, compact = false }: { page: ClaimPage; model: ClaimViewModel; actions?: ClaimActions; compact?: boolean }) {
  const t = useT('link-claim')
  const locale = useLocale()
  if (page.cases.length === 0) return null
  return (
    <Card padded className="fw-cl-card">
      <h2 className="fw-cl-h2 fw-cl-small">{t('cases.title', { count: page.cases.length })}</h2>
      {compact && <p className="fw-cl-hint">{t('cases.hint')}</p>}
      <ul className="fw-cl-cases">
        {page.cases.map((entry) => {
          const stateKey = caseStateKey(entry.state)
          const documents = entry.type === 'COMPLAINT' ? documentsOf(page, entry.id) : []
          const opening = model.opening
          const ids = [entry.id, ...documents.map((document) => document.id)]
          const busy = opening && !opening.failed && ids.includes(opening.id) ? opening.id : null
          const failed = opening?.failed && ids.includes(opening.id)
          return (
            <li key={entry.id} className="fw-cl-case">
              <div className="fw-cl-case-head">
                <strong className="fw-cl-number">{entry.number}</strong>
                <span>{t(`type.${entry.type}.short`)}</span>
                {stateKey && <Pill tone={caseTone(entry)}>{t(stateKey)}</Pill>}
              </div>
              <p className="fw-cl-sub" lang={locale}>
                {entry.next.forYou ? <strong>{t('cases.yourMove')} </strong> : null}
                {entry.next.words[locale]}
              </p>
              <p className="fw-cl-sub">{[t('cases.opened', { day: formatDate(entry.opened, { locale, timeZone: model.timeZone }) }), entry.yourRef ? t('cases.yourRef', { ref: entry.yourRef }) : null].filter(Boolean).join(' · ')}</p>
              {(entry.state === 'SEND_IT_BACK' || documents.length > 0) && (
                <div className="fw-cl-actions">
                  {entry.type === 'RETURN' && entry.state === 'SEND_IT_BACK' && (
                    <Button size="sm" heldReason={busy ? t('cases.opening') : null} onClick={() => actions?.onInstructions?.(entry.id, entry.number)}>
                      {busy === entry.id ? t('cases.opening') : t('cases.instructions')}
                    </Button>
                  )}
                  {documents.map((document) => (
                    <Button key={document.id} size="sm" heldReason={busy ? t('cases.opening') : null} onClick={() => actions?.onOpenDocument?.(document.id)}>
                      {busy === document.id ? t('cases.opening') : t(`cases.document.${document.role === 'EIGHT_D' ? 'EIGHT_D' : 'ANSWER_LETTER'}`, { version: document.version ?? 1 })}
                    </Button>
                  ))}
                </div>
              )}
              {failed && (
                <p className="fw-cl-error" role="alert">
                  {t('cases.openFailed')}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
