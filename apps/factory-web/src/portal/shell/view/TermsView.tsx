'use client'

import { AlertCircle } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'

/** The portal terms as text (B-W2b-173): the version, when it was published, whether the person accepted it, the text. */
export type TermsViewModel =
  | { state: 'ready'; label: string; published: string | null; body: string; otherLanguage: boolean; /** Null: an office preview (no person accepted anything). */ acknowledged: boolean | null }
  | { state: 'none' }
  | { state: 'error' }

export function TermsView({ model }: { model: TermsViewModel }) {
  const t = useT('portal')
  if (model.state === 'error') {
    return (
      <div className="fw-pstate" role="alert">
        <AlertCircle size={18} aria-hidden />
        <span>{t('terms.failed')}</span>
      </div>
    )
  }
  if (model.state === 'none') return <EmptyState title={t('terms.noneTitle')} description={t('terms.none')} />
  return (
    <Card padded className="fw-pterms">
      <p className="fw-pterms-meta">
        {t('terms.version', { label: model.label })}
        {model.published ? ` · ${t('terms.published', { date: model.published })}` : ''}{' '}
        {model.acknowledged === null ? null : <Pill tone={model.acknowledged ? 'success' : 'warning'}>{model.acknowledged ? t('terms.accepted') : t('terms.notAccepted')}</Pill>}
      </p>
      {model.otherLanguage ? <p className="fw-pterms-note">{t('terms.otherLanguage')}</p> : null}
      <div className="fw-pterms-body">{model.body}</div>
    </Card>
  )
}
