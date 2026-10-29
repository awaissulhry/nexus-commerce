'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { createWorker, invite, listCompanies, listRoles, listUsers, listWorkers, type Role, type User, type Worker } from '../shared/api'
import { adminHref, failed, loaded, loading, problemKey, type Loaded, type Notice, type ScopeOption } from '../shared/model'
import { isStepUpCancelled, useStepUp } from '../shared/step-up'
import { invitees, type Audience, type FloorTile, type InviteDraft, type InviteResult, type OfficeTile, type SiteOption, type UsersDialog, type WorkerDraft } from './model'
import { UsersView } from './view/UsersView'

/**
 * `/w/<company>/admin/users` (SCR-010): reads the office people (`GET /auth/users`), the floor workers
 * (`GET /auth/floor/workers`), the roles (names, grains, the invite's cards) and the companies with their sites (where a
 * role applies, the worker's site). Invites one person per call (each with its Idempotency-Key, so a retry never mails
 * twice) after a fresh code; adds a floor worker. `?audience=floor` opens the floor list; `?new=invite` the invite.
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
  }
  const [audience, setAudience] = useState<Audience>(params?.get('audience') === 'floor' || !can.viewUsers ? 'floor' : 'office')
  const [users, setUsers] = useState<Loaded<User>>(loading())
  const [workers, setWorkers] = useState<Loaded<Worker>>(loading())
  const [roles, setRoles] = useState<Role[] | null>(null)
  const [companies, setCompanies] = useState<ScopeOption[]>([])
  const [sites, setSites] = useState<SiteOption[]>([])
  const [tile, setTile] = useState<OfficeTile | FloorTile | null>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
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

  return (
    <UsersView
      model={{ prefix, audience, users, workers, roles, companies, sites, tile, query, page, asOf, can, notice, dialog, busy, dialogProblem, inviteResults, workerMade, stepUp }}
      actions={{
        onAudience: (next) => {
          setAudience(next)
          setTile(null)
          setPage(1)
        },
        onTile: (next) => {
          setTile(next)
          setPage(1)
        },
        onQuery: (next) => {
          setQuery(next)
          setPage(1)
        },
        onPage: setPage,
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
        onStepUp: (code) => void submitStepUp(code),
        onStepUpClose: cancelStepUp,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
