'use client'

import { Pill, Tag } from '@nexus/ui/primitives'
import { Countdown } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { DEPTH_NAMESPACE } from '../../substances/frame/parts'
import type { DeclarationRequest } from '../api'
import { dueWordOf, kindKey, SHOWN_TONE } from '../model'

/**
 * The small parts of Supplier declarations both the list and the record draw: the status in words (a word with every colour),
 * the kind with the Candidate List day it asks about, and the due day with its countdown or how late it is. Nothing fetches.
 */

export function ShownPill({ shown }: { shown: DeclarationRequest['shown'] }) {
  const t = useT(DEPTH_NAMESPACE)
  return (
    <Pill tone={SHOWN_TONE[shown]} dot>
      {t(`shown.${shown}`)}
    </Pill>
  )
}

/** "SVHC · list of 1 Jul 2026" / "Nickel release". */
export function KindWords({ request }: { request: Pick<DeclarationRequest, 'kind' | 'svhcListVersion'> }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  return (
    <span className="fw-q-cell">
      <span>{t(kindKey(request.kind))}</span>
      {request.svhcListVersion && <span className="fw-q-hint">{t('decl.listOf', { day: formatDate(request.svhcListVersion.publishedOn, { locale }) })}</span>}
    </span>
  )
}

/** The due day and, while it waits, the countdown to it, or how many days late it is. */
export function DueWords({ request }: { request: Pick<DeclarationRequest, 'status' | 'dueOn' | 'overdueDays'> }) {
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const word = dueWordOf(request)
  return (
    <span className="fw-q-cell">
      <span>{formatDate(request.dueOn, { locale })}</span>
      {word.kind === 'late' && <Tag tone="danger">{t('decl.late', { count: word.days })}</Tag>}
      {word.kind === 'countdown' && (
        <span className="fw-q-hint">
          <Countdown to={word.to} announce={false} />
        </span>
      )}
    </span>
  )
}
