'use client'

import { FileText, Image as ImageIcon, Lock, Send, Users } from 'lucide-react'
import type { OrderLife } from '@nexus/factory-domain/sales/order-life'
import { Banner } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { useRecordPicture } from '../../../../../../lib/record-picture/use-record-picture'
import type { ReadPictures } from '../../../../../../lib/record-picture/cache'
import { DeptStrip } from '../../../../../../lib/department/view/DeptStrip'
import type { Department } from '../../../../../../lib/department/model'
import { OverviewCard } from '../../../../../../lib/record-overview/Overview'
import { useFlowWords } from '../../flow-words'
import type { TextCard } from '../../band/model'
import './flow-parts.css'

/**
 * owb-of5 step 2 (design plan § 5i, § 5g; prototype rec.js orderBody overview, mockViewer, nextBox, orderTextCard) — the Overview's new
 * parts, drawn in today's cards (the section kit): "Where it is now" gets the mockup (the order's picture as a whole A4 page, never
 * cut), the next box (the next step in plain words) and the departments strip (S5's baskets per department); Order facts gets "On the
 * floor" with Restrict on the floor / Open it to the department (orders.manage: sales and the owner, never the designer); People gets
 * Add people and "Give the graphics to the designer" (the conversation's followers door); a text order gets "The order as it was
 * written". Draws its model; fetches nothing (the picture's read is the container's port).
 */

/** The mockup: the order's picture whole (an A4 page, contain), or one quiet line while there is none. */
export function MockupViewer({ orderId, number, read }: { readonly orderId: string; readonly number: string; readonly read: ReadPictures | null }) {
  const f = useFlowWords()
  const { src } = useRecordPicture({ source: 'order', recordId: orderId, read })
  return (
    <figure className="fw-flow-mock">
      {src ? (
        <img src={src} alt={f('mockup.alt', { number })} loading="lazy" />
      ) : (
        <span className="fw-flow-mock-none">
          <ImageIcon size={24} aria-hidden />
          <span>{f('mockup.none')}</span>
        </span>
      )}
    </figure>
  )
}

/** The next step in plain words, by the order's life (prototype nextBox): what happens next and who does it. */
export function NextBox({ life, act }: { readonly life: OrderLife; /** The band's act words when this reader may do it (one door, the band's). */ readonly act?: string | null }) {
  const f = useFlowWords()
  return (
    <div className="fw-flow-next" role="note">
      <span className="fw-flow-next-h">{f('next.title')}</span>
      <span>{f(`next.${life}`)}</span>
      {act ? <span className="fw-flow-next-act">{f('next.yours', { act })}</span> : null}
    </div>
  )
}

/** The mockup beside the next box and the departments strip (the hero of "Where it is now"; one column in a narrow card). */
export function WhereHero({ orderId, number, read, life, act, departments }: { readonly orderId: string; readonly number: string; readonly read: ReadPictures | null; readonly life: OrderLife; readonly act?: string | null; readonly departments: readonly { readonly dept: Department; readonly count: number }[] | null }) {
  return (
    <div className="fw-flow-hero">
      <MockupViewer orderId={orderId} number={number} read={read} />
      <div className="fw-flow-hero-side">
        <NextBox life={life} act={act} />
        {life === 'IN_PRODUCTION' && departments && departments.length > 0 ? <DeptStrip tiles={departments} kind="baskets" /> : null}
      </div>
    </div>
  )
}

/** "On the floor": the department sees the order, or only the named workers; Restrict on the floor / Open it to the department. */
export function FloorFact({ restricted, may, busy, problem, onRestrict }: { readonly restricted: { readonly by: string; readonly at: string } | null; readonly may: boolean; readonly busy: boolean; readonly problem: string | null; readonly onRestrict?: (restricted: boolean) => void }) {
  const f = useFlowWords()
  const locale = useLocale()
  return (
    <div className="fw-flow-floor">
      <span className="fw-flow-floor-label">{f('floor.label')}</span>
      <span className="fw-flow-floor-value">
        {restricted ? (
          <>
            <Tag tone="danger">
              <Lock size={12} aria-hidden /> {f('floor.restricted')}
            </Tag>{' '}
            <span className="fw-so-hint">{f('floor.by', { name: restricted.by, at: formatDateTime(restricted.at, { locale }) })}</span>
          </>
        ) : (
          f('floor.open')
        )}
      </span>
      {/* A button you may not use is not drawn (the designer, a reader): only orders.manage (sales and the owner, L6). */}
      {may ? (
        <Button size="sm" variant="quiet" heldReason={busy ? f('floor.busy') : null} onClick={() => onRestrict?.(!restricted)}>
          {restricted ? <Users size={14} aria-hidden /> : <Lock size={14} aria-hidden />} {restricted ? f('floor.lift') : f('floor.restrict')}
        </Button>
      ) : null}
      {problem ? <Banner tone="danger" title={problem === 'restrict.failed' ? f('floor.failed') : problem} /> : null}
    </div>
  )
}

/** People's two doors (prototype: Add people · Give the graphics to the designer): the conversation's followers, where it lives. */
export function PeopleDoors({ onFollowers, designer }: { readonly onFollowers: () => void; /** "Give the graphics to the designer": sales, before the print. */ readonly designer: boolean }) {
  const f = useFlowWords()
  return (
    <div className="fw-flow-peopledoors">
      <Button size="sm" variant="quiet" onClick={onFollowers}>
        {f('people.add')}
      </Button>
      {designer ? (
        <Button size="sm" variant="quiet" onClick={onFollowers}>
          {f('people.designer')}
        </Button>
      ) : null}
    </div>
  )
}

/** "The order as it was written" (design § 5g): the customer's subject and text, its lines in its own words, its files. */
export function OrderTextCard({ card }: { readonly card: TextCard }) {
  const f = useFlowWords()
  return (
    <OverviewCard title={f('text.title')}>
      <div className="fw-flow-text">
        {card.subject ? <p className="fw-flow-text-subject">{card.subject}</p> : null}
        {card.text ? <p className="fw-flow-text-body">{card.text}</p> : null}
        {card.lines.length > 0 ? (
          <ul className="fw-flow-text-lines" aria-label={f('text.lines')}>
            {card.lines.map((line) => (
              <li key={line.seq}>
                <span className="fw-so-hint">{f('text.line', { seq: line.seq })}</span> {line.words}
              </li>
            ))}
          </ul>
        ) : null}
        {card.files.length > 0 ? (
          <ul className="fw-flow-text-files" aria-label={f('text.files')}>
            {card.files.map((file) => (
              <li key={file.id}>
                <FileText size={14} aria-hidden /> {file.name}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </OverviewCard>
  )
}

/**
 * owb-of7 step 2 (design plan § 5f, § 5zk; prototype office.js designAsk) — "Send the design for approval": ONE `POST /approvals-out`
 * (kind ARTWORK on the order, its picture as the mockup); the state then shows as the band's Design tag (waits / approved / change).
 * Drawn only for who may (partners.approvals.ask + orders.manage); held in words while the order has no picture or a request waits.
 */
export function SendDesignDoor({ design, onSend }: { readonly design: { readonly state: 'WAITS' | 'APPROVED' | 'CHANGE' | null; readonly may: boolean; readonly held: string | null; readonly busy: boolean; readonly problem: string | null }; readonly onSend?: () => void }) {
  const f = useFlowWords()
  if (!design.may) return null
  return (
    <div className="fw-flow-design">
      <Button size="sm" variant="secondary" heldReason={design.busy ? f('design.busy') : design.held ? f(design.held) : null} onClick={() => onSend?.()}>
        <Send size={14} aria-hidden /> {f('design.send')}
      </Button>
      {design.state ? <span className="fw-so-hint">{f(`design.state.${design.state}`)}</span> : null}
      {design.problem ? <Banner tone="danger" title={design.problem === 'design.failed' ? f('design.failed') : design.problem} /> : null}
    </div>
  )
}
