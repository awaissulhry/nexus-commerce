'use client'

import Link from 'next/link'
import { Snowflake } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { CountLine, CountRecord } from '../../api'
import type { BlockedPlace } from '../api'
import { DEPTH_NAMESPACE } from '../model'

/**
 * B-W2b-320 — the count record's W2b parts (SCR-132-record; design rec:Count/lines "W2b: frozen lines block moves of the
 * counted items at that location", SCM-226; conn "Locations (blocked during a count)"): the band's freeze tag, and above
 * the Lines the note of what a frozen count holds (how many lines of those read hold their moves now) with the places the
 * count blocks, each a link to its place.
 */

export const useCountsLinesWords = () => useT(DEPTH_NAMESPACE)

export function FreezeTag() {
  const t = useT(DEPTH_NAMESPACE)
  return (
    <Tag tone="info">
      <Snowflake size={12} aria-hidden /> {t('cd.lines.freezes')}
    </Tag>
  )
}

export function FrozenNote({ value, lines, blocked, prefix }: { value: CountRecord; lines: readonly CountLine[] | null; blocked: readonly BlockedPlace[] | null; prefix: string }) {
  const t = useT(DEPTH_NAMESPACE)
  const frozen = (lines ?? []).filter((line) => line.frozen).length
  const places = blocked ?? []
  if (!value.freezeMoves && places.length === 0) return null
  return (
    <Banner tone="info" title={value.freezeMoves ? (value.status === 'COUNTING' ? t('cd.lines.frozenTitle', { count: frozen }) : value.status === 'DRAFT' ? t('cd.lines.freezeLater') : t('cd.lines.freezeDone')) : t('cd.lines.blockedTitle', { count: places.length })}>
      <span className="fw-cn-hint">
        {value.freezeMoves ? t('cd.lines.frozenBody') : null}
        {places.length > 0 && (
          <>
            {value.freezeMoves ? ' ' : null}
            {t('cd.lines.places')}{' '}
            {places.map((place, index) => (
              <span key={place.id}>
                {index > 0 ? ', ' : null}
                <Link className="fw-st-link fw-cn-code" href={`${prefix}${recordAddress({ type: 'Location', id: place.id }, OFFICE_PAGES)}`}>
                  {place.code}
                </Link>
              </span>
            ))}
          </>
        )}
      </span>
    </Banner>
  )
}
