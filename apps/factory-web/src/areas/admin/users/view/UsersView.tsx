'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, Search, Trash2, Users } from 'lucide-react'
import { Banner, Field, MetricStrip, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, Pill, SegmentedControl, Select, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Role, Worker } from '../../shared/api'
import { adminHref, EVERYWHERE, pageOf, scopeReady, STATUS_TONE } from '../../shared/model'
import { AdminMessages, dash, GrainChips, ListState, ListTable, NoticeBanner, PageHead, StepUp, useRoleWords } from '../../shared/view/parts'
import { ScopePicker } from '../../shared/view/ScopePicker'
import {
  FLOOR_LOCALES,
  FLOOR_TILES,
  floorRows,
  inviteProblems,
  invitees,
  nameFromEmail,
  OFFICE_TILES,
  officeRows,
  peopleFromPaste,
  tileCounts,
  userGrains,
  whereWords,
  workerProblems,
  type Audience,
  type FloorTile,
  type InviteDraft,
  type OfficeTile,
  type UsersDialog,
  type UsersViewModel,
  type WorkerDraft,
} from '../model'

export type { UsersViewModel } from '../model'

export interface UsersActions {
  onAudience?: (audience: Audience) => void
  onTile?: (tile: OfficeTile | FloorTile | null) => void
  onQuery?: (query: string) => void
  onPage?: (page: number) => void
  onRetry?: () => void
  onDialog?: (dialog: UsersDialog | null) => void
  /** Resolve true when every invitation went out. */
  onInvite?: (draft: InviteDraft) => Promise<boolean>
  onAddWorker?: (draft: WorkerDraft) => Promise<boolean>
  onStepUp?: (code: string) => void
  onStepUpClose?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-010 — Admin › Users (design 02 admin.users; PLT-014, PLT-015, PLT-018): everyone who signs in, by kind — office
 * people and floor workers — with the tiles that need a look (each a saved filter), and the two creates: Invite people
 * (role cards in plain words, where they apply, language; a fresh code first) and Add floor worker (no e-mail: name,
 * site, floor roles; the badge and the first PIN next). Partners (W2b) and agents (W3) come later. Fetches nothing.
 */
export function UsersView({ model, actions }: { model: UsersViewModel; actions?: UsersActions }) {
  return (
    <AdminMessages>
      <UsersList model={model} actions={actions} />
    </AdminMessages>
  )
}

function UsersList({ model, actions }: { model: UsersViewModel; actions?: UsersActions }) {
  const t = useT('admin')
  const locale = useLocale()
  const href = (path: string) => adminHref(model.prefix, path)
  const [dialog, setDialog] = useState<UsersDialog | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const open = (next: UsersDialog | null) => {
    setDialog(next)
    actions?.onDialog?.(next)
  }
  const counts = tileCounts(model)
  const office = model.audience === 'office'
  const tiles = office ? OFFICE_TILES : FLOOR_TILES
  const loaded = office ? model.users : model.workers
  const items = loaded.items
  const words = useRoleWords()

  // c: invite people (office) or add a worker (floor), when no field has the focus (00 §3.17).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (office ? !model.can.invite : !model.can.manageWorkers) return
      event.preventDefault()
      open(office ? 'invite' : 'add-worker')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const officeTable = () => {
    const rows = officeRows(model.users.items ?? [], model.tile as OfficeTile | null, model.query)
    const paged = pageOf(rows, model.page)
    return {
      total: rows.length,
      paged,
      columns: [t('users.col.name'), t('users.col.roles'), t('users.col.where'), t('users.col.money'), t('users.col.status'), t('users.col.twoFactor'), t('users.col.lastSignIn')],
      rows: paged.rows.map((user) => {
        const grains = userGrains(user, model.roles)
        return {
          id: user.id,
          cells: [
            <span key="name" className="fw-adm-cell">
              <Link className="fw-adm-name" href={href(`/users/${user.id}`)}>
                {user.displayName}
              </Link>
              <span className="fw-adm-hint">{user.email}</span>
            </span>,
            user.roles.length === 0 ? <span key="roles" className="fw-adm-hint">{t('users.noRole')}</span> : <span key="roles" className="fw-adm-tags">{user.roles.map((role) => <Tag key={role.assignmentId}>{words.name({ key: role.roleKey, name: role.roleName })}</Tag>)}</span>,
            dash(whereWords(user.roles, model.companies, t('scope.all'))),
            grains ? <GrainChips key="money" grains={grains} label={t('grains.labelOf', { name: user.displayName })} /> : '—',
            <Pill key="status" tone={STATUS_TONE[user.status] ?? 'neutral'}>{t(`users.status.${user.status}`)}</Pill>,
            user.status === 'INVITED' || user.status === 'DEACTIVATED' ? '—' : t(user.mfaEnabled ? 'users.mfa.on' : 'users.mfa.off'),
            user.lastSignInAt ? formatDateTime(user.lastSignInAt, { locale }) : user.status === 'INVITED' && user.invitationExpiresAt ? t('users.invitedUntil', { date: formatDateTime(user.invitationExpiresAt, { locale }) }) : '—',
          ],
        }
      }),
      widths: ['22%', '18%', '16%', '18%', '9%', '7%', '10%'],
    }
  }
  const floorTable = () => {
    const rows = floorRows(model.workers.items ?? [], model.tile as FloorTile | null, model.query, model.sites)
    const paged = pageOf(rows, model.page)
    const siteName = (worker: Worker) => model.sites.find((site) => site.id === worker.siteId)?.name ?? null
    return {
      total: rows.length,
      paged,
      columns: [t('users.col.name'), t('users.col.site'), t('users.col.floorRoles'), t('users.col.badge'), t('users.col.pin'), t('users.col.status'), t('users.col.language')],
      rows: paged.rows.map((worker) => ({
        id: worker.id,
        cells: [
          <span key="name" className="fw-adm-cell">
            <Link className="fw-adm-name" href={href(`/users/floor/${worker.id}`)}>
              {worker.displayName}
            </Link>
            {worker.employeeCode && <span className="fw-adm-hint">{t('users.employeeNo', { code: worker.employeeCode })}</span>}
          </span>,
          dash(siteName(worker)),
          worker.roles.length === 0 ? <span key="roles" className="fw-adm-hint">{t('users.noFloorRole')}</span> : <span key="roles" className="fw-adm-tags">{worker.roles.map((role) => <Tag key={role.workerRoleId}>{words.name(role)}</Tag>)}</span>,
          worker.badge ? t('users.badgeHint', { hint: worker.badge.hint }) : <span key="badge" className="fw-adm-hint">{t('users.noBadge')}</span>,
          t(worker.pinMustChange ? 'users.pin.mustChange' : worker.hasPin ? 'users.pin.set' : 'users.pin.none'),
          <span key="status" className="fw-adm-tags">
            <Pill tone={STATUS_TONE[worker.status] ?? 'neutral'}>{t(`users.workerStatus.${worker.status}`)}</Pill>
            {worker.locked && <Tag tone="warning">{t('users.locked')}</Tag>}
          </span>,
          t(`common.language.${worker.locale}`) === `common.language.${worker.locale}` ? worker.locale : t(`common.language.${worker.locale}`),
        ],
      })),
      widths: ['24%', '18%', '18%', '12%', '12%', '10%', '6%'],
    }
  }
  const table = office ? officeTable() : floorTable()

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
      <div className="fw-adm-toolbar">
        <SegmentedControl
          ariaLabel={t('users.audience.label')}
          size="sm"
          value={model.audience}
          onChange={(value) => actions?.onAudience?.(value as Audience)}
          options={[
            ...(model.can.viewUsers ? [{ value: 'office', label: model.users.items ? t('users.audience.officeCount', { count: model.users.items.filter((user) => user.status !== 'DEACTIVATED').length }) : t('users.audience.office') }] : []),
            ...(model.can.viewWorkers ? [{ value: 'floor', label: model.workers.items ? t('users.audience.floorCount', { count: model.workers.items.filter((worker) => worker.status === 'ACTIVE').length }) : t('users.audience.floor') }] : []),
          ]}
        />
        <span className="fw-adm-toolbar-search">
          <Input size="sm" fieldClassName="fw-adm-fill" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={t('users.search')} placeholder={t('users.search')} value={model.query} onChange={(event) => actions?.onQuery?.(event.target.value)} />
        </span>
      </div>
      <MetricStrip
        metrics={tiles.map((tile) => ({
          label: t(`users.tile.${tile}`),
          value: counts[tile] === null ? '—' : String(counts[tile]),
          hint: t(`users.tileHint.${tile}`),
          active: model.tile === tile,
          onClick: () => actions?.onTile?.(model.tile === tile ? null : tile),
        }))}
      />
      {model.tile && (
        <span className="fw-adm-tags">
          <Tag tone="info">{t('users.filtered', { tile: t(`users.tile.${model.tile}`) })}</Tag>
          <Button size="sm" variant="quiet" onClick={() => actions?.onTile?.(null)}>
            {t('list.clearFilter')}
          </Button>
        </span>
      )}

      {loaded.problem || items === null ? (
        <ListState problem={loaded.problem} loading={items === null} onRetry={actions?.onRetry} />
      ) : items.length === 0 ? (
        <ListState
          loading={false}
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
      ) : table.total === 0 ? (
        <ListState
          loading={false}
          empty={{
            title: t('list.noMatch'),
            action: (
              <Button
                size="sm"
                onClick={() => {
                  actions?.onQuery?.('')
                  actions?.onTile?.(null)
                }}
              >
                {t('list.clearFilters')}
              </Button>
            ),
          }}
        />
      ) : (
        <ListTable
          label={t(office ? 'users.tableOffice' : 'users.tableFloor')}
          columns={table.columns}
          rows={table.rows}
          widths={table.widths}
          page={table.paged.page}
          pageCount={table.paged.pageCount}
          onPage={actions?.onPage}
          count={t('list.count', { shown: table.paged.rows.length, total: table.total })}
        />
      )}
      <p className="fw-adm-hint">{t('users.later')}</p>

      <InviteModal model={model} open={dialog === 'invite'} onClose={() => open(null)} actions={actions} />
      <AddWorkerModal model={model} open={dialog === 'add-worker'} onClose={() => open(null)} actions={actions} />
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
