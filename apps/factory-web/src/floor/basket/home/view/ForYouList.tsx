'use client'

import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, History, Image as ImageIcon, MessageSquare, UserCheck } from 'lucide-react'
import { FloorList, FloorListRow, type FloorTone } from '@nexus/ui/floor'
import { useT } from '../../../../lib/i18n/provider'
import type { ForYouItem, ForYouKind } from '../../api'
import { opensBasket } from '../../model'
import { BASKET_NS } from '../../parts'
import '../../basket.css'

/**
 * owb-fl5/fl6 (design § 5zg C "For you: ONE list … A news line is ONE tap: it opens the basket") — the worker's and the team leader's
 * ONE list: a changed design, an answer, a solved problem, a handover note; for the leader also the problems and the asks that wait.
 * Not drawn when empty. View only.
 */

const ITEM_LOOK: Readonly<Record<ForYouKind, { readonly tone: FloorTone; readonly icon: ReactNode }>> = {
  CHANGED_DESIGN: { tone: 'warning', icon: <ImageIcon /> },
  ANSWER: { tone: 'success', icon: <MessageSquare /> },
  SOLVED: { tone: 'info', icon: <CircleCheck /> },
  HANDOVER: { tone: 'primary', icon: <History /> },
  PROBLEM: { tone: 'danger', icon: <CircleAlert /> },
  ASK: { tone: 'primary', icon: <UserCheck /> },
}

export function ForYouList({ items, onOpen }: { readonly items: readonly ForYouItem[]; readonly onOpen: (item: ForYouItem) => void }) {
  const tb = useT(BASKET_NS)
  if (items.length === 0) return null
  return (
    <section className="fw-bk-stack fw-bk-list" aria-labelledby="fw-bk-foryou">
      <h2 id="fw-bk-foryou" className="fw-bk-sec">
        <span>{tb('homePage.forYou')}</span>
        <span className="fw-bk-count">{items.length}</span>
      </h2>
      <FloorList label={tb('homePage.forYou')}>
        {items.map((item) => (
          <FloorListRow
            key={`${item.kind}:${item.bundleId ?? '-'}:${item.at}`}
            icon={ITEM_LOOK[item.kind].icon}
            tone={ITEM_LOOK[item.kind].tone}
            title={tb(`item.${item.kind}`)}
            meta={
              <>
                {item.code ? <bdi className="fw-bk-code">{item.code}</bdi> : null}
                {item.code && item.words ? ' · ' : null}
                {item.words ? <bdi>{item.words}</bdi> : null}
              </>
            }
            {...(opensBasket(item) ? { onPress: () => onOpen(item) } : {})}
          />
        ))}
      </FloorList>
    </section>
  )
}
