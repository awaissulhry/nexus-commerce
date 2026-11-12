'use client'

import Link from 'next/link'
import { Card, KeyValue } from '@nexus/ui/components'
import { Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { SupplierProfile, Vault } from '../api'
import { expiryWords, newOrderWords, nextStepWords, STATUS_TONE, type Read } from '../model'
import { useSay } from './parts'

export interface NowDepthModel {
  readonly profile: Read<SupplierProfile>
  /** The vault (null: the person may not read it here). */
  readonly vault: Read<Vault> | null
  readonly today: string
  /** The record's Documents & qualification tab. */
  readonly documentsHref: string
}

/**
 * Now (design rec:Supplier/overview/side, the W2b lines): where the supplier stands with us and since when, why no new PO
 * goes to it, the next step in words ("2 documents expire in 30 days") and the next document to expire; each fact links
 * to its tab. A failed read says so ("—" with why), never as zero.
 */
export function NowDepth({ model }: { model: NowDepthModel }) {
  const { t, say } = useSay()
  const locale = useLocale()
  const profile = model.profile.status === 'ready' ? model.profile.value : null
  const vault = model.vault?.status === 'ready' ? model.vault.value : null
  const unknown = <span className="fw-spd-hint">{t('now.unknown')}</span>
  const reading = <Skeleton width={90} height={16} />
  const noOrder = profile ? newOrderWords(profile) : null
  return (
    <Card padded>
      <section className="fw-spd-card" aria-label={t('now.title')}>
        <h2 className="fw-spd-title">{t('now.title')}</h2>
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            {
              label: t('status.label'),
              value: profile ? (
                <Pill tone={STATUS_TONE[profile.standing.status]} dot>
                  {t(`status.${profile.standing.status}`)}
                </Pill>
              ) : model.profile.status === 'loading' ? (
                reading
              ) : (
                unknown
              ),
              hint: profile?.standing.changedAt ? t('now.since', { date: formatDate(profile.standing.changedAt, { locale }) }) : undefined,
            },
            ...(noOrder ? [{ label: t('now.newOrders'), value: <span className="fw-spd-warn">{say(noOrder)}</span> }] : []),
            ...(model.vault
              ? [
                  {
                    label: t('now.nextStep'),
                    value: vault ? <Link href={model.documentsHref}>{say(nextStepWords(vault))}</Link> : model.vault.status === 'loading' ? reading : unknown,
                  },
                  {
                    label: t('now.nextExpiry'),
                    value: vault ? (vault.nextExpiry ? say(expiryWords(model.today, vault.nextExpiry)) : t('now.noExpiry')) : model.vault.status === 'loading' ? reading : unknown,
                    hint: vault?.nextExpiry ? formatDate(vault.nextExpiry, { locale }) : undefined,
                  },
                ]
              : []),
          ]}
        />
      </section>
    </Card>
  )
}
