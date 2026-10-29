'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { listCompanies } from '../shared/api'
import { adminHref, failed, loaded, loading, problemKey, problemNotice, type Loaded, type Notice } from '../shared/model'
import { isStepUpCancelled, useStepUp } from '../shared/step-up'
import { runBulk } from '../kit/bulk'
import { bulkNotice, type BulkNotice } from '../kit/bulk-model'
import { checkIdentity, createIdentity, listAccounts, listIdentities, setPaused, type IntegrationAccount, type SendingIdentity } from './api'
import { identityState, type AddDomainDraft } from './mail/model'
import type { BulkSwitch, CompanyChoice, ConnectionTile, PauseConfirm } from './model'
import { ConnectionsView } from './view/ConnectionsView'

/**
 * `/w/<company>/admin/connections` (SCR-087 with SCR-015): the integration accounts (`GET /integrations/accounts`), the
 * companies for their names and the "Not connected" rows (`GET /org/companies`, with companies.view), the sending
 * identities (`GET /email/identities`, with email.send). Pause and resume with the version read; add a sending domain and
 * check one (email.manage, a step-up right: the dialog asks for a fresh code when the API does). `#mail` scrolls to the
 * mail domain once it is drawn.
 */
export function ConnectionsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const [accounts, setAccounts] = useState<Loaded<IntegrationAccount>>(loading())
  const [companies, setCompanies] = useState<CompanyChoice[] | null>(null)
  const [identities, setIdentities] = useState<Loaded<SendingIdentity>>(loading())
  const [asOf, setAsOf] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date().toISOString())
  const [tile, setTile] = useState<ConnectionTile | null>(null)
  const [query, setQuery] = useState('')
  const [connect, setConnect] = useState(false)
  const [confirm, setConfirm] = useState<PauseConfirm | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [bulk, setBulk] = useState<BulkSwitch | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<BulkNotice | null>(null)
  const [add, setAdd] = useState(false)
  const [mailBusy, setMailBusy] = useState(false)
  const [mailProblem, setMailProblem] = useState<string | null>(null)
  const [mailNotice, setMailNotice] = useState<Notice | null>(null)
  const [checking, setChecking] = useState<string | null>(null)

  const readIdentities = useCallback(async () => {
    if (!held.has('email.send')) return
    setIdentities(loading())
    try {
      setIdentities(loaded(await listIdentities(api)))
    } catch (error) {
      setIdentities(failed(problemKey(error)))
    }
  }, [api, held])

  const load = useCallback(async () => {
    setNow(new Date().toISOString())
    const companiesRead = held.has('companies.view')
      ? listCompanies(api)
          .then((rows) => setCompanies(rows.filter((row) => row.status === 'ACTIVE').map((row) => ({ id: row.id, code: row.code, name: row.legalName }))))
          .catch(() => setCompanies(null))
      : Promise.resolve()
    try {
      setAccounts(loaded(await listAccounts(api)))
      setAsOf(new Date().toISOString())
    } catch (error) {
      setAccounts(failed(problemKey(error)))
    }
    await Promise.all([companiesRead, readIdentities()])
  }, [api, held, readIdentities])
  useEffect(() => {
    void load()
  }, [load])

  // `/admin/connections#mail` (the set-up checklist's "Do it"): the section exists only once the reads are drawn.
  useEffect(() => {
    if (identities.items === null && !identities.problem) return
    try {
      if (window.location.hash === '#mail') document.getElementById('mail')?.scrollIntoView({ block: 'start' })
    } catch {
      // No scrolling: the page still works.
    }
  }, [identities])

  const sesAccounts = (accounts.items ?? []).filter((account) => account.provider === 'SES' && account.status !== 'DISABLED')

  return (
    <ConnectionsView
      model={{
        prefix,
        accounts,
        companies,
        tile,
        query,
        asOf,
        now,
        can: { manage: held.has('integrations.manage') },
        connect,
        confirm,
        selected,
        bulk,
        busy,
        dialogProblem,
        notice,
        stepUp,
        mail: held.has('email.send')
          ? {
              identities,
              companies: (companies ?? []).map((company) => ({ id: company.id, name: company.name })),
              sesAccounts,
              can: { manage: held.has('email.manage') },
              add: add ? {} : null,
              checking,
              busy: mailBusy,
              dialogProblem: mailProblem,
              notice: mailNotice,
            }
          : null,
      }}
      actions={{
        onTile: setTile,
        onQuery: setQuery,
        onRetry: () => {
          setAccounts(loading())
          void load()
        },
        onConnect: setConnect,
        onConfirm: (next) => {
          setDialogProblem(null)
          setConfirm(next)
        },
        onSwitch: async (account, pause, reason) => {
          setBusy(true)
          setDialogProblem(null)
          try {
            const next = await setPaused(api, account.id, pause, { version: account.version, ...(reason ? { reason } : {}) })
            setAccounts((current) => loaded((current.items ?? []).map((item) => (item.id === next.id ? next : item))))
            setConfirm(null)
            setNotice({ key: pause ? 'conn.done.paused' : 'conn.done.resumed', tone: 'success', params: { name: next.label } })
            return true
          } catch (error) {
            setDialogProblem(problemNotice(error).key)
            if (isApiError(error) && error.kind === 'conflict') void load()
            return false
          } finally {
            setBusy(false)
          }
        },
        onOpen: (account) => router.push(adminHref(prefix, `/connections/${account.id}`)),
        onSelect: setSelected,
        onBulk: (next) => {
          setDialogProblem(null)
          setBulk(next)
        },
        onBulkGo: async (chosen, pause, reason) => {
          setBusy(true)
          setDialogProblem(null)
          try {
            // One call per account (the API switches one at a time), each with the version read.
            const result = await runBulk(chosen, async (account) => {
              const next = await setPaused(api, account.id, pause, { version: account.version, ...(reason ? { reason } : {}) })
              setAccounts((current) => loaded((current.items ?? []).map((item) => (item.id === next.id ? next : item))))
            })
            const done = new Set(result.done.map((account) => account.id))
            setSelected((current) => current.filter((id) => !done.has(id)))
            const keys = pause ? { done: 'conn.bulk.pausedDone', partial: 'conn.bulk.pausedPartial', failed: 'conn.bulk.pausedFailed' } : { done: 'conn.bulk.resumedDone', partial: 'conn.bulk.resumedPartial', failed: 'conn.bulk.resumedFailed' }
            setNotice(bulkNotice(result, keys, (account) => account.id))
            setBulk(null)
            if (result.refused.some((entry) => entry.problem === 'problem.conflict')) void load()
          } catch (error) {
            setDialogProblem(problemKey(error))
            void load()
          } finally {
            setBusy(false)
          }
        },
        onDismissNotice: () => setNotice(null),
        onStepUp: (code) => void submitStepUp(code),
        onStepUpClose: cancelStepUp,
        mail: {
          onAdd: (open) => {
            setMailProblem(null)
            setAdd(open)
          },
          onCreate: async (draft: AddDomainDraft) => {
            setMailBusy(true)
            setMailProblem(null)
            const key = newIdempotencyKey()
            try {
              const answer = await guard('mail.stepUp.add', () =>
                createIdentity(api, { companyId: draft.companyId, kind: draft.kind, domain: draft.domain.trim(), localPart: draft.localPart.trim().toLowerCase(), displayNamePolicy: draft.displayNamePolicy, accountId: draft.accountId }, key),
              )
              setIdentities((current) => loaded([...(current.items ?? []), answer.identity]))
              setAdd(false)
              setMailNotice({ key: answer.sesChecked ? 'mail.done.added' : 'mail.done.addedNotChecked', tone: 'success', params: { domain: answer.identity.domain } })
              return true
            } catch (error) {
              if (!isStepUpCancelled(error)) setMailProblem(problemKey(error))
              return false
            } finally {
              setMailBusy(false)
            }
          },
          onCheck: (identity) => {
            setChecking(identity.id)
            setMailNotice(null)
            guard('mail.stepUp.check', () => checkIdentity(api, identity.id))
              .then((next) => {
                setIdentities((current) => loaded((current.items ?? []).map((item) => (item.id === next.id ? next : item))))
                setMailNotice({ key: `mail.done.checked.${identityState(next)}`, tone: identityState(next) === 'failed' ? 'warning' : 'success', params: { domain: next.domain } })
              })
              .catch((error: unknown) => {
                if (!isStepUpCancelled(error)) setMailNotice(problemNotice(error))
              })
              .finally(() => setChecking(null))
          },
          onRetry: () => void readIdentities(),
          onDismissNotice: () => setMailNotice(null),
        },
      }}
    />
  )
}
