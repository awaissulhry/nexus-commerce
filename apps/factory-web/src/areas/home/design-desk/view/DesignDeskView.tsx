'use client'

import Link from 'next/link'
import { Factory, Hourglass, Image as ImageIcon, ScanLine } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { Quiet, Section } from '../../../../lib/record-sections/Kit'
import { RecordPicture } from '../../../../lib/record-picture/view/RecordPicture'
import type { ReadPictures } from '../../../../lib/record-picture/cache'
import { WindowShell } from '../../../../lib/window-shell/view/WindowShell'
import { PlaceScanCodeWindow } from '../../../sales/orders/record/print/PlaceScanCodeWindow'
import type { DeskRead } from '../api'
import { DESK_SECTIONS, deskAnchorOf, deskHrefOf, deskTilesOf, placedOf, type DeskSection } from '../model'
import './design-desk.css'

/** The page's own words (messages/<locale>/design-desk.json). */
export const DESK_NS = 'design-desk'

export interface DesignDeskModel {
  readonly prefix: string
  readonly companyId: string | null
  /** The read: loading, failed (its words) or ready. */
  readonly read: { readonly status: 'loading' } | { readonly status: 'failed'; readonly problem: string } | { readonly status: 'ready'; readonly value: DeskRead }
  readonly pictures: ReadPictures | null
  /** Place the scan code… (production.print.start, or the designer on his orders). */
  readonly mayPlace: boolean
  /** I take it / Done — tell the worker (production.calls.answer). */
  readonly mayAnswer: boolean
  /** The ask being answered: its words, a write running, a refusal. */
  readonly answer: { readonly callId: string; readonly words: string; readonly busy: boolean; readonly failed: string | null } | null
  /** An ask being taken (its id), a refusal of the last take. */
  readonly taking: string | null
  readonly problem: string | null
  /** Place the scan code… open on this order. */
  readonly place: string | null
}

export interface DesignDeskActions {
  onRetry?: () => void
  onTake?: (callId: string) => void
  onAnswerOpen?: (callId: string) => void
  onAnswerWords?: (words: string) => void
  onAnswerSend?: () => void
  onAnswerClose?: () => void
  onPlace?: (orderId: string | null) => void
}

const ICONS: Readonly<Record<DeskSection, typeof Factory>> = { asked: ImageIcon, approvals: Hourglass, codes: ScanLine, floor: Factory }

/**
 * owb-of7 step 1 (design plan § 5f; prototype office.js designDesk) — the Design desk, the designer's first page: the counter tiles
 * (each a button to its section) and four sections in the kit — Asked (orders and requests: picture, why, since; Open) · Waits for
 * approval · Scan codes ("n of m placed"; Place the scan code… = S3's window; before S3's placements one quiet line) · From the floor
 * (I take it → Done — tell the worker, through S5's call acts). An empty list is one quiet line. No price, no Today, no Sales here.
 * Draws its model; fetches nothing.
 */
export function DesignDeskView({ model, actions }: { model: DesignDeskModel; actions?: DesignDeskActions }) {
  const t = useT(DESK_NS)
  const locale = useLocale()
  const day = (value: string) => formatDate(value, { locale })
  if (model.read.status === 'loading') return <Skeleton height={120} />
  if (model.read.status === 'failed')
    return (
      <Banner
        tone="danger"
        title={model.read.problem}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('retry')}
          </Button>
        }
      />
    )
  const read = model.read.value
  const go = (section: DeskSection) => document.getElementById(deskAnchorOf(section))?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  return (
    <div className="fw-pt fw-desk">
      <Banner tone="info" title={t('intro')} />
      <div className="fw-desk-tiles" role="group" aria-label={t('tiles')}>
        {deskTilesOf(read).map((tile) => {
          const Icon = ICONS[tile.key]
          return (
            <button key={tile.key} type="button" className="fw-desk-tile" onClick={() => go(tile.key)}>
              <Icon size={18} aria-hidden />
              <span className="fw-desk-tile-n">{tile.count ?? '—'}</span>
              <span className="fw-desk-tile-l">{t(`tile.${tile.key}`)}</span>
            </button>
          )
        })}
      </div>
      {model.problem ? <Banner tone="danger" title={model.problem} /> : null}
      {DESK_SECTIONS.map((section) => (
        <div key={section} id={deskAnchorOf(section)} className="fw-desk-anchor">
          {section === 'asked' ? (
            <Section id="desk-asked-sec" title={t('asked.title')} answer={read.asked.length > 0 ? t('asked.count', { count: read.asked.length }) : null} info={<p>{t('asked.info')}</p>}>
              {read.asked.length === 0 ? (
                <Quiet>{t('asked.none')}</Quiet>
              ) : (
                <ul className="fw-desk-rows">
                  {read.asked.map((row) => (
                    <li key={`${row.kind}:${row.id}`} className="fw-desk-row">
                      <RecordPicture source={row.kind === 'ORDER' ? 'order' : 'portalOrder'} recordId={row.id} number={row.number ?? t('asked.newOrder')} size="line" read={model.pictures} />
                      <span className="fw-desk-row-words">
                        <strong>
                          {row.number ?? t('asked.newOrder')} · {row.subject ?? t('asked.noSubject')}
                        </strong>
                        <span className="fw-so-hint">
                          {row.party.name} · {t(`why.${row.why}`)} · {t('since', { date: day(row.since) })}
                        </span>
                      </span>
                      <Link className="fw-desk-open" href={deskHrefOf(model.prefix, row)}>
                        {t('open')}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : section === 'approvals' ? (
            <Section id="desk-approvals-sec" title={t('approvals.title')} answer={read.approvals.length > 0 ? t('approvals.count', { count: read.approvals.length }) : null} info={<p>{t('approvals.info')}</p>}>
              {read.approvals.length === 0 ? (
                <Quiet>{t('approvals.none')}</Quiet>
              ) : (
                <ul className="fw-desk-rows">
                  {read.approvals.map((row) => (
                    <li key={row.approvalId} className="fw-desk-row">
                      <span className="fw-desk-row-words">
                        <strong>
                          {row.number} · {row.subject ?? t('asked.noSubject')}
                        </strong>
                        <span className="fw-so-hint">
                          {t(`kind.${row.kind}`)} · {t('sent', { date: day(row.sentAt) })}
                        </span>
                      </span>
                      <Tag tone={row.state === 'OPEN' ? 'info' : row.state.startsWith('APPROVED') ? 'success' : 'warning'}>{t(`state.${['OPEN', 'APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED'].includes(row.state) ? row.state : 'OTHER'}`)}</Tag>
                      <Link className="fw-desk-open" href={`${model.prefix}/sales/orders/${encodeURIComponent(row.orderId)}?tab=changes#confirmation`}>
                        {t('open')}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : section === 'codes' ? (
            <Section id="desk-codes-sec" title={t('codes.title')} info={<p>{t('codes.info')}</p>}>
              {read.codes === null ? (
                <Quiet>{t('codes.notYet')}</Quiet>
              ) : read.codes.length === 0 ? (
                <Quiet>{t('codes.none')}</Quiet>
              ) : (
                <ul className="fw-desk-rows">
                  {read.codes.map((row) => {
                    const placed = placedOf(row)
                    return (
                      <li key={row.orderId} className="fw-desk-row">
                        <span className="fw-desk-row-words">
                          <strong>
                            {row.number} · {row.subject ?? t('asked.noSubject')}
                          </strong>
                        </span>
                        <Tag tone={placed.done ? 'success' : 'warning'}>{t('codes.placed', { placed: placed.placed, pages: placed.pages })}</Tag>
                        {model.mayPlace ? (
                          <Button size="sm" variant="quiet" onClick={() => actions?.onPlace?.(row.orderId)}>
                            <ScanLine size={14} aria-hidden /> {t('codes.place')}
                          </Button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </Section>
          ) : (
            <Section id="desk-floor-sec" title={t('floor.title')} answer={read.floor.length > 0 ? t('floor.count', { count: read.floor.length }) : null} info={<p>{t('floor.info')}</p>}>
              {read.floor.length === 0 ? (
                <Quiet>{t('floor.none')}</Quiet>
              ) : (
                <ul className="fw-desk-rows">
                  {read.floor.map((row) => (
                    <li key={row.callId} className="fw-desk-row">
                      <span className="fw-desk-row-words">
                        <strong>{row.what}</strong>
                        <span className="fw-so-hint">
                          {row.orderNumber ? `${row.orderNumber} · ` : ''}
                          {t('since', { date: day(row.since) })}
                        </span>
                      </span>
                      <Tag tone={row.state === 'ASKED' ? 'danger' : 'info'}>{t(`floor.state.${row.state}`)}</Tag>
                      {model.mayAnswer ? (
                        <span className="fw-desk-acts">
                          {row.state === 'ASKED' ? (
                            <Button size="sm" variant="quiet" heldReason={model.taking ? t('busy') : null} onClick={() => actions?.onTake?.(row.callId)}>
                              {t('floor.take')}
                            </Button>
                          ) : null}
                          <Button size="sm" variant="secondary" onClick={() => actions?.onAnswerOpen?.(row.callId)}>
                            {t('floor.done')}
                          </Button>
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
        </div>
      ))}
      {/* Done — tell the worker: one line the worker reads ("An answer for you"), if you want. */}
      <WindowShell
        open={model.answer !== null}
        onClose={() => actions?.onAnswerClose?.()}
        title={t('floor.window')}
        act={model.answer ? { words: t('floor.send'), onAct: () => actions?.onAnswerSend?.(), busy: model.answer.busy } : null}
        closeHeld={model.answer?.busy ? t('busy') : null}
      >
        {model.answer?.failed ? <Banner tone="danger" title={model.answer.failed} /> : null}
        <Field label={t('floor.words')} hint={t('floor.wordsHint')}>
          <Textarea value={model.answer?.words ?? ''} rows={3} maxLength={500} onChange={(event) => actions?.onAnswerWords?.(event.target.value)} />
        </Field>
      </WindowShell>
      {/* S3's window (the base's stub, L10): where the scan code sits on each design page. */}
      {model.companyId ? <PlaceScanCodeWindow open={model.place !== null} onClose={() => actions?.onPlace?.(null)} companyId={model.companyId} orderId={model.place ?? ''} /> : null}
    </div>
  )
}
