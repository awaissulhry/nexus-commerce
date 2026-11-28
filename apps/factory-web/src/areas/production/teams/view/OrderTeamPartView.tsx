'use client'

import type { ReactElement } from 'react'
import { Hand, Users } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { sourceOfPicture } from '../../../../lib/people-picture/schema'
import { TeamChip } from '../../../../lib/people-picture/view/TeamChip'
import { PartReading, Quiet, Section } from '../../../../lib/record-sections/Kit'
import { ORDER_TEAMS_NS, type PartModel } from '../model'
import '../teams.css'

/**
 * owb-ss7 (7.3; design § 5za "an order has its team"; prototype teams.js teamSec) — the part "Team" of the order's Production tab, drawn
 * with the tab's own section kit: the team(s) as team chips (the leader, "In charge" when several work together, the baskets of each
 * when they split), "Given by its order structure" when a rule gave it, and the ONE button the person may press — Give to a team… /
 * Change… (the production manager) or Ask for another team (sales; then "Asked: the production manager answers"). Empty: "No team
 * yet" and that one button. Draws one model; fetches nothing. The customer never reaches it (office only).
 */

export interface OrderTeamPartViewModel {
  readonly state: 'reading' | 'failed' | 'ready'
  /** The read's failure (a key of `order-teams`). */
  readonly problem: string | null
  readonly part: PartModel | null
}

export interface OrderTeamPartActions {
  readonly onGive: () => void
  readonly onAsk: () => void
  readonly onRetry: () => void
}

export function OrderTeamPartView({ model, actions }: { model: OrderTeamPartViewModel; actions?: OrderTeamPartActions }): ReactElement {
  const t = useT(ORDER_TEAMS_NS)
  const part = model.part
  const button =
    part?.button === 'GIVE' || part?.button === 'CHANGE' ? (
      <Button key="give" size="sm" onClick={() => actions?.onGive()}>
        <Users size={14} aria-hidden />
        {t(part.button === 'GIVE' ? 'part.give' : 'part.change')}
      </Button>
    ) : part?.button === 'ASK' ? (
      <Button key="ask" size="sm" onClick={() => actions?.onAsk()}>
        <Hand size={14} aria-hidden />
        {t('part.ask')}
      </Button>
    ) : null
  return (
    <Section id="team" title={t('part.title')} answer={part ? t(part.answer.key, part.answer.params) : undefined} buttons={button ? [button] : []} info={t('part.info')}>
      {model.state === 'reading' ? (
        <PartReading rows={1} />
      ) : model.state === 'failed' || !part ? (
        <Banner
          tone="danger"
          title={t('part.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem ?? 'error.read')}
        </Banner>
      ) : (
        <div className="fw-otm">
          {part.chips.length > 0 ? (
            <ul className="fw-otm-chips">
              {part.chips.map((chip) => (
                <li key={chip.face.id} className="fw-otm-chip">
                  <TeamChip team={sourceOfPicture(chip.face.name, chip.face.picture, 'team')} />
                  <span className="fw-otm-sub">
                    {[
                      chip.leaderName ? t('part.leader', { name: chip.leaderName }) : t('part.noLeader'),
                      chip.share !== null ? t(part.soon ? 'part.shareSoon' : 'part.share', { count: chip.share }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {chip.inCharge ? <Tag tone="info">{t('part.inCharge')}</Tag> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {part.byRule ? <Quiet>{t('part.byRule')}</Quiet> : null}
          {part.button === 'ASKED' ? (
            <p className="fw-otm-asked" role="status">
              {t('part.asked')}
            </p>
          ) : null}
        </div>
      )}
    </Section>
  )
}
