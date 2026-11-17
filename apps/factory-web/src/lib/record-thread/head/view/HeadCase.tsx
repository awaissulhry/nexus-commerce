'use client'

import { useState } from 'react'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { PanelFollowers, PanelRead, RecordPanelsViewModel } from '../../../../record-panels/model'
import type { Assignable } from '../../../../record-panels/tasks/model'
import type { ApprovalsPanelModel } from '../../../../record-panels/approvals/model'
import { AskDialog } from '../../../../record-panels/approvals/view/AskDialog'
import { SHARES_NS, type SharesPanelModel } from '../../../../record-panels/share/model'
import { InviteDialog } from '../../../../record-panels/share/view/InviteDialog'
import { FollowersControl } from '../../../../record-panels/view/FollowersControl'
import { TaskNewDialog } from '../../../../record-panels/view/TaskNewDialog'
import { RemindMeDialog } from '../../../../shell/panels/remind-me/view/RemindMeDialog'
import { CloseThreadConfirm } from '../../popups/view/Confirms'
import type { DockWidth, HeadDoor, HeadModel, ThreadView } from '../model'
import { PortalHeadLine, type PortalHeadModel } from './PortalHeadLine'
// B-TH-229: "Change owner…"
import { OwnerDialog } from './OwnerDialog'
import { HEAD_NS, RecordThreadHead } from './RecordThreadHead'

/**
 * A design-review case of SCR-006-head: the Head in a stand-in thread column at ~438 px, ~718 px and the phone's 375 px.
 * Each R-ACT door opens the EXISTING dialog of record-panels exactly as the record pages use it today — New task
 * (TaskNewDialog), Ask a partner to approve (AskDialog), Share with a partner (InviteDialog), Followers (FollowersControl's
 * popover), Remind me (RemindMeDialog) — and "Close thread…" the thread's confirm (popups). The container (B-TH-300) does
 * the same with the record-panels hooks.
 */
export interface HeadCaseModel {
  readonly head: HeadModel
  /** The frames drawn: the narrow and wide dock, the phone. */
  readonly frames: readonly (438 | 718 | 375)[]
  /** The existing dialogs' models (made-up data). */
  readonly dialogs: {
    readonly people: PanelRead<readonly Assignable[]>
    readonly approvals: ApprovalsPanelModel
    readonly shares: SharesPanelModel
    readonly followers: PanelFollowers
    readonly now: number
  }
  /** A door open at once (the case shows that dialog); B-TH-229: 'owner' — Change owner…. */
  readonly open?: HeadDoor | 'close' | 'owner' | null
  /** The portal's plain line instead of the office Head. */
  readonly portal?: PortalHeadModel
}

export function HeadCase({ model }: { model: HeadCaseModel }) {
  return (
    <WithMessages namespaces={[HEAD_NS, 'records', 'record-approvals', SHARES_NS]}>
      <Case model={model} />
    </WithMessages>
  )
}

function Case({ model }: { model: HeadCaseModel }) {
  const t = useT(HEAD_NS)
  const [open, setOpen] = useState<HeadDoor | 'close' | 'owner' | null>(model.open ?? null)
  const [view, setView] = useState<ThreadView>(model.head.view)
  const [width, setWidth] = useState<DockWidth | null>(model.head.width)
  const [follow, setFollow] = useState(model.head.follow)
  // ---- B-TH-288: Done and the search, played in the case (made-up hits; nothing is asked).
  const [done, setDone] = useState(model.head.done)
  const [search, setSearch] = useState(model.head.search ?? null)
  const close = () => setOpen(null)
  const head: HeadModel = { ...model.head, view, width, follow, ...(done !== undefined ? { done } : {}), search }
  const actions = {
    onDoor: (door: HeadDoor) => {
      if (door === 'follow' && follow) return setFollow({ following: !follow.following, muted: false })
      if (door === 'mute' && follow) return setFollow({ ...follow, muted: !follow.muted })
      setOpen(door)
    },
    onView: setView,
    onWidth: (choice: DockWidth | 'hide' | 'reset') => setWidth(choice === 'hide' ? width : choice === 'reset' ? 'forty' : choice),
    onCloseThread: () => setOpen('close'),
    onOwner: () => setOpen('owner'),
    // ---- B-TH-288
    onDone: (next: boolean) => setDone(next ? { at: new Date(model.head.now).toISOString(), by: 'Alex Demo' } : null),
    onSearch: (next: boolean) => setSearch((now) => (now ? { ...now, open: next } : now)),
    search: {
      onQuery: (query: string) => setSearch((now) => (now ? { ...now, query, state: query.trim().length >= 2 ? 'ready' : query.trim() === '' ? 'idle' : 'short' } : now)),
      onPick: () => setSearch((now) => (now ? { ...now, open: false } : now)),
    },
  }
  const { dialogs } = model
  return (
    <div className="fw-rth-frames">
      {model.frames.map((frame) => (
        <div key={frame}>
          <p className="fw-rth-frame-label">{t(`design.frame${frame}`)}</p>
          <section className={`fw-rth-frame is-${frame}`} aria-label={t('design.frameLabel', { width: frame })}>
            {model.portal ? <PortalHeadLine model={model.portal} /> : <RecordThreadHead model={frame === 375 ? { ...head, compact: true, width: null } : head} actions={actions} />}
            {open === 'followers' && frame === model.frames[0] ? (
              <div className="fw-rth-open">
                <FollowersControl model={{ followers: { ...dialogs.followers, open: true } } as unknown as RecordPanelsViewModel} />
              </div>
            ) : (
              <div className="fw-rth-feed" aria-hidden />
            )}
          </section>
        </div>
      ))}
      {open === 'task' && <TaskNewDialog recordLabel={head.record} people={dialogs.people} me={null} onCreate={() => Promise.resolve(true)} onClose={close} />}
      {open === 'approve' && <AskDialog model={dialogs.approvals} actions={{ onAsk: (next) => !next && close(), onSend: close }} />}
      {open === 'share' && <InviteDialog model={dialogs.shares} actions={{ onInvite: (next) => !next && close(), onSend: close }} />}
      {open === 'remind' && <RemindMeDialog what={head.record} now={dialogs.now} onSet={() => Promise.resolve(true)} onClose={close} />}
      {open === 'owner' && (
        <OwnerDialog
          model={{ record: head.record, owner: head.owner ?? null, people: dialogs.people.status === 'ready' ? dialogs.people.data.map((person) => ({ id: person.id, name: person.name })) : [], meId: dialogs.people.status === 'ready' ? (dialogs.people.data.find((person) => person.me)?.id ?? '') : '', busy: false, problem: null }}
          onPick={close}
          onClose={close}
        />
      )}
      {open === 'close' && <CloseThreadConfirm record={head.record} party={head.party?.name ?? null} onClose={close} onCancel={close} />}
    </div>
  )
}
