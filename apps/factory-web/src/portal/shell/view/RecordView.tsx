'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'

/**
 * The frame's record page (B-W2b-173): one line under the band (what the record belongs to), then its Messages
 * (`children`: the record's conversation) under `#messages`, which "Ask a question" scrolls to and focuses. A record that
 * is not the partner's — or no longer exists — says so, with the way Home.
 */
export interface RecordViewModel {
  missing: boolean
  subtitle: string | null
  homeHref: string
}

export function RecordView({ model, children }: { model: RecordViewModel; children?: ReactNode }) {
  const t = useT('portal')
  if (model.missing) {
    return (
      <EmptyState
        title={t('record.missingTitle')}
        description={t('record.missing')}
        action={
          <Button asChild variant="primary">
            <Link href={model.homeHref}>{t('record.toHome')}</Link>
          </Button>
        }
      />
    )
  }
  return (
    <div className="fw-precord">
      {model.subtitle ? <p className="fw-precord-sub">{model.subtitle}</p> : null}
      <section id="messages" className="fw-precord-messages" aria-label={t('record.messages')}>
        {children}
      </section>
    </div>
  )
}
