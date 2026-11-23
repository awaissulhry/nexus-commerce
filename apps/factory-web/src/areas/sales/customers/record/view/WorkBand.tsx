'use client'

import { Fragment, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, Info, Layers } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { OrderPhase } from '../../../orders/api'
import { NAMESPACE as SHEET_NS, phasePhrase } from '../../../orders/list/sheet/model'
import { PHASE_ICON } from '../../../orders/list/sheet/phase-icon'
import type { BeforeLinePart } from '../before-order'
import type { StripTile } from '../use-customer-work'
import type { BandChip, BandGroup, BandPicture } from '../work-band'
import './work-band.css'

/**
 * F-CW-101 (customer Work tab plan §1; 10-design §2; picture 20; lead settles S2, S3, S16, S24, S27, S32, S38) — the Work tab's band,
 * in the waiting strip's place: ONE card.
 *
 *   line 1   the bigger picture — every order of the customer in exactly one of seven groups, each a count and a door (a press shows
 *            those orders; the same press again shows all); 0 is shown as 0; Cancelled stands apart; told apart by word, mark and
 *            place, never by colour alone
 *   notes    "All orders of <customer>: N" (the total, and the door to all) · the two whys of "Not sent to the factory" · "Before an
 *            order: …" (never added into the order numbers) · the link to the customer's work orders (moved here from the toolbar)
 *   line 2   what waits — today's six facts as chips, the same reads, doors and windows; a zero chip is quiet; while reading "—";
 *            a failed read "!" and its press reads it again; a chip without its right is left out
 *
 * Sized by its own ROOM (a container, never the window): the labels wrap inside their chips before anything is cut; on a phone the
 * seven groups fold into one button that opens them as a centred list. Draws its model and fetches nothing.
 */

export interface WorkBandModel {
  readonly customer: string
  readonly picture: BandPicture
  /** The group whose orders the sheet shows now (its door pressed); null: none. */
  readonly shown: OrderPhase | null
  readonly whys: ReadonlyArray<{ readonly why: 'yes' | 'deposit'; readonly count: number }>
  readonly before: readonly BeforeLinePart[]
  readonly chips: readonly BandChip[]
  /** The chips whose view the sheet shows now (Late, Waiting for deposit). */
  readonly pressed?: readonly StripTile[]
  /** "Work orders of <customer> ›" (workorders.view; null: not drawn). */
  readonly workOrdersHref?: string | null
  /** Replies waiting on us: their list in Sales › Incoming. */
  readonly repliesHref?: string | null
  /** Requests to answer: the page's review window on exactly those requests (null: none waits, or none could be listed). */
  readonly requestsHref?: string | null
  /** Design cases: the groups' window open. */
  readonly windowOpen?: boolean
  /** cw fx6 (re-walk R-4): the read of the groups failed (the seven read "—"): the notes line says so once, with the chips' own retry. */
  readonly failed?: boolean
}

export interface WorkBandActions {
  /** A group's door: its orders — or, pressed while shown, all orders again. */
  readonly onGroup?: (group: BandGroup) => void
  /** "All orders of <customer>". */
  readonly onAll?: () => void
  // F-CQ-303: "N drafts" is a link to Quotes & incoming at WRITING (the Work tab's Drafts view is gone): no drafts handler any more.
  /** Late and Waiting for deposit: their views of the sheet. */
  readonly onView?: (view: 'late' | 'deposit') => void
  /** Waiting for <customer> and Open tasks: their centred windows. */
  readonly onWindow?: (window: 'customer' | 'tasks') => void
  /** A chip whose read failed: read it again. */
  readonly onRetry?: (tile: StripTile) => void
}

export const WORK_BAND_NAMESPACES = ['parties', 'orders', SHEET_NS] as const

export function WorkBand(props: { model: WorkBandModel; actions?: WorkBandActions }) {
  return (
    <WithMessages namespaces={WORK_BAND_NAMESPACES}>
      <Band {...props} />
    </WithMessages>
  )
}

function Band({ model, actions }: { model: WorkBandModel; actions?: WorkBandActions }) {
  const t = useT('parties')
  const o = useT('orders')
  const s = useT(SHEET_NS)
  const locale = useLocale()
  const [open, setOpen] = useState(!!model.windowOpen)
  const { customer, picture } = model
  const number = (value: number | null): string => (value === null ? '—' : formatNumber(value, locale))
  const groupWords = (phase: OrderPhase): string => {
    const words = phasePhrase(phase)
    return words.orders ? o(words.key) : s(words.key)
  }
  const all = t('customers.work.band.all', { customer })
  const shown = model.shown ? (picture.groups.find((group) => group.phase === model.shown) ?? null) : null
  const whys = model.whys.map((entry) => t(`customers.work.band.why.${entry.why}`, { count: entry.count })).join(' · ')
  const pick = (group: BandGroup) => {
    setOpen(false)
    actions?.onGroup?.(group)
  }

  const before = model.before.map((part, index) => {
    const words = t(`customers.work.band.before.${part.part}`, { count: part.count })
    return (
      <Fragment key={part.part}>
        {index > 0 && ' · '}
        {/* F-CQ-303 (13-backend R14): every part is a real link now — the drafts' too (Quotes & incoming at WRITING): the Drafts view
            of this tab is gone, and with it the button that opened it. */}
        {part.href ? (
          <Link className="fw-cwb-link" href={part.href} onClick={() => setOpen(false)}>
            {words}
          </Link>
        ) : (
          words
        )}
      </Fragment>
    )
  })
  const beforeLine =
    model.before.length > 0 ? (
      <span>
        <b>{t('customers.work.band.before.label')}</b> {before}
      </span>
    ) : null
  const whysLine = whys ? (
    <span>
      <b>{groupWords('NOT_SENT')}:</b> {whys}
    </span>
  ) : null

  const ShownIcon = shown ? PHASE_ICON[shown.phase] : Layers
  return (
    <section className="fw-cwb" aria-label={all}>
      <div className="fw-cwb-in">
        <ol className="fw-cwb-pipe" aria-label={t('customers.work.band.pipeline')}>
          {picture.groups.map((group) => {
            const Icon = PHASE_ICON[group.phase]
            const label = groupWords(group.phase)
            const on = model.shown === group.phase
            const body = (
              <>
                <Icon size={15} aria-hidden className="fw-cwb-seg-ic" />
                <b className="fw-cwb-num">{number(group.count)}</b>
                <span className="fw-cwb-seg-lb">{label}</span>
              </>
            )
            const className = `fw-cwb-seg${group.count === 0 ? ' is-zero' : ''}`
            return (
              <li key={group.phase} className={group.phase === 'CANCELLED' ? 'fw-cwb-apart' : undefined}>
                {group.door && actions?.onGroup ? (
                  <button type="button" className={className} aria-pressed={on} title={t(on ? 'customers.work.band.groupOnTip' : 'customers.work.band.groupTip', { group: label })} onClick={() => pick(group)}>
                    {body}
                  </button>
                ) : (
                  // A count with no door (an older answer's group of two states): never a held door.
                  <span className={`${className} is-plain`}>{body}</span>
                )}
              </li>
            )
          })}
        </ol>
        {/* The phone: the seven groups fold into ONE button (the group shown, else all orders) that opens them as a centred list. */}
        <button type="button" className="fw-cwb-fold" aria-haspopup="dialog" onClick={() => setOpen(true)}>
          <ShownIcon size={16} aria-hidden />
          <span className="fw-cwb-fold-l">{shown ? groupWords(shown.phase) : all}</span>
          <b className="fw-cwb-num">{number(shown ? shown.count : picture.total)}</b>
          <ChevronDown size={14} aria-hidden />
        </button>
        <div className="fw-cwb-notes">
          {/* cw fx6 (re-walk R-4): the groups could not be read — said ONCE here in the chips' own words ("Couldn't be read · Try
              again"); the press reads the board again (the retry of the chips this same read feeds). */}
          {model.failed && (
            <span role="status">
              {actions?.onRetry ? (
                <button type="button" className="fw-cwb-link" onClick={() => actions.onRetry?.('late')}>
                  {t('customers.work.tile.failed')}
                </button>
              ) : (
                t('customers.work.tile.failed')
              )}
            </span>
          )}
          <span>
            {actions?.onAll ? (
              <button type="button" className="fw-cwb-link" onClick={() => actions.onAll?.()}>
                {t('customers.work.band.allCount', { customer })}
              </button>
            ) : (
              t('customers.work.band.allCount', { customer })
            )}{' '}
            <b className="fw-cwb-num">{number(picture.total)}</b>
          </span>
          {whysLine}
          {beforeLine && (
            <>
              <i className="fw-cwb-brk" aria-hidden="true" />
              {beforeLine}
            </>
          )}
          {model.workOrdersHref && (
            <Link className="fw-cwb-link fw-cwb-end" href={model.workOrdersHref}>
              {t('customers.band.workOrders', { customer })}
            </Link>
          )}
        </div>
        <div className="fw-cwb-wait" role="group" aria-label={t('customers.work.strip.label')}>
          <span className="fw-cwb-lab" aria-hidden="true">
            {t('customers.work.strip.label')}
          </span>
          {model.chips.map((chip, index) => (
            <Fragment key={chip.tile}>
              {chip.first && index > 0 && <i className="fw-cwb-sep" aria-hidden="true" />}
              <Chip chip={chip} label={t(`customers.work.tile.${chip.tile}`, { customer })} group={t(`customers.work.strip.${chip.group}`, { customer })} failed={t('customers.work.tile.failed')} model={model} actions={actions} />
            </Fragment>
          ))}
          <span className="fw-cwb-i">
            <Button size="sm" variant="quiet" aria-label={t('customers.work.band.info')} title={t('customers.work.band.info')} aria-haspopup="dialog" onClick={() => setOpen(true)}>
              <Info size={15} aria-hidden />
            </Button>
          </span>
        </div>
      </div>
      {open && (
        // ONE window for the ⓘ and the phone's fold: the seven groups with what each means (each a door), then the notes.
        <Modal open onClose={() => setOpen(false)} title={all} size="sm">
          <div className="fw-cwb-win">
            <ul className="fw-cwb-win-list">
              {picture.groups.map((group) => {
                const Icon = PHASE_ICON[group.phase]
                const body = (
                  <>
                    <Icon size={16} aria-hidden />
                    <span className="fw-cwb-win-w">
                      <b>{groupWords(group.phase)}</b>
                      <span className="fw-cwb-win-n">{s(`phase.note.${group.phase}`)}</span>
                    </span>
                    <b className="fw-cwb-num">{number(group.count)}</b>
                  </>
                )
                return (
                  <li key={group.phase}>
                    {group.door && actions?.onGroup ? (
                      <button type="button" className="fw-cwb-win-row" aria-pressed={model.shown === group.phase} onClick={() => pick(group)}>
                        {body}
                      </button>
                    ) : (
                      <span className="fw-cwb-win-row is-plain">{body}</span>
                    )}
                  </li>
                )
              })}
            </ul>
            <p className="fw-cwb-win-p">{t('customers.work.band.sum')}</p>
            {whysLine && <p className="fw-cwb-win-p">{whysLine}</p>}
            {beforeLine && <p className="fw-cwb-win-p">{beforeLine}</p>}
            <p className="fw-cwb-win-p">{t('customers.work.band.beforeNote')}</p>
            {/* cw fx5 (walk W-32): on the phone the notes line is folded away — the door to the customer's work orders moved here, the window's last line. */}
            {model.workOrdersHref && (
              <p className="fw-cwb-win-p">
                <Link className="fw-cwb-link" href={model.workOrdersHref}>
                  {t('customers.band.workOrders', { customer })}
                </Link>
              </p>
            )}
          </div>
        </Modal>
      )}
    </section>
  )
}

/** One fact of "What waits": its words (they wrap inside the chip), its number, its door. */
function Chip({ chip, label, group, failed, model, actions }: { chip: BandChip; label: string; group: string; failed: string; model: WorkBandModel; actions?: WorkBandActions }): ReactNode {
  const className = `fw-cwb-chip is-${chip.tone}`
  const body = (
    <>
      <span className="fw-cwb-chip-l">{label}</span>
      <b className="fw-cwb-num">{chip.value}</b>
    </>
  )
  // A failed read: only this chip says so, and its press reads it again.
  if (chip.read.status === 'failed') {
    return actions?.onRetry ? (
      <button type="button" className={`${className} is-failed`} title={failed} aria-label={`${label}: ${failed}`} onClick={() => actions.onRetry?.(chip.tile)}>
        {body}
      </button>
    ) : (
      <span className={`${className} is-failed`} title={failed}>
        {body}
      </span>
    )
  }
  if (chip.tile === 'requests' && model.requestsHref)
    return (
      <Link className={className} href={model.requestsHref} title={group} scroll={false}>
        {body}
      </Link>
    )
  if (chip.tile === 'replies' && model.repliesHref)
    return (
      <Link className={className} href={model.repliesHref} title={group}>
        {body}
        <ChevronRight size={12} aria-hidden />
      </Link>
    )
  if ((chip.tile === 'late' || chip.tile === 'deposit') && actions?.onView) {
    const view = chip.tile
    return (
      <button type="button" className={className} title={group} aria-pressed={!!model.pressed?.includes(view)} onClick={() => actions.onView?.(view)}>
        {body}
      </button>
    )
  }
  if ((chip.tile === 'customer' || chip.tile === 'tasks') && actions?.onWindow) {
    const which = chip.tile
    return (
      <button type="button" className={className} title={group} aria-haspopup="dialog" onClick={() => actions.onWindow?.(which)}>
        {body}
      </button>
    )
  }
  return (
    <span className={className} title={group}>
      {body}
    </span>
  )
}
