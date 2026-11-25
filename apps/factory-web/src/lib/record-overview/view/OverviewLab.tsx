'use client'

import type { ReactNode } from 'react'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Banknote, CircleAlert, Hourglass, Pause, Ruler } from 'lucide-react' // F-CO-K2: the strips' marks
import type { Translate } from '../../i18n/messages'
import { useT } from '../../i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { OVERVIEW_NS } from '../model'
import { CardState, Headline, Overview, OverviewCard, OverviewPair } from '../Overview'
// ---- F-CO-K2: the rows' parts ----
import { Door, Fact, FactCols, Group, GroupRow, Groups, QuietLine, Row, RowAge, RowList, Strip, StripSaid, Strips, useOverviewWords } from '../Overview'
// ---- end F-CO-K2
import './overview-lab.css'

/**
 * F-CO-K1 (customer overview lane: the shared overview kit) — the kit's lab (`/design/record-overview`): every part alone, in a room
 * of each of three card widths (a phone's 343 px, a pair's card beside the docked thread 425 px, a full-width card 829 px), so a
 * part is looked at where it is narrow before a page draws it. The record is made up: neither an order nor a customer. Light and
 * dark, Italian and English are the gallery's own switches. The lab hands the parts data only — it styles no class of the kit.
 * F-CO-K2: the rows too — the strips (the three tones, five behind "Show 1 more", reading, failed with Try again, two doors, quiet
 * lines), the ONE list (plain, with doors, with a quiet line), the facts (one or two column sets by the room, the wide note), the
 * groups (three, a cut one with its door), and the frame with its rows together.
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
  // ---- F-CO-K2: the rows ----
  | 'strips-tones'
  | 'strips-more'
  | 'strips-reading'
  | 'strips-failed'
  | 'strips-doors'
  | 'strips-lines'
  | 'rows'
  | 'rows-doors'
  | 'rows-quiet'
  | 'facts'
  | 'facts-note'
  | 'groups'
  | 'groups-more'
  | 'overview-rows'

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
    default:
      return <RowsPart show={show} t={t} />
  }
}

// ---- F-CO-K2: the rows' cases — each part alone, then the frame with its rows (made-up words: no name, no number, no amount) ----
function RowsPart({ show, t }: { show: OverviewLabShow; t: Translate }): ReactNode {
  const words = useOverviewWords()
  const since = { iso: '2026-11-21T09:00:00Z', day: t('lab.day'), words: t('lab.age') }
  const door = (label: string, quiet = false) => (
    <Button size="sm" variant={quiet ? 'quiet' : 'secondary'} onClick={() => undefined}>
      {label}
    </Button>
  )
  const five = [
    <Strip key="yes" tone="warning" mark={<Hourglass size={14} aria-hidden />}>
      <StripSaid title={t('lab.stripYes')} since={since} />
    </Strip>,
    <Strip key="hold" tone="danger" mark={<CircleAlert size={14} aria-hidden />}>
      <StripSaid title={t('lab.stripHold')} lines={[t('lab.lineSteps')]} />
    </Strip>,
    <Strip key="pause" tone="info" mark={<Pause size={14} aria-hidden />}>
      <StripSaid title={t('lab.stripPause')} />
    </Strip>,
    <Strip key="deposit" tone="warning" mark={<Banknote size={14} aria-hidden />}>
      <StripSaid title={t('lab.stripDeposit')} />
    </Strip>,
    <Strip key="review" tone="warning" mark={<Ruler size={14} aria-hidden />}>
      <StripSaid title={t('lab.stripReview')} />
    </Strip>,
  ]
  const strips = (rows: readonly ReactNode[], more: { reading?: boolean; failed?: { words: string; onRetry?: () => void } | null } = {}) => <Strips label={t('lab.strips')} rows={rows} {...more} />
  const people = (
    <RowList>
      <Row label={t('lab.supervisor')} doors={door(t('lab.change'), true)}>
        <span>{t('lab.sampleRoom')}</span>
      </Row>
      <Row label={t('lab.backup')}>
        <span>{t('lab.planning')}</span>
      </Row>
      <Row label={t('lab.madeAt')}>
        <span>{t('lab.lineTwo')}</span>
      </Row>
    </RowList>
  )
  const linked = (
    <RowList label={t('lab.linked')}>
      <Row label={t('lab.requests')} doors={door(t('lab.answer'))}>
        <a className="fw-ro-link" href={`#${LAB_ID}`}>
          {words.door(t('lab.groupUs'))}
        </a>
      </Row>
      <Row label={t('lab.planning')} doors={null}>
        <span>{t('lab.lineTwo')}</span>
      </Row>
      <QuietLine>{words.none(t('lab.kinds'))}</QuietLine>
      <QuietLine>{words.labelled(t('lab.from'), t('lab.sampleRoom'))}</QuietLine>
    </RowList>
  )
  const facts = (note: boolean) => (
    <FactCols>
      <Fact label={t('lab.season')} value={t('lab.seasonValue')} door={(describedBy) => <Door label={t('lab.set')} held={null} describedBy={describedBy} onClick={() => undefined} />} />
      <Fact label={t('lab.priority')} value={t('lab.priorityValue')} door={(describedBy) => <Door label={t('lab.set')} held={t('lab.problem')} describedBy={describedBy} onClick={() => undefined} />} />
      <Fact label={t('lab.terms')} value={t('lab.termsValue')} door={() => <span className="fw-ro-hint">{t('lab.fixed')}</span>} />
      <Fact label={t('lab.madeAt')} value={t('lab.lineTwo')} door={null} />
      {note ? <Fact wide label={t('lab.note')} value={t('lab.noteValue')} door={(describedBy) => <Door label={t('lab.change')} held={null} describedBy={describedBy} onClick={() => undefined} />} /> : null}
    </FactCols>
  )
  const age = <RowAge since="2026-11-03T09:00:00Z" words={t('lab.ageRow')} title={t('lab.since')} />
  const groups = (more: boolean) => (
    <Groups>
      <Group title={t('lab.groupUs')}>
        <GroupRow age={age} doors={door(t('lab.answer'))}>
          {t('lab.rowSize')}
        </GroupRow>
        <GroupRow age={<RowAge since={null} words={null} />} doors={door(t('lab.answer'))}>
          {t('lab.rowDate')}
        </GroupRow>
      </Group>
      <Group title={t('lab.groupThem')}>
        <GroupRow age={age} doors={null}>
          {t('lab.rowLining')}
        </GroupRow>
      </Group>
      <Group
        title={t('lab.groupStill')}
        more={
          more ? (
            <a className="fw-ro-link fw-ro-hint" href={`#${LAB_ID}`}>
              {t('lab.more')}
            </a>
          ) : undefined
        }
      >
        {[t('lab.rowSize'), t('lab.rowDate'), t('lab.rowLining')].map((said) => (
          <GroupRow key={said} age={age}>
            {said}
          </GroupRow>
        ))}
      </Group>
    </Groups>
  )
  const lead = (body: ReactNode) => (
    <OverviewCard lead title={t('lab.where')} aside={<span className="fw-ro-hint">{t('lab.fresh')}</span>}>
      <Headline sentence={t('lab.sentence')} quiet={t('lab.quiet')} />
      {body}
    </OverviewCard>
  )
  switch (show) {
    case 'strips-tones':
      return lead(strips(five.slice(0, 3)))
    case 'strips-more':
      return lead(strips(five))
    case 'strips-reading':
      return lead(strips(five.slice(0, 1), { reading: true }))
    case 'strips-failed':
      return lead(strips(five.slice(0, 1), { failed: { words: t('lab.failed'), onRetry: () => undefined } }))
    case 'strips-doors': {
      const doors = (
        <>
          {door(t('lab.lift'))}
          {door(t('lab.open'), true)}
        </>
      )
      return lead(
        strips([
          <Strip key="hold" tone="danger" mark={<CircleAlert size={14} aria-hidden />} doors={doors}>
            <StripSaid title={t('lab.stripHold')} since={since} lines={[t('lab.lineSteps')]} />
          </Strip>,
        ]),
      )
    }
    case 'strips-lines':
      return lead(
        strips([
          <Strip key="hold" tone="danger" mark={<CircleAlert size={14} aria-hidden />}>
            <StripSaid title={t('lab.stripHold')} since={since} lines={[t('lab.lineSteps'), t('lab.lineWho')]} />
          </Strip>,
        ]),
      )
    case 'rows':
      return (
        <OverviewCard title={t('lab.people')} aside={null}>
          <RowList>
            <Row label={t('lab.backup')}>
              <span>{t('lab.planning')}</span>
            </Row>
            <Row label={t('lab.madeAt')}>
              <span>{t('lab.lineTwo')}</span>
            </Row>
          </RowList>
        </OverviewCard>
      )
    case 'rows-doors':
      return (
        <OverviewCard title={t('lab.people')} aside={null}>
          {people}
        </OverviewCard>
      )
    case 'rows-quiet':
      return <OverviewCard title={t('lab.linked')}>{linked}</OverviewCard>
    case 'facts':
      return <OverviewCard title={t('lab.facts')}>{facts(false)}</OverviewCard>
    case 'facts-note':
      return <OverviewCard title={t('lab.facts')}>{facts(true)}</OverviewCard>
    case 'groups':
      return <OverviewCard title={t('lab.requests')}>{groups(false)}</OverviewCard>
    case 'groups-more':
      return <OverviewCard title={t('lab.requests')}>{groups(true)}</OverviewCard>
    default:
      // overview-rows: the frame with its rows — the lead card with its strips, then the pairs.
      return (
        <>
          {lead(strips(five))}
          <OverviewPair>
            <OverviewCard title={t('lab.people')} aside={null}>
              {people}
            </OverviewCard>
            <OverviewCard title={t('lab.linked')}>{linked}</OverviewCard>
          </OverviewPair>
          <OverviewPair>
            <OverviewCard title={t('lab.requests')}>{groups(true)}</OverviewCard>
          </OverviewPair>
          <OverviewPair>
            <OverviewCard title={t('lab.facts')}>{facts(true)}</OverviewCard>
          </OverviewPair>
        </>
      )
  }
}
// ---- end F-CO-K2
