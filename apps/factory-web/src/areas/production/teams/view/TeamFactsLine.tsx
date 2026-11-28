'use client'

import type { ReactElement } from 'react'
import { Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { factMarksOf, markToneOf, markWordsOf, ORDER_TEAMS_NS, type RowFacts } from '../model'

/**
 * owb-ss7 (7.2; design § 5zd "each row says: the leader, the people, the baskets in work (and its limit), worked for this brand, takes
 * no new order, over its limit, missing today, late") — what the person in charge must know of a team before the yes, in one line
 * and its marks. A team's figures only; a small team (the API sent null) says so instead of a number.
 */
export function TeamFactsLine({ facts }: { facts: RowFacts }): ReactElement {
  const t = useT(ORDER_TEAMS_NS)
  const { worked, marks } = factMarksOf(facts)
  const load = facts.load
  const parts = [
    facts.leaderName ? t('facts.leader', { name: facts.leaderName }) : t('facts.noLeader'),
    facts.people !== null ? t('facts.people', { count: facts.people }) : null,
    load.kind === 'small' ? t('facts.small') : load.kind === 'of' ? t('facts.loadOf', { count: load.inWork, max: load.max }) : t('facts.load', { count: load.inWork }),
  ].filter((part): part is string => part !== null)
  return (
    <span className="fw-tm-facts">
      <span className="fw-tm-facts-l">{parts.join(' · ')}</span>
      {worked || marks.length > 0 ? (
        <span className="fw-tm-marks">
          {worked ? <Tag tone="success">{t('give.worked')}</Tag> : null}
          {marks.map((mark) => {
            const said = markWordsOf(mark)
            return (
              <Tag key={mark.code} tone={markToneOf(mark.code)}>
                {t(said.key, said.params)}
              </Tag>
            )
          })}
        </span>
      ) : null}
    </span>
  )
}
