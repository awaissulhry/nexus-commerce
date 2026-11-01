'use client'

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { PauseCircle, PlayCircle, Plus, Trash2, UserX, Users } from 'lucide-react'
import { Banner, Field, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { Role, User, Worker } from '../../shared/api'
import { namesLine, type BulkReach } from '../../shared/reach'
import { adminHref, EVERYWHERE, scopeReady, selectedAmong, shownOf } from '../../shared/model'
import { BulkConfirm } from '../../shared/view/BulkConfirm'
import { AdminMessages, BulkButton, FrameState, GrainChips, heldText, ListKeysHelp, ListSearch, NoticeBanner, PageHead, StepUp, useRoleWords } from '../../shared/view/parts'
import { ScopePicker } from '../../shared/view/ScopePicker'
import {
  FLOOR_LOCALES,
  FLOOR_TILES,
  floorReach,
  floorRows,
  inviteProblems,
  invitees,
  nameFromEmail,
  OFFICE_TILES,
  officeReach,
  officeRows,
  peopleFromPaste,
  tileCounts,
  workerProblems,
  type Audience,
  type FloorAction,
  type FloorTile,
  type InviteDraft,
  type OfficeAction,
  type OfficeTile,
  type UsersBulk,
  type UsersDialog,
  type UsersViewModel,
  type WorkerDraft,
} from '../model'
import { floorColumns, officeColumns } from './columns'

export type { UsersViewModel } from '../model'

export interface UsersActions {
  onAudience?: (audience: Audience) => void
  onTile?: (tile: OfficeTile | FloorTile | null) => void
  onQuery?: (query: string) => void
  /** "Show 50 more". */
  onMore?: () => void
  onRetry?: () => void
  /** Enter on a row: open its record. */
  onOpen?: (href: string) => void
  onDialog?: (dialog: UsersDialog | null) => void
  /** Resolve true when every invitation went out. */
  onInvite?: (draft: InviteDraft) => Promise<boolean>
  onAddWorker?: (draft: WorkerDraft) => Promise<boolean>
  /** A bulk action over the people it reaches, one call each; resolve true when the run finished (its notice says how). */
  onOfficeBulk?: (action: OfficeAction, users: readonly User[], reason: string) => Promise<boolean>
  onFloorBulk?: (action: FloorAction, workers: readonly Worker[], reason: string) => Promise<boolean>
  /** A bulk confirm closed (its refusal goes away). */
  onBulkClose?: () => void
  onStepUp?: (code: string) => void
  onStepUpClose?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-010 — Admin › Users (design 02 admin.users; PLT-014, PLT-015, PLT-018): everyone who signs in, by kind — office
 * people and floor workers — in the Office list frame, with the tiles that need a look (each a saved filter), the two
 * creates — Invite people (role cards in plain words, where they apply, language; a fresh code first) and Add floor
 * worker (no e-mail: name, site, floor roles; the badge and the first PIN next) — and the bulk actions over the ticked
 * rows: Suspend, Reactivate, Deactivate office people; Deactivate, Reactivate floor workers (each says its reach, one
 * confirm, one notice). Partners (W2b) and agents (W3) come later. Fetches nothing.
 */
export function UsersView({ model, actions }: { model: UsersViewModel; actions?: UsersActions }) {
  return (
    <AdminMessages>
      <UsersList model={model} actions={actions} />
    </AdminMessages>
  )
}

const OFFICE_ICONS = { suspend: <PauseCircle size={13} aria-hidden />, reactivate: <PlayCircle size={13} aria-hidden />, deactivate: <UserX size={13} aria-hidden /> } as const
const OFFICE_LABEL = { suspend: 'users.bulk.suspend', reactivate: 'users.bulk.reactivate', deactivate: 'users.bulk.deactivate' } as const
const OFFICE_VERB = { suspend: 'user.suspend.action', reactivate: 'user.reactivate.action', deactivate: 'user.deactivate.action' } as const
const OFFICE_TITLE = { suspend: 'users.bulk.confirm.suspend', reactivate: 'users.bulk.confirm.reactivate', deactivate: 'users.bulk.confirm.deactivate' } as const
const OFFICE_CONSEQUENCE = { suspend: 'user.suspend.consequence', reactivate: 'user.reactivate.consequence', deactivate: 'user.deactivate.consequence' } as const
const FLOOR_ICONS = { deactivate: <UserX size={13} aria-hidden />, reactivate: <PlayCircle size={13} aria-hidden /> } as const
const FLOOR_LABEL = { deactivate: 'users.bulk.workerDeactivate', reactivate: 'users.bulk.workerReactivate' } as const
const FLOOR_VERB = { deactivate: 'worker.deactivate.title', reactivate: 'worker.reactivate.title' } as const
const FLOOR_TITLE = { deactivate: 'users.bulk.confirm.workerDeactivate', reactivate: 'users.bulk.confirm.workerReactivate' } as const
const FLOOR_CONSEQUENCE = { deactivate: 'worker.deactivate.body', reactivate: 'worker.reactivate.body' } as const

function UsersList({ model, actions }: { model: UsersViewModel; actions?: UsersActions }) {
  const t = useT('admin')
  const locale = useLocale()
  const words = useRoleWords()
  const href = (path: string) => adminHref(model.prefix, path)
  const [dialog, setDialog] = useState<UsersDialog | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const [bulk, setBulk] = useState<UsersBulk | null>(model.bulk ?? null)
  useEffect(() => setBulk(model.bulk ?? null), [model.bulk])
  const [help, setHelp] = useState(false)
  const open = (next: UsersDialog | null) => {
    setDialog(next)
    actions?.onDialog?.(next)
  }
  const closeBulk = () => {
    setBulk(null)
    actions?.onBulkClose?.()
  }
  const counts = tileCounts(model)
  const office = model.audience === 'office'
  const tiles = office ? OFFICE_TILES : FLOOR_TILES
  const loaded = office ? model.users : model.workers
  const items = loaded.items

  // c: invite people (office) or add a worker (floor), when no field has the focus (00 §3.17).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || dialog || bulk) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (office ? !model.can.invite : !model.can.manageWorkers) return
      event.preventDefault()
      open(office ? 'invite' : 'add-worker')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const context = { t, locale, prefix: model.prefix, roleName: words.name, roles: model.roles, companies: model.companies, sites: model.sites }
  const officeCols = useMemo(() => officeColumns(context), [t, locale, model.prefix, words, model.roles, model.companies, model.sites])
  const floorCols = useMemo(() => floorColumns(context), [t, locale, model.prefix, words, model.roles, model.companies, model.sites])

  const officeAll = officeRows(model.users.items ?? [], model.tile as OfficeTile | null, model.query)
  const floorAll = floorRows(model.workers.items ?? [], model.tile as FloorTile | null, model.query, model.sites)
  const officeShown = shownOf(officeAll, model.pages)
  const floorShown = shownOf(floorAll, model.pages)
  const pickedUsers = selectedAmong(officeShown.rows, selected)
  const pickedWorkers = selectedAmong(floorShown.rows, selected)
  const officeReachOf = (action: OfficeAction) => officeReach(action, pickedUsers, { me: model.me, can: model.can, users: model.users.items ?? [], roles: model.roles })
  const floorReachOf = (action: FloorAction) => floorReach(action, pickedWorkers, model.can)
  const total = office ? officeAll.length : floorAll.length
  const shown = office ? officeShown : floorShown

  const clearFilters = () => {
    actions?.onQuery?.('')
    actions?.onTile?.(null)
  }
  const state = loaded.problem ? (
    <FrameState problem={loaded.problem} onRetry={actions?.onRetry} />
  ) : items && items.length === 0 ? (
    <FrameState
      empty={{
        icon: <Users size={24} aria-hidden />,
        title: t(office ? 'users.empty.office' : 'users.empty.floor'),
        body: t(office ? 'users.empty.officeBody' : 'users.empty.floorBody'),
        action:
          office && model.can.invite ? (
            <Button variant="primary" onClick={() => open('invite')}>
              {t('users.invite.action')}
            </Button>
          ) : !office && model.can.manageWorkers ? (
            <Button variant="primary" onClick={() => open('add-worker')}>
              {t('users.addWorker')}
            </Button>
          ) : undefined,
      }}
    />
  ) : items && total === 0 ? (
    <FrameState noMatch={{ onClear: clearFilters }} />
  ) : undefined

  const own: ListKey[] = office ? (model.can.invite ? [{ keys: ['c'], does: t('users.invite.action') }] : []) : model.can.manageWorkers ? [{ keys: ['c'], does: t('users.addWorker') }] : []
  const tools = (
    <>
      <SegmentedControl
        ariaLabel={t('users.audience.label')}
        size="sm"
        value={model.audience}
        onChange={(value) => {
          setSelected([])
          actions?.onAudience?.(value as Audience)
        }}
        options={[
          ...(model.can.viewUsers ? [{ value: 'office', label: model.users.items ? t('users.audience.officeCount', { count: model.users.items.filter((user) => user.status !== 'DEACTIVATED').length }) : t('users.audience.office') }] : []),
          ...(model.can.viewWorkers ? [{ value: 'floor', label: model.workers.items ? t('users.audience.floorCount', { count: model.workers.items.filter((worker) => worker.status === 'ACTIVE').length }) : t('users.audience.floor') }] : []),
        ]}
      />
      {model.tile && (
        <span className="fw-adm-tags">
          <Tag tone="info">{t('users.filtered', { tile: t(`users.tile.${model.tile}`) })}</Tag>
          <Button size="sm" variant="quiet" onClick={() => actions?.onTile?.(null)}>
            {t('list.clearFilter')}
          </Button>
        </span>
      )}
    </>
  )
  const frame = {
    count: items ? t('list.count', { shown: shown.rows.length, total }) : '—',
    search: <ListSearch label={t('users.search')} value={model.query} onChange={actions?.onQuery} />,
    tools,
    more: shown.more > 0 ? { label: t('list.more', { count: shown.more }), onMore: () => actions?.onMore?.() } : null,
    keys: own,
    onHelp: () => setHelp(true),
    state,
  }
  const button = (reach: BulkReach<unknown>, icon: ReactNode, label: string, verb: string, onClick: () => void, tone?: 'danger-outline') => (
    <BulkButton icon={icon} label={reach.held ? t(verb) : t(label, { count: reach.items.length })} held={heldText(t, reach.held)} tone={tone} onClick={onClick} />
  )

  // The open confirm: its reach, its words.
  const confirm = (() => {
    if (!bulk) return null
    const reach = bulk.audience === 'office' ? officeReachOf(bulk.action) : floorReachOf(bulk.action)
    const names = (reach.items as ReadonlyArray<User | Worker>).map((item) => item.displayName)
    const count = reach.items.length
    const lines = [
      t(bulk.audience === 'office' ? OFFICE_CONSEQUENCE[bulk.action] : FLOOR_CONSEQUENCE[bulk.action]),
      ...(bulk.audience === 'office' && bulk.action === 'deactivate' ? [t('user.deactivate.handover')] : []),
      namesLine(names, (more) => t('common.bulk.andMore', { count: more })),
      ...(reach.skipped > 0 ? [t('common.bulk.skipped', { count: reach.skipped })] : []),
    ]
    return {
      title: t(bulk.audience === 'office' ? OFFICE_TITLE[bulk.action] : FLOOR_TITLE[bulk.action], { count }),
      lines,
      confirmLabel: t(bulk.audience === 'office' ? OFFICE_LABEL[bulk.action] : FLOOR_LABEL[bulk.action], { count }),
      tone: bulk.action === 'reactivate' ? ('primary' as const) : ('danger' as const),
      run: (reason: string) => {
        const done = bulk.audience === 'office' ? actions?.onOfficeBulk?.(bulk.action, reach.items as User[], reason) : actions?.onFloorBulk?.(bulk.action, reach.items as Worker[], reason)
        void done?.then((finished) => {
          if (!finished) return
          setBulk(null)
          setSelected([])
        })
      },
      empty: count === 0,
    }
  })()

  return (
    <div className="fw-adm">
      <PageHead
        intro={t('users.intro')}
        asOf={model.asOf}
        actions={
          <>
            {model.can.viewWorkers && (
              <Button size="sm" onClick={() => open('add-worker')} heldReason={model.can.manageWorkers ? (model.sites.length === 0 ? t('users.held.noSite') : null) : t('held.needs', { right: t('right.workers_manage') })}>
                {t('users.addWorker')}
              </Button>
            )}
            {model.can.viewUsers && (
              <Button size="sm" variant="primary" onClick={() => open('invite')} heldReason={model.can.invite ? null : t('held.needs', { right: t('right.users_invite') })}>
                {t('users.invite.action')}
              </Button>
            )}
          </>
        }
      />
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip
        metrics={tiles.map((tile) => ({
          label: t(`users.tile.${tile}`),
          value: counts[tile] === null ? '—' : String(counts[tile]),
          hint: t(`users.tileHint.${tile}`),
          active: model.tile === tile,
          onClick: () => actions?.onTile?.(model.tile === tile ? null : tile),
        }))}
      />
      {office ? (
        <ListFrame<User>
          {...frame}
          label={t('users.tableOffice')}
          rows={items === null ? null : officeShown.rows}
          rowId={(user) => user.id}
          columns={officeCols}
          onOpen={(user) => actions?.onOpen?.(href(`/users/${user.id}`))}
          selection={{
            selected: pickedUsers.map((user) => user.id),
            onChange: setSelected,
            actions: (
              <>
                {(['suspend', 'reactivate', 'deactivate'] as const).map((action) => (
                  <Fragment key={action}>{button(officeReachOf(action), OFFICE_ICONS[action], OFFICE_LABEL[action], OFFICE_VERB[action], () => setBulk({ audience: 'office', action }), action === 'reactivate' ? undefined : 'danger-outline')}</Fragment>
                ))}
              </>
            ),
          }}
        />
      ) : (
        <ListFrame<Worker>
          {...frame}
          label={t('users.tableFloor')}
          rows={items === null ? null : floorShown.rows}
          rowId={(worker) => worker.id}
          columns={floorCols}
          onOpen={(worker) => actions?.onOpen?.(href(`/users/floor/${worker.id}`))}
          selection={{
            selected: pickedWorkers.map((worker) => worker.id),
            onChange: setSelected,
            actions: (
              <>
                {(['deactivate', 'reactivate'] as const).map((action) => (
                  <Fragment key={action}>{button(floorReachOf(action), FLOOR_ICONS[action], FLOOR_LABEL[action], FLOOR_VERB[action], () => setBulk({ audience: 'floor', action }), action === 'deactivate' ? 'danger-outline' : undefined)}</Fragment>
                ))}
              </>
            ),
          }}
        />
      )}
      <p className="fw-adm-hint">{t('users.later')}</p>
      {/* B-W2b-55 (design admin.users conn "People › Employees (W2b) for HR data"): this page keeps the sign-in identity. */}
      <p className="fw-adm-hint">
        {t('users.hrData')} <Link href={`${model.prefix}/people/employees`}>{t('users.hrDataLink')}</Link>
      </p>

      <InviteModal model={model} open={dialog === 'invite'} onClose={() => open(null)} actions={actions} />
      <AddWorkerModal model={model} open={dialog === 'add-worker'} onClose={() => open(null)} actions={actions} />
      <BulkConfirm
        open={!!confirm && !confirm.empty}
        title={confirm?.title ?? ''}
        lines={confirm?.lines ?? []}
        confirmLabel={confirm?.confirmLabel ?? ''}
        tone={confirm?.tone}
        reason
        busy={model.busy}
        problem={model.dialogProblem}
        onConfirm={(reason) => confirm?.run(reason)}
        onClose={closeBulk}
      />
      <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={own} selection />
      <StepUp model={model.stepUp} onSubmit={actions?.onStepUp} onClose={actions?.onStepUpClose} />
    </div>
  )
}

const BLANK_INVITE: InviteDraft = { people: [{ name: '', email: '' }], roleIds: [], scope: EVERYWHERE, locale: 'it' }

/** One role card: its name and what it does in a plain line, with what money it sees. */
function RoleCard({ role, checked, onChange }: { role: Role; checked: boolean; onChange: (checked: boolean) => void }) {
  const t = useT('admin')
  const words = useRoleWords()
  return (
    <CheckboxCard
      variant="row"
      checked={checked}
      selected={checked}
      onChange={(event) => onChange(event.target.checked)}
      title={
        <span className="fw-adm-cell-row">
          {words.name(role)}
          {role.requireMfa && <Tag tone="info">{t('roles.twoFactor')}</Tag>}
        </span>
      }
      description={
        <span className="fw-adm-cell">
          <span>{words.description(role) ?? t('roles.noDescription')}</span>
          <GrainChips grains={role.grains} label={t('grains.labelOf', { name: words.name(role) })} />
        </span>
      }
    />
  )
}

function InviteModal({ model, open, onClose, actions }: { model: UsersViewModel; open: boolean; onClose: () => void; actions?: UsersActions }) {
  const t = useT('admin')
  const [draft, setDraft] = useState<InviteDraft>(BLANK_INVITE)
  const [paste, setPaste] = useState('')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) {
      setDraft(BLANK_INVITE)
      setPaste('')
      setTried(false)
    }
  }, [open])
  const officeRoles = (model.roles ?? []).filter((role) => role.audience === 'office')
  const problems = inviteProblems(draft, (model.users.items ?? []).map((user) => user.email))
  const ready = Object.keys(problems).length === 0 && scopeReady(draft.scope)
  const count = invitees(draft).length
  const results = model.inviteResults ?? null
  const setPerson = (index: number, field: 'name' | 'email', value: string) =>
    setDraft((current) => ({
      ...current,
      people: current.people.map((person, at) => (at !== index ? person : field === 'email' && person.name === nameFromEmail(person.email) ? { email: value, name: nameFromEmail(value) } : { ...person, [field]: value })),
    }))
  const submit = () => {
    setTried(true)
    if (ready && !model.busy) void actions?.onInvite?.(draft)
  }
  const shown = (key: string) => (tried && problems[key] ? t(problems[key]!) : undefined)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('users.invite.title')}
      subtitle={t('users.invite.hint')}
      size="lg"
      busy={model.busy}
      footer={
        <>
          <span className="fw-adm-hint">{t('users.invite.valid')}</span>
          <Button onClick={onClose}>{t(results ? 'common.close' : 'common.cancel')}</Button>
          {!results?.every((result) => result.outcome !== 'refused') && (
            <Button variant="primary" onClick={submit} heldReason={tried && !ready ? t('form.fixFirst', { count: Object.keys(problems).length || 1 }) : model.busy ? t('common.saving') : null}>
              {t('users.invite.go', { count: Math.max(count, 1) })}
            </Button>
          )}
        </>
      }
    >
      <form
        className="fw-adm-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit()
        }}
      >
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
        {results && (
          <Banner tone={results.every((result) => result.outcome !== 'refused') ? 'success' : 'warning'} title={t('users.invite.results', { sent: results.filter((result) => result.outcome !== 'refused').length, total: results.length })}>
            <ul className="fw-adm-guards">
              {results.map((result) => (
                <li key={result.email}>
                  {result.email} — {t(`users.invite.outcome.${result.outcome}`)}
                  {result.problem ? ` (${t(result.problem)})` : ''}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        <fieldset className="fw-adm-people">
          <legend className="fw-adm-name">{t('users.invite.who')}</legend>
          {shown('people') && <Banner tone="warning" title={shown('people')} />}
          {draft.people.map((person, index) => (
            <div key={index} className="fw-adm-person-row">
              <Field label={t('users.invite.name')} error={shown(`people.${index}.name`)}>
                <Input value={person.name} onChange={(event) => setPerson(index, 'name', event.target.value)} />
              </Field>
              <Field label={t('users.invite.email')} error={shown(`people.${index}.email`)}>
                <Input type="email" autoFocus={index === 0} value={person.email} placeholder="nome.cognome@example.com" onChange={(event) => setPerson(index, 'email', event.target.value)} />
              </Field>
              {draft.people.length > 1 && (
                <Button size="sm" variant="quiet" aria-label={t('users.invite.remove', { n: index + 1 })} onClick={() => setDraft({ ...draft, people: draft.people.filter((_, at) => at !== index) })}>
                  <Trash2 size={14} aria-hidden />
                </Button>
              )}
            </div>
          ))}
          <span className="fw-adm-actions">
            <Button size="sm" onClick={() => setDraft({ ...draft, people: [...draft.people, { name: '', email: '' }] })}>
              <Plus size={14} aria-hidden /> {t('users.invite.another')}
            </Button>
          </span>
          <Field label={t('users.invite.paste')} hint={t('users.invite.pasteHint')}>
            <Textarea
              rows={2}
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              onBlur={() => {
                const pasted = peopleFromPaste(paste)
                if (pasted.length === 0) return
                setDraft((current) => ({ ...current, people: [...current.people.filter((person) => person.email.trim() !== ''), ...pasted] }))
                setPaste('')
              }}
            />
          </Field>
        </fieldset>
        <fieldset className="fw-adm-pick">
          <legend className="fw-adm-name">{t('users.invite.what')}</legend>
          {!model.can.assign ? (
            <p className="fw-adm-hint">{t('users.invite.noAssign')}</p>
          ) : officeRoles.length === 0 ? (
            <p className="fw-adm-hint">{t('users.invite.noRoles')}</p>
          ) : (
            officeRoles.map((role) => <RoleCard key={role.id} role={role} checked={draft.roleIds.includes(role.id)} onChange={(on) => setDraft({ ...draft, roleIds: on ? [...draft.roleIds, role.id] : draft.roleIds.filter((id) => id !== role.id) })} />)
          )}
        </fieldset>
        {model.can.assign && draft.roleIds.length > 0 && (
          <fieldset className="fw-adm-pick">
            <legend className="fw-adm-name">{t('users.invite.where')}</legend>
            {shown('scope') && <Banner tone="warning" title={shown('scope')} />}
            <ScopePicker name="invite-scope" value={draft.scope} companies={model.companies} onChange={(scope) => setDraft({ ...draft, scope })} />
          </fieldset>
        )}
        <Field label={t('users.invite.language')}>
          <Select value={draft.locale} onChange={(event) => setDraft({ ...draft, locale: event.target.value })}>
            {['it', 'en'].map((code) => (
              <option key={code} value={code}>
                {t(`common.language.${code}`)}
              </option>
            ))}
          </Select>
        </Field>
        <p className="fw-adm-hint">{t('users.invite.stepUp')}</p>
      </form>
    </Modal>
  )
}

function AddWorkerModal({ model, open, onClose, actions }: { model: UsersViewModel; open: boolean; onClose: () => void; actions?: UsersActions }) {
  const t = useT('admin')
  const href = (path: string) => adminHref(model.prefix, path)
  const blank: WorkerDraft = { displayName: '', locale: 'it', employeeCode: '', siteId: model.sites[0]?.id ?? '', roleIds: [] }
  const [draft, setDraft] = useState<WorkerDraft>(blank)
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) {
      setDraft({ displayName: '', locale: 'it', employeeCode: '', siteId: model.sites[0]?.id ?? '', roleIds: [] })
      setTried(false)
    }
  }, [open, model.sites])
  const floorRoles = (model.roles ?? []).filter((role) => role.audience === 'floor')
  const problems = workerProblems(draft)
  const ready = Object.keys(problems).length === 0
  const made = model.workerMade ?? null
  const submit = () => {
    setTried(true)
    if (ready && !model.busy) void actions?.onAddWorker?.(draft)
  }
  const shown = (key: string) => (tried && problems[key] ? t(problems[key]!) : undefined)

  if (made) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title={t('users.worker.made', { name: made.displayName })}
        size="sm"
        footer={
          <>
            <Button onClick={onClose}>{t('common.close')}</Button>
            <Button variant="primary" asChild>
              <Link href={`${href(`/users/floor/${made.id}`)}?tab=badge`}>{t('users.worker.next')}</Link>
            </Button>
          </>
        }
      >
        <div className="fw-adm-modal-body">
          <p className="fw-adm-intro">{t('users.worker.madeBody')}</p>
          <SummaryTable
            label={t('users.worker.nextSteps')}
            columns={[t('users.worker.step'), t('users.worker.how')]}
            rows={[
              { id: 'badge', cells: [t('users.worker.badgeStep'), t('users.worker.badgeHow')] },
              { id: 'pin', cells: [t('users.worker.pinStep'), t('users.worker.pinHow')] },
            ]}
          />
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('users.addWorker')}
      subtitle={t('users.worker.hint')}
      size="md"
      busy={model.busy}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} heldReason={tried && !ready ? t('form.fixFirst', { count: Object.keys(problems).length }) : model.busy ? t('common.saving') : null}>
            {t('users.worker.go')}
          </Button>
        </>
      }
    >
      <form
        className="fw-adm-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit()
        }}
      >
        {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem)} />}
        <Banner tone="info" title={t('users.worker.minimal')} />
        <Field label={t('users.worker.name')} required error={shown('displayName')}>
          <Input autoFocus value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
        </Field>
        <div className="fw-adm-form">
          <Field label={t('users.worker.site')} required error={shown('siteId')}>
            <Select value={draft.siteId} onChange={(event) => setDraft({ ...draft, siteId: event.target.value })}>
              {model.sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('users.worker.language')}>
            <Select value={draft.locale} onChange={(event) => setDraft({ ...draft, locale: event.target.value })}>
              {FLOOR_LOCALES.map((code) => (
                <option key={code} value={code}>
                  {t(`common.language.${code}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('users.worker.employeeNo')} hint={t('users.worker.employeeHint')} error={shown('employeeCode')}>
            <Input value={draft.employeeCode} onChange={(event) => setDraft({ ...draft, employeeCode: event.target.value })} />
          </Field>
        </div>
        <fieldset className="fw-adm-pick">
          <legend className="fw-adm-name">{t('users.worker.roles')}</legend>
          {!model.can.workerRoles ? (
            <p className="fw-adm-hint">{t('users.worker.noRolesRight')}</p>
          ) : (
            floorRoles.map((role) => <RoleCard key={role.id} role={role} checked={draft.roleIds.includes(role.id)} onChange={(on) => setDraft({ ...draft, roleIds: on ? [...draft.roleIds, role.id] : draft.roleIds.filter((id) => id !== role.id) })} />)
          )}
          {draft.roleIds.length > 0 && <p className="fw-adm-hint">{t('users.worker.rolesStepUp')}</p>}
        </fieldset>
      </form>
    </Modal>
  )
}
