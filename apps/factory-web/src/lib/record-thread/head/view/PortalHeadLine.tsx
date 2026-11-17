'use client'

import { MessageCircleQuestion } from 'lucide-react'
import { Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../../i18n/format'
import { useLocale, useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { HEAD_NS } from './RecordThreadHead'

/** The portal's head: what the customer may know, from real states only. No owner, no waiting time, no office count. */
export interface PortalHeadModel {
  /** The request waits for the customer (its state is Need info). */
  readonly needInfo: boolean
  /** Who wrote the last shared message, and when; null: no message yet. */
  readonly last: { readonly from: 'you' | 'us'; readonly at: string } | null
  /** The factory's name as the portal shows it. */
  readonly factory: string
  readonly timeZone?: string
}

/**
 * The portal's plain line over its thread (B-TH-209, T1 audience "Portal and link: the plain line"): "We need something
 * from you" (Need info) or "Last message: from you / from <factory>, 12 Nov". Brand wall (W08, W34): it is built from the
 * customer's own record only and carries no office count, owner or waiting time. The portal keeps its DS PartnerThread
 * (PR-15); its frame shows this line above it.
 */
export function PortalHeadLine({ model }: { model: PortalHeadModel }) {
  return (
    <WithMessages namespaces={[HEAD_NS]}>
      <Line model={model} />
    </WithMessages>
  )
}

function Line({ model }: { model: PortalHeadModel }) {
  const t = useT(HEAD_NS)
  const locale = useLocale()
  const place = { locale, ...(model.timeZone ? { timeZone: model.timeZone } : {}) }
  return (
    <p className="fw-rth-portal">
      {model.needInfo ? (
        <Pill tone="warning" icon={<MessageCircleQuestion size={12} aria-hidden />}>
          {t('portal.needInfo')}
        </Pill>
      ) : model.last ? (
        <span>{model.last.from === 'you' ? t('portal.lastFromYou', { date: formatDate(model.last.at, place) }) : t('portal.lastFromUs', { factory: model.factory, date: formatDate(model.last.at, place) })}</span>
      ) : (
        <span>{t('portal.none')}</span>
      )}
    </p>
  )
}
