'use client'

import { useEffect, useRef, useState, type Ref } from 'react'
import { ArrowUpRight, BellRing, Check, Clock, Factory, FileQuestion, Globe, Inbox, MoreHorizontal, RotateCcw, Upload, User, Users } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { dayWords } from '../../day' // fx5w (W-11): the app's day words
import { useLocale, useT } from '../../../../i18n/provider'
import type { FileAsk, FileAskWho, OrderFilesRead } from '../../model'
import { askDoorsOf, asksBandOf, shownRows, type AskDoor, type AskRow, type AsksState } from '../asks'
import './asks.css'

export const ASKS_NS = 'file-asks'

/** The band's doors the container answers (use-file-asks); a door to another page is a real link. */
export interface AsksActions {
  readonly onAskNew?: () => void
  readonly onAskDoor?: (askId: string, door: AskDoor) => void
  readonly onAskDismiss?: () => void
  /** "Open on <work order> ›": the record's own page (null: no door). */
  readonly orderHrefOf?: (record: { readonly type: string; readonly id: string; readonly label: string }) => string | null
}

const WHO_ICON: Readonly<Record<FileAskWho | 'CUSTOMER', typeof User>> = { PERSON: User, OFFICE_ROLE: Users, FLOOR_TEAM: Factory, FLOOR_ROLE: Factory, STEP: Factory, CUSTOMER: Globe }
const DOOR_ICON: Readonly<Partial<Record<AskDoor, typeof User>>> = { accept: Check, again: RotateCcw, upload: Upload, chase: BellRing, check: Inbox }
const DOOR_WORD: Readonly<Record<AskDoor, string>> = { accept: 'act.accept', again: 'act.again', upload: 'act.upload', chase: 'act.chase', check: 'act.check', change: 'act.change', reassign: 'act.reassign', cancel: 'act.cancel', uploadFor: 'act.uploadFor', copyLink: 'act.copyLink' }

/**
 * F-OF-201 (order FILES tab W2; 10-design §4) — "Waiting for files", the rows (the tab's section and the order's thread window draw the
 * same): one row per open ask — what · where it lands · who asked; who uploads it (an office person, a role, a team, a step: never a floor
 * worker) and "For you"; due and "2 days late" (words and tone, never colour alone); its state ("Arrived — check it", "Asked again: …",
 * "Asked for an update …"); ≤ 3 buttons with the ⋯. The customer's portal asks are rows "Asked in the portal" with no ask command. What
 * the reader may not read is counted on one line, never named. Five rows, then "Show N more". The row the address names
 * (`?tab=files&ask=<id>`) is marked and brought into view. Draws the read and the band's state; fetches nothing.
 */
export function AsksBody({ read, state, actions, customer }: { read: OrderFilesRead; state: AsksState; actions?: AsksActions | undefined; customer: string | null }) {
  const t = useT(ASKS_NS)
  const [open, setOpen] = useState(false)
  const band = asksBandOf(read)
  const focusRef = useRef<HTMLDivElement>(null)
  const focus = state.focus ?? null
  const focusAt = band ? band.rows.findIndex((row) => row.ask.id === focus) : -1
  const wide = open || focusAt >= 5
  // The address's ask: marked, in view, the focus on it (once per ask named).
  useEffect(() => {
    if (!focus || focusAt < 0) return
    const row = focusRef.current
    row?.scrollIntoView({ block: 'center' })
    row?.focus({ preventScroll: true })
  }, [focus, focusAt])
  if (!band) return null
  const { shown, more } = shownRows(band.rows, wide)
  const counted = band.counted
  // fx5w (W-03): nothing to draw below the section's one line (no row, nothing counted, no notice): no body at all.
  if (band.rows.length === 0 && counted.priced === 0 && counted.outside === 0 && !state.notice) return null
  return (
    <div className="fw-ask-list">
      {state.notice && (
        <p className="fw-ask-notice" role="alert">
          <span>{t(state.notice.key, state.notice.params)}</span>
          <Button size="sm" variant="quiet" onClick={() => actions?.onAskDismiss?.()}>
            {t('win.close')}
          </Button>
        </p>
      )}
      {(counted.priced > 0 || counted.outside > 0) && (
        <p className="fw-ask-counted" role="note">
          {[counted.priced > 0 ? t('band.counted.priced', { count: counted.priced }) : null, counted.outside > 0 ? t('band.counted.outside', { count: counted.outside }) : null].filter(Boolean).join(' · ')} — {t('band.counted.why')}
        </p>
      )}
      {/* fx5w (W-03): "Nothing is asked" is said ONCE — the section's one line under its title (useAsksAnswer); no body line. */}
      {band.rows.length === 0 ? null : (
        <div className="fw-ask-rows" role="list">
          {shown.map((row) => (
            <AskRowView key={`${row.kind}:${row.ask.id}`} row={row} state={state} actions={actions} customer={customer} marked={row.ask.id === focus} rowRef={row.ask.id === focus ? focusRef : undefined} />
          ))}
        </div>
      )}
      {(more > 0 || (open && band.rows.length > 5)) && (
        <Button size="sm" variant="link" className="fw-ask-more" aria-expanded={open} onClick={() => setOpen((now) => !now)}>
          {open ? t('band.less') : t('band.more', { count: more })}
        </Button>
      )}
    </div>
  )
}

function AskRowView({ row, state, actions, customer, marked, rowRef }: { row: AskRow; state: AsksState; actions?: AsksActions | undefined; customer: string | null; marked: boolean; rowRef?: Ref<HTMLDivElement> | undefined }) {
  const t = useT(ASKS_NS)
  const locale = useLocale()
  const date = (day: string) => dayWords(day, locale) // fx5w (W-11): "28 Nov"
  if (row.kind === 'customer') {
    const ask = row.ask
    const Icon = WHO_ICON.CUSTOMER
    const what = ask.words ? (locale === 'it' ? ask.words.it : ask.words.en) : t('row.customerDoc')
    return (
      <div className={`fw-ask-row${marked ? ' is-marked' : ''}`} id={`ask-${ask.id}`} role="listitem" tabIndex={-1} ref={rowRef}>
        <div className="fw-ask-w">
          <b>{what}</b>
        </div>
        <div className="fw-ask-who">
          <b>
            <Icon size={13} aria-hidden /> {customer ?? ''}
          </b>
          <span className="fw-ask-mu">{t('row.who.CUSTOMER')}</span>
        </div>
        <div className="fw-ask-due">
          {ask.dueOn && <span>{t('row.due', { date: date(ask.dueOn) })}</span>}
          {ask.lateDays > 0 && (
            <Tag tone="warning">
              <Clock size={11} aria-hidden /> {t('row.late', { count: ask.lateDays })}
            </Tag>
          )}
        </div>
        <div className="fw-ask-st">
          <Tag tone="neutral">
            <Globe size={11} aria-hidden /> {t('state.portal')}
          </Tag>
          {customer && <span className="fw-ask-mu">{t('state.portalCloses', { customer })}</span>}
        </div>
        <div className="fw-ask-act">
          <AskMenu what={what} items={[{ id: 'copy', label: t('act.copyLink'), onSelect: () => actions?.onAskDoor?.(ask.id, 'copyLink') }]} />
        </div>
      </div>
    )
  }
  const ask = row.ask
  const doors = askDoorsOf(ask, state.can)
  const Icon = WHO_ICON[ask.who.kind]
  const what = ask.words ?? t('row.priced')
  const lands = ask.lands.step ? t('row.landsStep', { target: ask.lands.label, seq: ask.lands.step.seq, name: ask.lands.step.name }) : t('row.lands', { target: ask.lands.label })
  const href = ask.lands.type === 'WorkOrder' ? (actions?.orderHrefOf?.({ type: ask.lands.type, id: ask.lands.id, label: ask.lands.label }) ?? null) : null
  const items: MenuItemDef[] = [
    ...doors.menu.map((door) => ({ id: door.door, label: door.door === 'uploadFor' ? t('act.uploadFor', { who: ask.who.label }) : t(DOOR_WORD[door.door]), onSelect: () => actions?.onAskDoor?.(ask.id, door.door), ...(door.held ? { disabled: true, description: t(door.held) } : {}) })),
    ...(href ? [{ id: 'open-on', label: t('act.openOn', { target: ask.lands.label }), href }] : []),
  ]
  return (
    <div className={`fw-ask-row${ask.forMe && ask.status === 'OPEN' ? ' is-mine' : ''}${marked ? ' is-marked' : ''}`} id={`ask-${ask.id}`} role="listitem" tabIndex={-1} ref={rowRef}>
      <div className="fw-ask-w">
        <b>{what}</b>
        <span className="fw-ask-lands">
          <ArrowUpRight size={12} aria-hidden /> {lands}
        </span>
        <span className="fw-ask-mu">{t('row.askedBy', { name: ask.askedBy.name, date: date(ask.askedAt) })}</span>
      </div>
      <div className="fw-ask-who">
        <b>
          <Icon size={13} aria-hidden /> {ask.who.label}
        </b>
        <span className="fw-ask-mu">{t(`row.who.${ask.who.kind}`)}</span>
        {ask.forMe && ask.status === 'OPEN' && <Tag tone="info">{t('row.forYou')}</Tag>}
      </div>
      <div className="fw-ask-due">
        <span>{t('row.due', { date: date(ask.dueOn) })}</span>
        {ask.lateDays > 0 && ask.status === 'OPEN' && (
          <Tag tone="warning">
            <Clock size={11} aria-hidden /> {t('row.late', { count: ask.lateDays })}
          </Tag>
        )}
      </div>
      <div className="fw-ask-st">
        {ask.status === 'ARRIVED' ? (
          <>
            <Tag tone="success">
              <Inbox size={11} aria-hidden /> {t('state.ARRIVED')}
            </Tag>
            {ask.answered && (
              <span className="fw-ask-mu">
                {ask.answered.by.kind === 'OFFICE' ? t('state.sent', { count: ask.answered.fileIds.length, date: date(ask.answered.at), name: ask.answered.by.name }) : t('state.sentFloor', { count: ask.answered.fileIds.length, date: date(ask.answered.at) })}
                {ask.answered.held > 0 && ` · ${t('state.checking')}`}
              </span>
            )}
          </>
        ) : (
          <>
            <Tag tone={ask.lateDays > 0 ? 'warning' : 'neutral'}>{t(ask.rounds > 0 ? 'state.again' : 'state.OPEN')}</Tag>
            {ask.rounds > 0 && ask.lastReason && <span className="fw-ask-mu">{t('state.againWhy', { reason: ask.lastReason })}</span>}
            {ask.chasedAt && <span className="fw-ask-mu">{t('state.chased', { date: date(ask.chasedAt) })}</span>}
          </>
        )}
      </div>
      <div className="fw-ask-act">
        {doors.buttons.map((door, index) => {
          const DoorIcon = DOOR_ICON[door.door] ?? FileQuestion
          return (
            <Button key={door.door} size="sm" variant={index === 0 && (door.door === 'accept' || door.door === 'upload') ? 'primary' : 'secondary'} heldReason={door.held ? t(door.held) : null} onClick={() => actions?.onAskDoor?.(ask.id, door.door)}>
              <DoorIcon size={14} aria-hidden /> {t(DOOR_WORD[door.door])}
            </Button>
          )
        })}
        {doors.buttons.some((door) => door.held) && <span className="fw-ask-held">{t('held.checking')}</span>}
        <AskMenu what={what} items={items} />
      </div>
    </div>
  )
}

/** The row's ⋯ (the DS Menu; its name says the ask), a square icon button like every ⋯ of the page. */
function AskMenu({ what, items }: { what: string; items: MenuItemDef[] }) {
  const t = useT(ASKS_NS)
  return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('act.menu', { what }), className: 'nds-btn icon' }} items={items} />
}

/**
 * The band's answer — "3 asked · 1 arrived to check · 1 is late" — for a section's head (the tab) or the window's. fx5w (W-03): nothing
 * asked is said here once — with the way to ask for a reader who may ("Nothing is asked. Ask anyone for a file: …"), else "Nothing is
 * asked." — and the body draws no second line.
 */
export function useAsksAnswer(read: OrderFilesRead | null, state?: AsksState): string | null {
  const t = useT(ASKS_NS)
  const band = read ? asksBandOf(read) : null
  if (!band) return null
  if (band.answer.length > 0) return band.answer.map((part) => t(part.key, part.params)).join(' · ')
  return t(state && state.can.ask && !state.can.closed && !state.can.readOnly ? 'band.empty' : 'band.emptyRead')
}

/** "Ask for a file…" — hidden without the right (and for Read-only); held with words on a closed order (L1). */
export function AskButton({ state, onAsk }: { state: AsksState; onAsk?: (() => void) | undefined }) {
  const t = useT(ASKS_NS)
  if (!state.can.ask || state.can.readOnly) return null
  return (
    <Button size="sm" variant="primary" heldReason={state.can.closed ? t('band.closed') : null} onClick={() => onAsk?.()}>
      <FileQuestion size={14} aria-hidden /> {t('band.ask')}
    </Button>
  )
}

/** The window's own head over the rows (the tab draws the kit's section head instead). */
export function AsksWindowHead({ read, state, onAsk }: { read: OrderFilesRead; state: AsksState; onAsk?: (() => void) | undefined }) {
  const t = useT(ASKS_NS)
  const answer = useAsksAnswer(read, state)
  return (
    <div className="fw-ask-whead">
      <div className="fw-ask-whead-t">
        <h3>
          <FileQuestion size={14} aria-hidden /> {t('band.title')}
        </h3>
        {answer && <span className="fw-ask-mu">{answer}</span>}
      </div>
      <AskButton state={state} onAsk={onAsk} />
    </div>
  )
}

/** F-OF-201: the files that came for an ask still to check, by id (a card's "For an ask — check it" chip and ring). */
export const arrivedFileIds = (asks: readonly FileAsk[] | undefined): ReadonlySet<string> => new Set((asks ?? []).filter((ask) => ask.status === 'ARRIVED').flatMap((ask) => ask.answered?.fileIds ?? []))
