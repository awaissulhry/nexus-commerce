'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { PartnerOrganisation } from '../partners/organisation/PartnerOrganisation'
import { UserSessions } from './sessions/UserSessions'
import { changeUser, endAssignment, giveRole, listAssignments, listCompanies, listRoles, listUsers, type Assignment, type Role, type User } from '../../shared/api'
import { runBulk } from '../../shared/bulk'
import { bulkNotice } from '../../shared/reach'
import { failed, loaded, loading, problemKey, problemNotice, type Loaded, type Notice, type ScopeOption } from '../../shared/model'
import { isStepUpCancelled, useStepUp } from '../../shared/step-up'
import { dayEnd, dayStart, isLastAdmin, personThreadMounted, userTabOf, type GiveRoleDraft, type UserDialog } from './model'
import { UserRecordView } from './view/UserRecordView'
// ---- B-TH-269: the docked thread on the person (RecordFrame, docked CLOSED — R-10; Activity's tools in its "⋯") ----
import { OfficeRecordThread } from '../../../_shared/record-thread/OfficeRecordThread'
import { printHref } from '../../../../shell/print/print-model'

const ACTION_PATH = { suspend: 'suspend', reactivate: 'reactivate', deactivate: 'deactivate', password: 'require-password-reset' } as const

/**
 * `/w/<company>/admin/users/<id>` (SCR-011 office): the person comes from `GET /auth/users` (the API has no read of one
 * person; the list also says whether they are the last administrator), their roles from `GET /auth/users/:id/roles`.
 * "End N" ends each ticked role with its own `POST /auth/role-assignments/:id/end` (no bulk route). Giving or ending a
 * role and each lifecycle change go through the step-up dialog when the API asks for a fresh code (A1 §3.10), with the
 * version read; a 409 reads the record again. B-TH-269 (`?tab=profile|roles|partner|sessions`, the old activity lands on Profile
 * with the thread shown): the person's thread docked CLOSED beside every tab (R-10), notes only, mounted with threads.read AND
 * users.view (B-TH-005: notes about a person are HR's and the administrator's, never every thread reader's).
 */
export function UserRecord({ userId }: { userId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = userTabOf(params?.get('tab')) // B-TH-269
  const [users, setUsers] = useState<User[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [assignments, setAssignments] = useState<Loaded<Assignment>>(loading())
  const [roles, setRoles] = useState<Role[] | null>(null)
  const [companies, setCompanies] = useState<ScopeOption[]>([])
  const [dialog, setDialog] = useState<UserDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const user = users?.find((item) => item.id === userId) ?? null

  const load = useCallback(async () => {
    try {
      const all = await listUsers(api)
      setUsers(all)
      setProblem(all.some((item) => item.id === userId) ? null : 'problem.notFound')
    } catch (error) {
      setProblem(problemKey(error))
    }
    if (held.has('roles.view')) {
      listAssignments(api, userId).then(
        (items) => setAssignments(loaded(items)),
        (error: unknown) => setAssignments(failed(problemKey(error))),
      )
      listRoles(api).then(setRoles, () => setRoles(null))
    } else setAssignments(failed('problem.forbidden'))
    if (held.has('companies.view'))
      listCompanies(api).then(
        (items) => setCompanies(items.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))),
        () => undefined,
      )
  }, [api, held, userId])
  useEffect(() => {
    void load()
  }, [load])

  /** One change after a fresh code when asked; success closes the dialog and reads the record again. */
  const change = async (sentence: string, work: () => Promise<unknown>, done: string, params?: Record<string, string | number>): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    try {
      await guard(sentence, work)
      setDialog(null)
      setNotice({ key: done, tone: 'success', params })
      await load()
      return true
    } catch (error) {
      if (!isStepUpCancelled(error)) {
        setDialogProblem(problemNotice(error).key)
        if (isApiError(error) && error.kind === 'conflict') void load()
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  // B-TH-269: the person's thread (notes only, docked closed by the view) with threads.read and users.view; the print view keeps the
  // panels' print form.
  const record = user && personThreadMounted('User', held) ? { type: 'User', id: user.id, companyId: null } : null
  const thread = user && record ? <OfficeRecordThread docked record={record} title={user.displayName} recordLabel={user.displayName} party={null} printHref={printHref(pathname, params?.toString() ?? '')} /> : null
  const printThread = user && record ? <RecordPanels record={record} title={user.displayName} /> : null

  return (
    <UserRecordView
      model={{
        prefix,
        tab,
        user,
        problem: user ? null : problem,
        me: session.user.id,
        assignments,
        roles,
        companies,
        can: { suspend: held.has('users.suspend'), reactivate: held.has('users.reactivate'), deactivate: held.has('users.deactivate'), resetPassword: held.has('users.resetPassword'), assign: held.has('roles.assign') },
        lastAdmin: !!users && !!roles && isLastAdmin(userId, users, roles),
        dialog,
        busy,
        dialogProblem,
        notice,
        stepUp,
        personId: session.user.id, // B-TH-269
      }}
      thread={thread}
      printThread={printThread}
      // B-W2b-180: a partner's organisation (partners.view), read and changed through the partner routes.
      // (an element mounts only when its tab draws it).
      partner={user?.audience === 'PARTNER' && user.partyId && held.has('partners.view') ? <PartnerOrganisation userId={user.id} partyId={user.partyId} onChanged={() => void load()} /> : null}
      // B-W2b-413: where the person is signed in now (users.sessions.manage).
      sessions={user && held.has('users.sessions.manage') ? <UserSessions prefix={prefix} userId={user.id} name={user.displayName} self={user.id === session.user.id} /> : null}
      actions={{
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
        },
        onGiveRole: (draft: GiveRoleDraft) =>
          change(
            'stepUp.sentence.giveRole',
            () =>
              giveRole(api, userId, {
                roleId: draft.roleId,
                allCompanies: draft.scope.allCompanies,
                companyIds: draft.scope.allCompanies ? [] : draft.scope.companyIds,
                siteIds: draft.scope.allCompanies ? [] : draft.scope.siteIds,
                ...(dayStart(draft.validFrom) ? { validFrom: dayStart(draft.validFrom) } : {}),
                ...(dayEnd(draft.validTo) ? { validTo: dayEnd(draft.validTo) } : {}),
              }),
            'user.done.given',
            { role: roles?.find((role) => role.id === draft.roleId)?.name ?? '' },
          ),
        onEndRoles: async (rows, reason) => {
          // One call per assignment (the API ends one at a time), one after the other: one fresh code covers them.
          setBusy(true)
          setDialogProblem(null)
          try {
            const result = await runBulk(rows, (assignment) => guard('stepUp.sentence.endRole', () => endAssignment(api, assignment.id, { version: assignment.version, ...(reason ? { reason } : {}) })))
            setDialog(null)
            setNotice(bulkNotice(result, 'user.bulk.done.end', (assignment) => assignment.roleName))
            return true
          } catch (error) {
            if (!isStepUpCancelled(error)) setDialogProblem(problemKey(error))
            return false
          } finally {
            setBusy(false)
            void load()
          }
        },
        onLifecycle: (action, reason) =>
          user ? change(`stepUp.sentence.${action}`, () => changeUser(api, user.id, ACTION_PATH[action], { version: user.version, ...(reason ? { reason } : {}) }), `user.done.${action}`) : Promise.resolve(false),
        onStepUp: (code) => void submitStepUp(code),
        onStepUpClose: cancelStepUp,
        onRetry: () => {
          setProblem(null)
          setUsers(null)
          void load()
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
