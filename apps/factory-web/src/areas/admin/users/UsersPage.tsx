'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { changeUser, createWorker, invite, listCompanies, listRoles, listUsers, listWorkers, setWorkerStatus, type Role, type User, type Worker } from '../shared/api'
import { runBulk, type BulkResult } from '../shared/bulk'
import { bulkNotice } from '../shared/reach'
import { adminHref, failed, loaded, loading, problemKey, type Loaded, type Notice, type ScopeOption } from '../shared/model'
import { isStepUpCancelled, useStepUp } from '../shared/step-up'
import { invitees, type Audience, type FloorAction, type FloorTile, type InviteDraft, type InviteResult, type OfficeAction, type OfficeTile, type SiteOption, type UsersDialog, type WorkerDraft } from './model'
import { UsersView } from './view/UsersView'

/**
 * `/w/<company>/admin/users` (SCR-010): reads the office people (`GET /auth/users`), the floor workers
 * (`GET /auth/floor/workers`), the roles (names, grains, the invite's cards) and the companies with their sites (where a
 * role applies, the worker's site). Invites one person per call (each with its Idempotency-Key, so a retry never mails
 * twice) after a fresh code; adds a floor worker; runs a bulk action as one call per person (`POST /auth/users/:id/
 * suspend|reactivate|deactivate`, `POST /auth/floor/workers/:id/deactivate|reactivate`: the API has no bulk route).
 * `?audience=floor` opens the floor list; `?new=invite` the invite.
 */
export function UsersPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = {
    viewUsers: held.has('users.view'),
    invite: held.has('users.invite'),
    assign: held.has('roles.assign'),
    viewWorkers: held.has('workers.view'),
    manageWorkers: held.has('workers.manage'),
    workerRoles: held.has('workers.roles'),
    suspend: held.has('users.suspend'),
    reactivate: held.has('users.reactivate'),
    deactivate: held.has('users.deactivate'),
  }
  const [audience, setAudience] = useState<Audience>(params?.get('audience') === 'floor' || !can.viewUsers ? 'floor' : 'office')
  const [users, setUsers] = useState<Loaded<User>>(loading())
  const [workers, setWorkers] = useState<Loaded<Worker>>(loading())
  const [roles, setRoles] = useState<Role[] | null>(null)
  const [companies, setCompanies] = useState<ScopeOption[]>([])
  const [sites, setSites] = useState<SiteOption[]>([])
  const [tile, setTile] = useState<OfficeTile | FloorTile | null>(null)
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState(1)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [inviteResults, setInviteResults] = useState<InviteResult[] | null>(null)
  const [workerMade, setWorkerMade] = useState<Worker | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  // One Idempotency-Key per invitee for as long as the dialog is open: a retry after a refusal never mails twice.
  const inviteKeys = useRef(new Map<string, string>())
  const workerKey = useRef<string | null>(null)
  const dialog: UsersDialog | null = params?.get('new') === 'invite' ? 'invite' : params?.get('new') === 'worker' ? 'add-worker' : null

  const load = useCallback(async () => {
    const reads: Array<Promise<void>> = []
    if (held.has('users.view'))
      reads.push(
        listUsers(api).then(
          (items) => setUsers(loaded(items)),
          (error: unknown) => setUsers(failed(problemKey(error))),
        ),
      )
    if (held.has('workers.view'))
      reads.push(
        listWorkers(api).then(
          (items) => setWorkers(loaded(items)),
          (error: unknown) => setWorkers(failed(problemKey(error))),
        ),
      )
    if (held.has('roles.view')) reads.push(listRoles(api).then(setRoles, () => setRoles(null)))
    if (held.has('companies.view'))
      reads.push(
        listCompanies(api).then(
          (items) => {
            setCompanies(items.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) })))
            setSites(items.flatMap((company) => company.sites.filter((site) => site.status === 'ACTIVE').map((site) => ({ id: site.id, name: site.name, companyId: company.id }))))
          },
          () => undefined,
        ),
      )
    await Promise.all(reads)
    setAsOf(new Date().toISOString())
  }, [api, held])
  useEffect(() => {
    void load()
  }, [load])

  const closeDialog = () => {
    setDialogProblem(null)
    setInviteResults(null)
    setWorkerMade(null)
    inviteKeys.current.clear()
    workerKey.current = null
    if (dialog) router.replace(adminHref(prefix, '/users'))
  }

  const onInvite = async (draft: InviteDraft): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    const roleInputs = draft.roleIds.map((roleId) => ({ roleId, allCompanies: draft.scope.allCompanies, companyIds: draft.scope.allCompanies ? [] : draft.scope.companyIds, siteIds: draft.scope.allCompanies ? [] : draft.scope.siteIds }))
    const results: InviteResult[] = []
    try {
      for (const person of invitees(draft)) {
        const email = person.email.trim()
        const key = inviteKeys.current.get(email.toLowerCase()) ?? newIdempotencyKey()
        inviteKeys.current.set(email.toLowerCase(), key)
        try {
          const answer = await guard('stepUp.sentence.invite', () => invite(api, { email, displayName: person.name.trim(), locale: draft.locale, roles: roleInputs }, key))
          results.push({ email, outcome: answer.delivery })
        } catch (error) {
          if (isStepUpCancelled(error)) throw error
          results.push({ email, outcome: 'refused', problem: isApiError(error) && error.kind === 'conflict' ? 'users.invite.exists' : problemKey(error) })
        }
      }
    } catch (error) {
      if (!isStepUpCancelled(error)) setDialogProblem(problemKey(error))
      setBusy(false)
      return false
    }
    setBusy(false)
    void load()
    if (results.every((result) => result.outcome !== 'refused')) {
      setNotice({ key: 'users.invite.done', tone: 'success', params: { count: results.length } })
      closeDialog()
      return true
    }
    setInviteResults(results)
    return false
  }

  const onAddWorker = async (draft: WorkerDraft): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    workerKey.current ??= newIdempotencyKey()
    try {
      const worker = await guard('stepUp.sentence.workerRoles', () =>
        createWorker(api, { siteId: draft.siteId, displayName: draft.displayName.trim(), locale: draft.locale, ...(draft.employeeCode.trim() ? { employeeCode: draft.employeeCode.trim() } : {}), ...(draft.roleIds.length ? { roleIds: draft.roleIds } : {}) }, workerKey.current!),
      )
      setWorkerMade(worker)
      void load()
      return true
    } catch (error) {
      if (!isStepUpCancelled(error)) setDialogProblem(problemKey(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** A bulk run: one call per row, one after the other (one code covers them); its ONE notice; the list read again. */
  const runRows = async <T,>(rows: readonly T[], sentence: string, call: (row: T) => Promise<unknown>, done: (result: BulkResult<T>) => Notice): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    try {
      const result = await runBulk(rows, (row) => guard(sentence, () => call(row)))
      setNotice(done(result))
      return true
    } catch (error) {
      if (!isStepUpCancelled(error)) setDialogProblem(problemKey(error))
      return false
    } finally {
      setBusy(false)
      void load()
    }
  }
  const onOfficeBulk = (action: OfficeAction, rows: readonly User[], reason: string) =>
    runRows(
      rows,
      `stepUp.sentence.${action}`,
      (user) => changeUser(api, user.id, action, { version: user.version, ...(reason ? { reason } : {}) }),
      (result) => bulkNotice(result, action === 'suspend' ? 'users.bulk.done.suspend' : action === 'reactivate' ? 'users.bulk.done.reactivate' : 'users.bulk.done.deactivate', (user) => user.displayName),
    )
  const onFloorBulk = (action: FloorAction, rows: readonly Worker[], reason: string) =>
    runRows(
      rows,
      'stepUp.sentence.default',
      (worker) => setWorkerStatus(api, worker.id, action, { version: worker.version, ...(reason ? { reason } : {}) }),
      (result) => bulkNotice(result, action === 'deactivate' ? 'users.bulk.done.workerDeactivate' : 'users.bulk.done.workerReactivate', (worker) => worker.displayName),
    )

  return (
    <UsersView
      model={{ prefix, audience, users, workers, roles, companies, sites, tile, query, pages, asOf, me: session.user.id, can, notice, dialog, busy, dialogProblem, inviteResults, workerMade, stepUp }}
      actions={{
        onAudience: (next) => {
          setAudience(next)
          setTile(null)
          setPages(1)
        },
        onTile: (next) => {
          setTile(next)
          setPages(1)
        },
        onQuery: (next) => {
          setQuery(next)
          setPages(1)
        },
        onMore: () => setPages((current) => current + 1),
        onOpen: (href) => router.push(href),
        onRetry: () => {
          setUsers(loading())
          setWorkers(loading())
          void load()
        },
        onDialog: (next) => {
          if (!next) closeDialog()
        },
        onInvite,
        onAddWorker,
        onOfficeBulk,
        onFloorBulk,
        onBulkClose: () => setDialogProblem(null),
        onStepUp: (code) => void submitStepUp(code),
        onStepUpClose: cancelStepUp,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
