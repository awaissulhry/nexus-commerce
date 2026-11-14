'use client'

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlarmClock, CheckCheck, Clock, ExternalLink, Hand, Inbox, MailQuestion, MoreHorizontal, Paperclip, ShieldAlert, UserRound } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, RadioCard, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { DateTimeField, Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { isListKey, type ListKey } from '../../../../../list-frame/model'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { snoozeOptions } from '../../../today/snooze'
import { SnoozeDialog } from '../../../today/view/SnoozeDialog'
import { inquiryHeld, inquiryHref } from '../../create-inquiry/model'
import type { WorkChange } from '../api'
import { bulkReach, moveTargets, QUEUE_VIEWS, stateWords, untilHeld, verbHeld, viewCount, type QueueMail, type QueueView, type RowVerb, type TeamInbox, type TeamInboxDialog, type TeamInboxModel } from '../model'
import '../team-inbox.css'

/** What the queue asks of its container (use-team-inbox.ts). Absent in the design index: the view still draws. */
export interface TeamInboxActions {
  onInbox?: (inboxId: string | null) => void
  onView?: (view: QueueView) => void
  onMore?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: string[]) => void
  onRetry?: () => void
  onDialog?: (dialog: TeamInboxDialog | null) => void
  /** One change to each mail named (one call each, the version read); resolves true when every one went. */
  onWork?: (ids: readonly string[], change: WorkChange) => Promise<boolean>
  onDismissNotice?: () => void
  /** Open the mail itself (the page's DetailModal, `?open=<id>`). */
  onOpenMail?: (id: string) => void
}

/**
 * Home › Mail › a team inbox (design home.mail sec:mails "Assignee (team inbox)", "Team inbox: assign to a person, close,
 * snooze, follow-up that cancels itself when the partner replies"; COL-027): the views Open · Mine · Nobody's · Snoozed ·
 * Follow-up · Closed · All (the chip under the tile), and the inbox's mail in the ONE list frame — From, Subject (opens the
 * mail), Received, Record (its thread's record, or the inquiry made of it), State, Assignee and the row's ⋯ (Take, Assign
 * to…, Give back, Close or Reopen, Snooze or Wake, Follow up or Clear it, Move to…, Create an inquiry, Open the record).
 * Select several for Take N · Assign N… · Close N. Every verb that cannot run is held with its reason. Keys (the footer's
 * icon): t take, e close the focused row. It draws ONE view model and fetches nothing.
 */
export function TeamInboxQueue({ model, actions }: { model: TeamInboxModel; actions?: TeamInboxActions }) {
  const t = useT('mail-depth')
  const ts = useT('search')
  const locale = useLocale()
  const queue = model.queue!
  const inboxList = model.inboxes.status === 'ready' ? model.inboxes.data.inboxes : []
  const mayManage = model.inboxes.status === 'ready' && model.inboxes.data.mayManage
  const inbox = inboxList.find((entry) => entry.id === queue.inboxId)
  const rows = useMemo(() => queue.rows ?? [], [queue.rows])
  // Without a container (the design index) the view keeps its own selection and dialog.
  const [ownSelected, setOwnSelected] = useState<readonly string[]>(queue.selected)
  const [ownDialog, setOwnDialog] = useState<TeamInboxDialog | null>(model.dialog)
  useEffect(() => setOwnSelected(queue.selected), [queue.selected])
  useEffect(() => setOwnDialog(model.dialog), [model.dialog])
  const selected = actions?.onSelect ? queue.selected : ownSelected
  const setSelected = (ids: string[]) => (actions?.onSelect ? actions.onSelect(ids) : setOwnSelected(ids))
  const dialog = actions?.onDialog ? model.dialog : ownDialog
  const openDialog = (next: TeamInboxDialog | null) => (actions?.onDialog ? actions.onDialog(next) : setOwnDialog(next))
  // The grid keeps its cell renderers: they reach the latest actions and rows through refs.
  const act = useRef({ actions, openDialog, rows })
  act.current = { actions, openDialog, rows }

  const typeWord = (type: string) => {
    const word = ts(`type.${type}`)
    return word === `type.${type}` ? ts('type.other') : word
  }
  const when = (iso: string) => formatDateTime(iso, { locale })
  const targetsOf = (mail: QueueMail) => moveTargets(inboxList, mail, mayManage).length
  const heldOf = (verb: RowVerb, mail: QueueMail) => {
    const key = verbHeld(verb, mail, { busy: model.busy, targets: targetsOf(mail) })
    return key ? t(key) : null
  }
  const run = (ids: readonly string[], change: WorkChange) => void act.current.actions?.onWork?.(ids, change)

  const verbItem = (mail: QueueMail, verb: RowVerb, label: string, onSelect: () => void, tone?: 'danger'): MenuItemDef => {
    const held = heldOf(verb, mail)
    return { id: verb, label, disabled: !!held, description: held ?? undefined, onSelect, ...(tone ? { tone } : {}) }
  }

  const columns = useMemo<ColDef<QueueMail>[]>(() => {
    const FromCell = ({ data }: ICellRendererParams<QueueMail>) =>
      data ? (
        <span className="fw-tin-cell">
          <span className="fw-tin-strong">{data.from.name ?? data.from.address ?? t('inbox.unknownSender')}</span>
          {data.from.name && data.from.address && <span className="fw-tin-sub fw-tin-code">{data.from.address}</span>}
        </span>
      ) : null
    const SubjectCell = ({ data }: ICellRendererParams<QueueMail>) =>
      data ? (
        <span className="fw-tin-cell">
          <Button size="sm" variant="quiet" wrap onClick={() => act.current.actions?.onOpenMail?.(data.id)}>
            {data.subject ?? t('inbox.noSubject')}
          </Button>
          <span className="fw-tin-sub">
            {data.attachmentCount > 0 && (
              <>
                <Paperclip size={11} aria-hidden /> {t('inbox.attachments', { count: data.attachmentCount })}{' '}
              </>
            )}
            {(data.verdicts.dmarc === 'FAIL' || data.verdicts.spam === 'FAIL') && (
              <>
                <ShieldAlert size={11} aria-hidden /> {t('inbox.checksFailed')}
              </>
            )}
          </span>
        </span>
      ) : null
    const RecordCell = ({ data }: ICellRendererParams<QueueMail>) => {
      if (!data) return null
      if (data.inquiry)
        return (
          <a className="fw-tin-link" href={`${model.prefix}${recordAddress({ type: 'Inquiry', id: data.inquiry.id }, OFFICE_PAGES)}`}>
            {t('inbox.inquiryMade', { number: data.inquiry.number })} <ExternalLink size={11} aria-hidden />
          </a>
        )
      if (data.thread)
        return (
          <a className="fw-tin-link" href={`${model.prefix}${recordAddress({ type: data.thread.recordType, id: data.thread.recordId }, OFFICE_PAGES)}`}>
            {typeWord(data.thread.recordType)} <ExternalLink size={11} aria-hidden />
          </a>
        )
      return <span className="fw-tin-sub">{t('inbox.noRecord')}</span>
    }
    const StateCell = ({ data }: ICellRendererParams<QueueMail>) => {
      if (!data) return null
      const state = stateWords(data)
      return (
        <span className="fw-tin-cell">
          <Tag tone={state.tone}>{state.time ? t(`${state.key}At`, { time: when(state.time) }) : t(state.key)}</Tag>
          {data.followUpUntil && (
            <span className="fw-tin-sub">
              <AlarmClock size={11} aria-hidden /> {t('inbox.followUpBy', { time: when(data.followUpUntil) })}
            </span>
          )}
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<QueueMail>) => {
      if (!data) return null
      const { openDialog: open } = act.current
      const items: MenuItemDef[] = [
        { id: 'open', label: t('verb.open'), onSelect: () => act.current.actions?.onOpenMail?.(data.id) },
        verbItem(data, 'take', t('verb.take'), () => run([data.id], { kind: 'assignee', assigneeId: model.me })),
        verbItem(data, 'assign', t('verb.assign'), () => open({ kind: 'assign', ids: [data.id] })),
        ...(data.assignee ? [verbItem(data, 'giveBack', t('verb.giveBack'), () => run([data.id], { kind: 'assignee', assigneeId: null }))] : []),
        data.closedAt === null ? verbItem(data, 'close', t('verb.close'), () => run([data.id], { kind: 'close' })) : verbItem(data, 'reopen', t('verb.reopen'), () => run([data.id], { kind: 'reopen' })),
        data.state === 'SNOOZED' ? verbItem(data, 'wake', t('verb.wake'), () => run([data.id], { kind: 'snooze', until: null })) : verbItem(data, 'snooze', t('verb.snooze'), () => open({ kind: 'snooze', id: data.id })),
        data.followUpUntil ? verbItem(data, 'clearFollowUp', t('verb.clearFollowUp'), () => run([data.id], { kind: 'followUp', until: null })) : verbItem(data, 'followUp', t('verb.followUp'), () => open({ kind: 'followUp', id: data.id })),
        verbItem(data, 'move', t('verb.move'), () => open({ kind: 'move', ids: [data.id] })),
      ]
      if (data.inquiry) items.push({ id: 'inquiry', label: t('verb.openInquiry', { number: data.inquiry.number }), href: `${model.prefix}${recordAddress({ type: 'Inquiry', id: data.inquiry.id }, OFFICE_PAGES)}` })
      else {
        const held = inquiryHeld({ status: data.status, inquiry: data.inquiry }, model.canInquiry)
        items.push(held ? { id: 'inquiry', label: t('verb.createInquiry'), disabled: true, description: t(held) } : { id: 'inquiry', label: t('verb.createInquiry'), href: inquiryHref(model.prefix, data.id) })
      }
      if (data.thread) items.push({ id: 'record', label: t('verb.openRecord'), href: `${model.prefix}${recordAddress({ type: data.thread.recordType, id: data.thread.recordId }, OFFICE_PAGES)}` })
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('verb.menu', { subject: data.subject ?? t('inbox.noSubject') }) }} items={items} />
    }
    const person = (mail: QueueMail | undefined) => (mail ? (mail.assignee ? (mail.mine ? t('inbox.assignee.you') : mail.assignee.name) : t('inbox.assignee.nobody')) : '')
    return [
      { colId: 'from', headerName: t('col.from'), flex: 1, minWidth: 180, valueGetter: (params) => params.data?.from.name ?? params.data?.from.address ?? '', cellRenderer: FromCell },
      { colId: 'subject', headerName: t('col.subject'), flex: 2, minWidth: 240, valueGetter: (params) => params.data?.subject ?? '', cellRenderer: SubjectCell },
      { colId: 'received', headerName: t('col.received'), flex: 0.8, minWidth: 150, valueGetter: (params) => (params.data ? when(params.data.receivedAt) : '') },
      { colId: 'record', headerName: t('col.record'), flex: 0.9, minWidth: 150, valueGetter: (params) => (params.data ? (params.data.inquiry?.number ?? (params.data.thread ? typeWord(params.data.thread.recordType) : t('inbox.noRecord'))) : ''), cellRenderer: RecordCell },
      { colId: 'state', headerName: t('col.state'), flex: 0.9, minWidth: 160, valueGetter: (params) => (params.data ? t(stateWords(params.data).key) : ''), cellRenderer: StateCell },
      { colId: 'assignee', headerName: t('col.assignee'), flex: 0.8, minWidth: 140, valueGetter: (params) => person(params.data) },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the words, the language and the hold through the closure: a change rebuilds them.
  }, [t, ts, locale, model.prefix, model.me, model.busy, model.canInquiry, inboxList, mayManage])

  // t takes the focused row, e closes it (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog !== null || !isListKey(event, event.target as HTMLElement | null) || (event.key !== 't' && event.key !== 'e')) return
      const id = (document.activeElement as HTMLElement | null)?.closest('[row-id]')?.getAttribute('row-id')
      const row = id ? act.current.rows.find((entry) => entry.id === id) : undefined
      if (!row) return
      const verb: RowVerb = event.key === 't' ? 'take' : 'close'
      if (verbHeld(verb, row, { busy: model.busy, targets: 0 }) !== null) return
      event.preventDefault()
      run([row.id], verb === 'take' ? { kind: 'assignee', assigneeId: model.me } : { kind: 'close' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const takeReach = bulkReach(rows, selected, 'take')
  const closeReach = bulkReach(rows, selected, 'close')
  const assignReach = bulkReach(rows, selected, 'assign')
  const busyText = model.busy ? t('inbox.held.busy') : null
  const keys: ListKey[] = [
    { keys: ['t'], does: t('keys.take') },
    { keys: ['e'], does: t('keys.close') },
  ]

  const state: ReactNode = queue.problem ? (
    <EmptyState title={t('inbox.error.title')} description={t(queue.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('inbox.retry')}</Button>} />
  ) : queue.rows && queue.rows.length === 0 ? (
    <EmptyState icon={<MailQuestion size={24} aria-hidden />} title={t(`inbox.empty.${queue.view}.title`)} description={t(`inbox.empty.${queue.view}.body`)} />
  ) : undefined

  return (
    <section className="fw-tin" aria-labelledby="fw-tin-title">
      <div className="fw-tin-head">
        <div className="fw-tin-head-text">
          <h2 id="fw-tin-title" className="fw-tin-h">
            <Inbox size={16} aria-hidden /> {inbox?.name ?? t('inbox.unknownInbox')}
          </h2>
          <p className="fw-tin-intro">
            {inbox?.address ? t('inbox.address', { address: inbox.address }) : t('inbox.noAddress')}
            {inbox && inbox.members.length > 0 && ` · ${t('inbox.members', { names: inbox.members.map((member) => member.name).join(', ') })}`}
          </p>
        </div>
        <SegmentedControl
          ariaLabel={t('inbox.viewLabel')}
          size="sm"
          wrap
          value={queue.view}
          onChange={(value) => actions?.onView?.(value as QueueView)}
          options={QUEUE_VIEWS.map((view) => {
            const count = viewCount(inbox, view)
            return { value: view, label: count === null ? t(`inbox.view.${view}`) : `${t(`inbox.view.${view}`)} · ${count}` }
          })}
        />
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('inbox.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <ListFrame<QueueMail>
        label={t('inbox.table', { name: inbox?.name ?? '' })}
        title={inbox?.name ?? t('inbox.unknownInbox')}
        rows={queue.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={queue.rows ? t(queue.more ? 'inbox.countMore' : 'inbox.count', { count: queue.rows.length }) : '—'}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" variant="primary" aria-label={t('bulk.take', { count: takeReach.length })} heldReason={busyText ?? (takeReach.length === 0 ? t('inbox.held.noneToTake') : null)} onClick={() => run(takeReach.map((row) => row.id), { kind: 'assignee', assigneeId: model.me })}>
                <Hand size={13} aria-hidden /> <SelectionLabel>{t('bulk.take', { count: takeReach.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.assign', { count: assignReach.length })} heldReason={busyText ?? (assignReach.length === 0 ? t('inbox.held.noneSelected') : null)} onClick={() => openDialog({ kind: 'assign', ids: assignReach.map((row) => row.id) })}>
                <UserRound size={13} aria-hidden /> <SelectionLabel>{t('bulk.assign', { count: assignReach.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.close', { count: closeReach.length })} heldReason={busyText ?? (closeReach.length === 0 ? t('inbox.held.noneToClose') : null)} onClick={() => run(closeReach.map((row) => row.id), { kind: 'close' })}>
                <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.close', { count: closeReach.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={queue.updates > 0 ? { count: queue.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={queue.more ? { label: t(queue.loadingMore ? 'inbox.moreLoading' : 'inbox.more'), onMore: () => actions?.onMore?.(), held: queue.loadingMore ? t('inbox.moreLoading') : null } : null}
        keys={keys}
        onOpen={(row) => actions?.onOpenMail?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />

      {dialog?.kind === 'assign' && inbox && <AssignDialog inbox={inbox} me={model.me} rows={rows.filter((row) => dialog.ids.includes(row.id))} busy={model.busy} onWork={actions?.onWork} onClose={() => openDialog(null)} />}
      {dialog?.kind === 'move' && (
        <MoveDialog targets={moveTargets(inboxList, rows.find((row) => row.id === dialog.ids[0]) ?? { teamInboxId: queue.inboxId }, mayManage)} ids={dialog.ids} busy={model.busy} onWork={actions?.onWork} onClose={() => openDialog(null)} />
      )}
      {dialog?.kind === 'snooze' && (
        <SnoozeDialog
          what={rows.find((row) => row.id === dialog.id)?.subject ?? t('inbox.noSubject')}
          now={model.now}
          untilChange={false}
          maxDays={90}
          held={busyText}
          onSnooze={(until) => actions?.onWork?.([dialog.id], { kind: 'snooze', until })}
          onClose={() => openDialog(null)}
        />
      )}
      {dialog?.kind === 'followUp' && <FollowUpDialog id={dialog.id} what={rows.find((row) => row.id === dialog.id)?.subject ?? t('inbox.noSubject')} now={model.now} busy={model.busy} onWork={actions?.onWork} onClose={() => openDialog(null)} />}
    </section>
  )
}

interface WorkDialogProps {
  busy: boolean
  onWork?: (ids: readonly string[], change: WorkChange) => Promise<boolean>
  onClose: () => void
}

const NOBODY = '__nobody__'

/** Assign to… (one mail or the selection): a member of the inbox, or nobody (back to the queue). */
function AssignDialog({ inbox, me, rows, busy, onWork, onClose }: WorkDialogProps & { inbox: TeamInbox; me: string; rows: readonly QueueMail[] }) {
  const t = useT('mail-depth')
  const [chosen, setChosen] = useState<string | null>(null)
  const held = busy ? t('inbox.held.busy') : chosen === null ? t('assign.held') : null
  const go = () => {
    if (held || chosen === null) return
    void onWork?.(
      rows.map((row) => row.id),
      { kind: 'assignee', assigneeId: chosen === NOBODY ? null : chosen },
    ).then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('assign.title', { count: rows.length })}
      footer={
        <>
          <Button onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={go}>
            {t('assign.go')}
          </Button>
        </>
      }
    >
      <fieldset className="fw-tin-choices">
        <legend className="fw-tin-sub">{t('assign.body', { name: inbox.name })}</legend>
        {inbox.members.map((member) => (
          <RadioCard key={member.id} variant="row" name="fw-tin-assign" value={member.id} checked={chosen === member.id} selected={chosen === member.id} onChange={() => setChosen(member.id)} title={member.id === me ? t('assign.me', { name: member.name }) : member.name} />
        ))}
        <RadioCard variant="row" name="fw-tin-assign" value={NOBODY} checked={chosen === NOBODY} selected={chosen === NOBODY} onChange={() => setChosen(NOBODY)} title={t('assign.nobody')} description={t('assign.nobodyHint')} />
        {inbox.members.length === 0 && <p className="fw-tin-sub">{t('assign.noMembers')}</p>}
      </fieldset>
    </Modal>
  )
}

/** Move to… : another switched-on inbox of the company the person works; its assignee stays only if a member there. */
function MoveDialog({ targets, ids, busy, onWork, onClose }: WorkDialogProps & { targets: readonly TeamInbox[]; ids: readonly string[] }) {
  const t = useT('mail-depth')
  const [chosen, setChosen] = useState<string | null>(null)
  const held = busy ? t('inbox.held.busy') : targets.length === 0 ? t('inbox.held.noOtherInbox') : chosen === null ? t('move.held') : null
  const go = () => {
    if (held || chosen === null) return
    void onWork?.(ids, { kind: 'move', teamInboxId: chosen }).then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('move.title')}
      footer={
        <>
          <Button onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={go}>
            {t('move.go')}
          </Button>
        </>
      }
    >
      <fieldset className="fw-tin-choices">
        <legend className="fw-tin-sub">{t('move.body')}</legend>
        {targets.map((target) => (
          <RadioCard key={target.id} variant="row" name="fw-tin-move" value={target.id} checked={chosen === target.id} selected={chosen === target.id} onChange={() => setChosen(target.id)} title={target.name} description={target.address ?? undefined} />
        ))}
      </fieldset>
    </Modal>
  )
}

/**
 * Follow up (design "follow-up that cancels itself when the partner replies"): the mail comes back to the queue at the chosen
 * time unless the partner answers in the record's thread first — the same choices as Snooze (later today, tomorrow, Monday,
 * pick a time), 5 minutes to 90 days ahead.
 */
function FollowUpDialog({ id, what, now, busy, onWork, onClose }: WorkDialogProps & { id: string; what: string; now: number }) {
  const t = useT('mail-depth')
  const locale = useLocale()
  const fieldId = useId()
  const options = useMemo(() => snoozeOptions(now, { untilChange: false }).filter((option) => option.until !== null), [now])
  const [picked, setPicked] = useState<string>(options[0]?.until ?? '')
  const [typed, setTyped] = useState(false)
  const until = typed ? (picked ? new Date(picked).toISOString() : '') : picked
  const held = busy ? t('inbox.held.busy') : (() => {
    const problem = untilHeld(until, now)
    return problem ? t(problem) : null
  })()
  const go = () => {
    if (held) return
    void onWork?.([id], { kind: 'followUp', until }).then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('followUp.title', { what })}
      footer={
        <>
          <Button onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={go}>
            <AlarmClock size={14} aria-hidden /> {t('followUp.go')}
          </Button>
        </>
      }
    >
      <div className="fw-tin-choices">
        <p className="fw-tin-sub">{t('followUp.body')}</p>
        {options.map((option) => (
          <RadioCard
            key={option.choice}
            variant="row"
            name="fw-tin-follow"
            value={option.choice}
            checked={!typed && picked === option.until}
            selected={!typed && picked === option.until}
            onChange={() => {
              setTyped(false)
              setPicked(option.until ?? '')
            }}
            title={t(`followUp.choice.${option.choice}`)}
            description={option.until ? formatDateTime(option.until, { locale }) : undefined}
          />
        ))}
        <RadioCard
          variant="row"
          name="fw-tin-follow"
          value="PICK"
          checked={typed}
          selected={typed}
          onChange={() => {
            setTyped(true)
            setPicked('')
          }}
          title={t('followUp.choice.PICK')}
        />
        {typed && (
          <Field label={t('followUp.pickLabel')} hint={t('followUp.pickHint')} htmlFor={fieldId}>
            <DateTimeField id={fieldId} value={picked} onChange={setPicked} min={new Date(now).toISOString()} max={new Date(now + 90 * 86_400_000).toISOString()} defaultTime="08:00" locale={INTL_LOCALE[locale]} ariaLabel={t('followUp.pickLabel')} />
          </Field>
        )}
        <p className="fw-tin-sub">
          <Clock size={12} aria-hidden /> {t('followUp.cancels')}
        </p>
      </div>
    </Modal>
  )
}
