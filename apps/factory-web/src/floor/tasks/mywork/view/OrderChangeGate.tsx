'use client'

import { ArrowLeft, Check, OctagonX, TriangleAlert } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { TaskLine } from '../../shared/view/TaskParts'
import type { OrderChangeNote } from '../order-change-seen'
import '../mywork.css'

/**
 * F-SA-247 (R2; 14-change-flow §5.3): an order change on the floor tablet, in two parts every screen of the floor uses alike.
 *
 *   OrderChangeGate  the note that opens before a Start (or the cut) on its work order, once per tablet: the work order, the
 *                    office's words as written (the customer's code, never a name; never translated), Read aloud, "Read this
 *                    before you start." and one big "Got it" — marked on this tablet only, never sent — then the Start goes on.
 *                    Back keeps the bundle as it is (nothing started). Opened from a card it only marks the note
 *   OrderChangeLine  on a task's card or the bundle in hand: CHECK not "got" here says to read it before the start, with its door;
 *                    STOP (the work order is held) says why the scan is refused: stop and ask the team leader
 *
 * Never a person, a station, a time per person or a "seen" (Statuto dei Lavoratori art. 4).
 */

export interface OrderChangeGateProps {
  readonly open: { readonly note: OrderChangeNote; readonly asOf: string | null; readonly beforeStart: boolean } | null
  readonly timeZone?: string | undefined
  readonly onGotIt: () => void
  readonly onBack: () => void
}

export function OrderChangeGate({ open, timeZone, onGotIt, onBack }: OrderChangeGateProps) {
  const t = useT('floor-mywork')
  const shared = useT('floor-tasks')
  const ds = useDsWords()
  const locale = useLocale()
  const note = open?.note ?? null
  return (
    <Modal open={note !== null} onClose={onBack} title={note ? t('orderChange.title', { number: note.workOrder.number }) : t('orderChange.kind')} size="sm" className="fw-floor-dialog">
      {note ? (
        <div className="fw-floor-dialog-body">
          {open?.beforeStart ? (
            <TaskLine tone="warning" icon={<TriangleAlert />}>
              {t('orderChange.readFirst')}
            </TaskLine>
          ) : null}
          {/* The office's words as written: never translated, never changed; the screen's own words are the worker's language. */}
          <p className="fw-mywork-text">{note.text}</p>
          <p className="fw-floor-muted">{[t(`message.from.${note.from}`), formatDateTime(note.at, { locale, timeZone })].join(' · ')}</p>
          {open?.asOf ? <p className="fw-floor-muted">{t('messages.fromTablet', { time: formatTime(open.asOf, { locale, timeZone }) })}</p> : null}
          {note.cut ? <p className="fw-floor-muted">{t('message.cut')}</p> : null}
          <ReadAloudButton text={note.text} lang={locale === 'it' ? 'it-IT' : 'en-GB'} labels={ds.readAloud} />
          <div className="fw-mywork-cantfind">
            <FloorButton size="lg" block variant="primary" icon={<Check />} autoFocus onClick={onGotIt}>
              {t('orderChange.gotIt')}
            </FloorButton>
            <FloorButton size="lg" block variant="quiet" icon={<ArrowLeft />} onClick={onBack}>
              {shared('action.back')}
            </FloorButton>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}

export interface OrderChangeLineProps {
  readonly note: OrderChangeNote | null | undefined
  /** The note was tapped "Got it" on this tablet: a CHECK says nothing more. */
  readonly got: boolean
  /** Opens the note to read (CHECK). */
  readonly onOpen?: (() => void) | undefined
}

/** The card's line: CHECK not got here → read it before you start (its door); STOP → the reason the scan is refused. */
export function OrderChangeLine({ note, got, onOpen }: OrderChangeLineProps) {
  const t = useT('floor-mywork')
  if (!note) return null
  if (note.check === 'STOP') {
    return (
      <div className="fw-floor-stack">
        <TaskLine tone="danger" icon={<OctagonX />} alert>
          {t('orderChange.stop')}
        </TaskLine>
        <p className="fw-mywork-text">{note.text}</p>
      </div>
    )
  }
  if (got) return null
  return (
    <div className="fw-floor-stack">
      <TaskLine tone="warning" icon={<TriangleAlert />}>
        {t('orderChange.line')}
      </TaskLine>
      {onOpen ? (
        <FloorButton size="lg" variant="secondary" block icon={<TriangleAlert />} onClick={onOpen}>
          {t('orderChange.open')}
        </FloorButton>
      ) : null}
    </div>
  )
}
