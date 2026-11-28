'use client'

import Link from 'next/link'
import { Ban, Clock, Info } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../../../lib/record-sections/Kit'
import { Fold } from '../../../../orders/record/money/view/parts'
import { placedLine, releasedLine, type HoldRow, type ReleasedRow, type WaitingRow } from '../../terms/holds'
import { said, termsKitId, text, type Said, type Say } from '../../terms/model'
import type { TermsTabActions, TermsTabModel } from '../../terms/tab'
import { actItem, menuOf, useTermsSay } from './say'
import { SectionAnswer } from './TermsAnswer' // ct-fx3 G-W09: a chip with no rows marks its section's answer line

/**
 * F-CT-303 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §5.1; 18-lead-settles Z10, Z22, Z27, Z31) — section 1, Hold
 * (#party-hold), ALWAYS first. Not on hold: ONE quiet line ("Not on hold: new orders and shipments go ahead" + "Released before (n) ›")
 * and Put on hold… in the head. On hold: what stops and what goes on (a DS danger Banner), each hold in force (reason, company, why —
 * its cause as a door for missing data without an identity —, since when and by whom, Release…), the accepted quotes that wait for the
 * release with the door to Quotes, the released ones folded. The window is the depth provider's own (HoldDialogView, the one Money
 * opens), mounted by the tab as it is. Rows lay out by the LIST's room (terms.css), never the screen. Draws its model; reads nothing.
 */

export function HoldSection({ model, actions }: { model: TermsTabModel; actions?: TermsTabActions | undefined }) {
  const say = useTermsSay()
  const hold = model.hold
  const title = say(said('sales-customers-depth:hold.title'))
  const marked = new Set(model.marked)
  const buttons =
    hold.placeInHead && hold.place.shown
      ? [
          <Button key="place" size="sm" heldReason={hold.place.held ? say(hold.place.held) : null} onClick={() => actions?.onPlaceHold?.()}>
            <Ban size={14} aria-hidden /> {say(said('sales-customers-depth:hold.place'))}
          </Button>,
        ]
      : []
  const more = menuOf([
    [hold.placeInHead ? null : actItem('another', said('ct.hold.another'), hold.place, say, () => actions?.onPlaceHold?.())],
    [hold.released.length > 0 ? { id: 'released', label: say(hold.releasedOpen ? said('ct.hold.hideReleased') : said('ct.hold.releasedFold', { params: { count: hold.released.length } })), onSelect: () => actions?.onFold?.('released', !hold.releasedOpen) } : null],
    [hold.waiting.total > 0 ? { id: 'quotes', label: say(said('ct.hold.orderWaitsDoor')), href: hold.waiting.door } : null],
    [{ id: 'link', label: say(said('ct.copyLink', { params: { section: title } })), onSelect: () => actions?.onCopyLink?.('party-hold') }],
  ])
  const head = {
    id: termsKitId('party-hold'),
    title,
    buttons,
    more: <LineMenuButton label={say(said('ct.more', { params: { section: title } }))} items={more} />,
    info: (
      <>
        <p>{say(said('ct.hold.info.what'))}</p>
        <p>{say(said('ct.hold.info.release'))}</p>
        <p>{say(said('ct.hold.info.block'))}</p>
        <p>{say(said('ct.keys'))}</p>
      </>
    ),
  }
  if (hold.reading)
    return (
      <Section {...head} answer={say(said('ct.reading'))}>
        <PartReading rows={1} height={26} />
      </Section>
    )
  if (hold.problem)
    return (
      <Section {...head}>
        <PartFailed part={say(said('ct.hold.part'))} problem={hold.problem} onRetry={actions?.onRetryHolds} />
      </Section>
    )
  const released = hold.releasedOpen && hold.released.length > 0 ? <ReleasedList rows={hold.released} say={say} /> : null
  if (hold.inForce.length === 0)
    return (
      <Section
        {...head}
        answer={
          <>
            {hold.answer ? say(hold.answer) : null}
            {hold.released.length > 0 ? (
              <>
                {' '}
                <Button size="sm" variant="link" aria-expanded={hold.releasedOpen} onClick={() => actions?.onFold?.('released', !hold.releasedOpen)}>
                  {say(hold.releasedOpen ? said('ct.hold.hideReleased') : said('ct.hold.releasedInline', { params: { count: hold.released.length } }))}
                </Button>
              </>
            ) : null}
          </>
        }
      >
        {released}
      </Section>
    )
  const waiting = hold.waiting
  const waitBlock = waiting.byReason ? hold.waitingForHold > 0 : waiting.total > 0
  return (
    <Section {...head} answer={hold.answer ? <SectionAnswer marked={marked.has('party-hold')}>{say(hold.answer)}</SectionAnswer> : undefined}>
      {hold.stops ? <Banner tone="danger" icon={<Ban size={18} aria-hidden />} title={say(hold.stops.title)}>{say(hold.stops.desc)}</Banner> : null}
      <div className="fw-ctr-ls" role="list" aria-label={say(said('sales-customers-depth:hold.inForce'))}>
        <div className="fw-ctr-hd is-h" aria-hidden>
          <div className="fw-ctr-who">{say(said('sales-customers-depth:hold.col.reason'))}</div>
          <div className="fw-ctr-why">{say(said('sales-customers-depth:hold.col.words'))}</div>
          <div className="fw-ctr-when">{say(said('ct.hold.since'))}</div>
          <div className="fw-ctr-act" />
          <div className="fw-ctr-o" />
        </div>
        {hold.inForce.map((row) => (
          <HoldRowView key={row.id} row={row} marked={marked.has(row.anchor)} say={say} actions={actions} />
        ))}
      </div>
      {waitBlock ? (
        <div className="fw-pt-blk">
          <h3 className="fw-pt-h3">
            <Clock size={14} aria-hidden />
            <span>{say(waiting.byReason ? said('ct.hold.waitingTitle', { params: { count: hold.waitingForHold } }) : said('sales-customers-depth:hold.waiting', { params: { count: waiting.total } }))}</span>
          </h3>
          {waiting.rowsShown && waiting.hold.length > 0 ? <WaitingList rows={waiting.hold} marked={marked} say={say} label={said('ct.hold.waitingList')} tag={said('ct.hold.waitsTag')} /> : null}
          <p className="fw-pt-hint">
            <Info size={13} aria-hidden />
            <span>
              {say(said('ct.hold.waitingHint'))}{' '}
              <Link className="fw-pt-link" href={waiting.door}>
                {say(said('ct.hold.orderWaitsDoor'))}
              </Link>
            </span>
          </p>
        </div>
      ) : null}
      {hold.released.length > 0 ? (
        <div className="fw-ctr-foldw">
          <Fold open={hold.releasedOpen} onToggle={() => actions?.onFold?.('released', !hold.releasedOpen)} label={say(said('ct.hold.releasedFold', { params: { count: hold.released.length } }))} />
        </div>
      ) : null}
      {released}
    </Section>
  )
}

function HoldRowView({ row, marked, say, actions }: { row: HoldRow; marked: boolean; say: Say; actions?: TermsTabActions | undefined }) {
  const reason = said(`sales-customers-depth:reason.${row.reason}`)
  const items = menuOf([
    [actItem('release', said('sales-customers-depth:hold.release'), row.release, say, () => actions?.onReleaseHold?.(row.hold))],
    [row.cause ? { id: 'cause', label: say(said('ct.hold.causeMenu')), href: '#party-identity' } : null],
    [{ id: 'link', label: say(said('ct.hold.copyLink')), onSelect: () => actions?.onCopyLink?.(row.anchor) }],
  ])
  return (
    <div id={row.anchor} className={`fw-ctr-row is-h${marked ? ' is-mark' : ''}`} role="listitem">
      <div className="fw-ctr-who">
        <span className="fw-ctr-name">
          <Tag tone="danger">
            <Ban size={12} aria-hidden /> {say(reason)}
          </Tag>
        </span>
        <span className="fw-ctr-sub">{say(row.company === null ? said('sales-customers-depth:hold.everyCompany') : said('ct.hold.with', { params: { company: row.company } }))}</span>
      </div>
      <div className="fw-ctr-why">
        <span>{row.words}</span>
        {row.cause ? (
          <a className="fw-pt-link" href="#party-identity">
            {say(said('ct.hold.cause'))}
          </a>
        ) : null}
      </div>
      <div className="fw-ctr-when">
        <span>{say(said('ct.hold.sinceDate', { days: { date: row.since } }))}</span>
        <span className="fw-ctr-sub">{say(row.by ? said('ct.hold.by', { params: { name: row.by } }) : said('ct.hold.byCheck'))}</span>
      </div>
      <div className="fw-ctr-act">
        {row.release.shown ? (
          <Button size="sm" heldReason={row.release.held ? say(row.release.held) : null} onClick={() => actions?.onReleaseHold?.(row.hold)}>
            {say(said('sales-customers-depth:hold.release'))}
          </Button>
        ) : null}
      </div>
      <div className="fw-ctr-o">
        <LineMenuButton label={say(said('ct.hold.rowMore', { lower: { reason } }))} items={items} />
      </div>
    </div>
  )
}

/** The accepted quotes that wait (for the hold here, for a PO number under Ordering rules): the quote, their PO, the company, why. */
export function WaitingList({ rows, marked, say, label, tag }: { rows: readonly WaitingRow[]; marked: ReadonlySet<string>; say: Say; label: Said; tag: Said }) {
  return (
    <div className="fw-ctr-ls" role="list" aria-label={say(label)}>
      {rows.map((row) => (
        <div key={row.id} id={row.anchor} className={`fw-ctr-row is-w${marked.has(row.anchor) ? ' is-mark' : ''}`} role="listitem">
          <div>
            <Link className="fw-pt-link" href={row.href}>
              {`${say(row.quote)} ›`}
            </Link>
          </div>
          <div>{row.ref ? <span>{say(said('ct.hold.theirPo', { params: { ref: row.ref } }))}</span> : <span className="fw-ctr-none">{say(said('ct.hold.noPo'))}</span>}</div>
          <div>
            <span>{row.company}</span>
          </div>
          <div>
            <Tag tone="warning">
              <Clock size={12} aria-hidden /> {say(tag)}
            </Tag>
          </div>
        </div>
      ))}
    </div>
  )
}

function ReleasedList({ rows, say }: { rows: readonly ReleasedRow[]; say: Say }) {
  return (
    <div className="fw-ctr-ls" role="list" aria-label={say(said('sales-customers-depth:hold.history'))}>
      {rows.map((row) => (
        <div key={row.id} className="fw-ctr-row is-e" role="listitem">
          <div>
            <span className="fw-ctr-name">
              <Tag tone="neutral">{say(said(`sales-customers-depth:reason.${row.reason}`))}</Tag>
              <span>{say(row.company === null ? said('sales-customers-depth:hold.everyCompany') : text(row.company))}</span>
            </span>
            <span>{say(releasedLine(row))}</span>
            <span className="fw-ctr-sub">{say(placedLine(row))}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
