'use client'

import type { ReactNode } from 'react'
import { Skeleton } from '@nexus/ui/primitives'
import type { Translate } from '../../../../lib/i18n/messages'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { OVERVIEW_NS } from '../model'
import { CardState, Headline, Overview, OverviewCard, OverviewPair } from '../Overview'
import './overview-lab.css'

/**
 * F-CO-K1 (customer overview lane: the shared overview kit) — the kit's lab (`/design/record-overview`): every part alone, in a room
 * of each of three card widths (a phone's 343 px, a pair's card beside the docked thread 425 px, a full-width card 829 px), so a
 * part is looked at where it is narrow before a page draws it. The record is made up: neither an order nor a customer. Light and
 * dark, Italian and English are the gallery's own switches. The lab hands the parts data only — it styles no class of the kit.
 */
export type OverviewLabShow =
  | 'card'
  | 'card-aside'
  | 'card-aside-none'
  | 'card-lead'
  | 'card-busy'
  | 'state-loading'
  | 'state-failed'
  | 'state-failed-no-retry'
  | 'headline'
  | 'headline-quiet'
  | 'headline-reading'
  | 'pair-two'
  | 'pair-one'
  | 'overview'

export interface OverviewLabModel {
  /** The part (and its state) the case shows. */
  readonly show: OverviewLabShow
}

/** The rooms' widths in px: the Overview's own width in each (a card alone takes it whole). */
export const LAB_WIDTHS: readonly number[] = [343, 425, 829]

/** The lab's own address inside the frame: its links stay on it. */
const LAB_ID = 'record-overview-lab'

export function OverviewLab({ model }: { model: OverviewLabModel }): ReactNode {
  return (
    <WithMessages namespaces={[OVERVIEW_NS]}>
      <Lab show={model.show} />
    </WithMessages>
  )
}

function Lab({ show }: { show: OverviewLabShow }): ReactNode {
  const t = useT(OVERVIEW_NS)
  return (
    <div className="fw-rol" id={LAB_ID}>
      {LAB_WIDTHS.map((width) => (
        <section key={width} className="fw-rol-room" style={{ width }} aria-label={t('lab.room', { width })}>
          <p className="fw-rol-label">{t('lab.room', { width })}</p>
          <Overview>
            <Part show={show} t={t} />
          </Overview>
        </section>
      ))}
    </div>
  )
}

/** One case: the part alone, or the frame's parts together. */
function Part({ show, t }: { show: OverviewLabShow; t: Translate }): ReactNode {
  const body = <p className="fw-ro-hint">{t('lab.body')}</p>
  // A link at a head's right: the kit's link and hint on one element (it takes the link's colour).
  const link = (
    <a className="fw-ro-link fw-ro-hint" href={`#${LAB_ID}`}>
      {t('lab.link')}
    </a>
  )
  const fresh = <span className="fw-ro-hint">{t('lab.fresh')}</span>
  const rows = (
    <div className="fw-ro-stack" role="status" aria-label={t('state.loading', { part: t('lab.linked') })}>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} height={22} />
      ))}
    </div>
  )
  switch (show) {
    case 'card':
      return <OverviewCard title={t('lab.linked')}>{body}</OverviewCard>
    case 'card-aside':
      return (
        <OverviewCard title={t('lab.dates')} aside={link}>
          {body}
        </OverviewCard>
      )
    case 'card-aside-none':
      return (
        <OverviewCard title={t('lab.people')} aside={null}>
          {body}
        </OverviewCard>
      )
    case 'card-lead':
      return (
        <OverviewCard lead title={t('lab.where')} aside={fresh}>
          <Headline sentence={t('lab.sentence')} quiet={t('lab.quiet')} />
          {body}
        </OverviewCard>
      )
    case 'card-busy':
      return (
        <OverviewCard busy title={t('lab.linked')}>
          {rows}
        </OverviewCard>
      )
    case 'state-loading':
      return <CardState part={t('lab.people')} problem={null} />
    case 'state-failed':
      return <CardState part={t('lab.people')} problem={t('lab.problem')} onRetry={() => undefined} />
    case 'state-failed-no-retry':
      return <CardState part={t('lab.people')} problem={t('lab.problem')} />
    case 'headline':
      return (
        <OverviewCard lead title={t('lab.where')} aside={fresh}>
          <Headline sentence={t('lab.sentence')} />
        </OverviewCard>
      )
    case 'headline-quiet':
      return (
        <OverviewCard lead title={t('lab.where')} aside={fresh}>
          <Headline sentence={t('lab.sentence')} quiet={t('lab.quiet')} />
        </OverviewCard>
      )
    case 'headline-reading':
      return (
        <OverviewCard lead title={t('lab.where')} aside={fresh}>
          <Headline sentence={null} quiet={t('lab.quiet')} />
        </OverviewCard>
      )
    case 'pair-two':
      return (
        <OverviewPair>
          <OverviewCard title={t('lab.people')} aside={null}>
            {body}
          </OverviewCard>
          <OverviewCard title={t('lab.dates')} aside={link}>
            {body}
          </OverviewCard>
        </OverviewPair>
      )
    case 'pair-one':
      return (
        <OverviewPair>
          <OverviewCard title={t('lab.linked')}>{body}</OverviewCard>
        </OverviewPair>
      )
    case 'overview':
      return (
        <>
          <OverviewCard lead title={t('lab.where')} aside={fresh}>
            <Headline sentence={t('lab.sentence')} quiet={t('lab.quiet')} />
          </OverviewCard>
          <OverviewPair>
            <OverviewCard title={t('lab.people')} aside={null}>
              {body}
            </OverviewCard>
            <OverviewCard title={t('lab.dates')} aside={link}>
              {body}
            </OverviewCard>
          </OverviewPair>
          <OverviewPair>
            <OverviewCard title={t('lab.linked')}>{body}</OverviewCard>
          </OverviewPair>
        </>
      )
  }
}
