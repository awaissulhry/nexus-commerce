'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { recordAddress } from '../../../../lib/records/record-links'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { isStepUpCancelled, useStepUp } from '../../../admin/shared/step-up'
import {
  askPartner,
  cancelRequest,
  changePartnerPerson,
  changePartnerStatus,
  changeSettings,
  getPortalAccess,
  invitePartner,
  listRequests,
  resendInvitation,
  revokeInvitation,
  type PartnerPerson,
  type PortalAccess as Access,
} from '../../../admin/users/partners/api'
import { dayOf, endOfDay, inviteBody, partnerCan, partnerChangeOf, partnerProblem, personBody, portalAddress, settingsBody, signedInOf, type RowAction } from '../../../admin/users/partners/model'
import { openPreview } from '../../../admin/users/partners/preview'
import type { PortalDialog, PortalNotice, PortalSide, RequestRow } from './model'
import { PortalAccessView } from './view/PortalAccessView'

const SENTENCE: Readonly<Record<RowAction, string>> = {
  resend: 'stepUp.sentence.invite',
  revoke: 'stepUp.sentence.invite',
  suspend: 'stepUp.sentence.status',
  reactivate: 'stepUp.sentence.status',
  deactivate: 'stepUp.sentence.status',
}

/**
 * The Portal access tab of a customer (`/w/<company>/sales/customers/<id>?tab=portal`) and of a supplier
 * (`/w/<company>/purchasing/suppliers/<id>?tab=portal`), mounted through the party record's `portal` slot: reads the
 * party's portal (`GET /partners/:partyId`: switch, limits, roles, people) and its open requests (`GET /partners/:partyId/
 * tasks`), each on its own; every change after a fresh code when the API asks (A1 §3.10), with the version read (a 409
 * reads again); an invitation keeps ONE Idempotency-Key while its dialog is open (a retry never mails twice). Live: the
 * party's partner events read the tab again; a sign-in names the person in the live line; a request's events read the
 * requests again.
 */
export function PortalAccess({ side, party }: { side: PortalSide; party: { id: string; name: string; companyId: string | null } }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => partnerCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const [access, setAccess] = useState<Access | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [requests, setRequests] = useState<{ items: RequestRow[] | null; problem: string | null }>({ items: null, problem: null })
  const [selected, setSelected] = useState<string[]>([])
  const [selectedRequests, setSelectedRequests] = useState<string[]>([])
  const [showLeft, setShowLeft] = useState(false)
  const [dialog, setDialogState] = useState<PortalDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<PortalNotice | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [signedIn, setSignedIn] = useState<{ name: string; at: string; first: boolean } | null>(null)
  const [now, setNow] = useState(() => new Date().toISOString())
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const inviteKey = useRef<string | null>(null)
  const askKey = useRef<string | null>(null)

  const load = useCallback(async (): Promise<Access | null> => {
    if (!can.view) return null
    try {
      const answer = await getPortalAccess(api, party.id)
      setAccess(answer)
      setProblem(null)
      setAsOf(new Date().toISOString())
      setNow(new Date().toISOString())
      return answer
    } catch (error) {
      setProblem(partnerProblem(error))
      return null
    }
  }, [api, can.view, party.id])

  const loadRequests = useCallback(async () => {
    if (!can.view) return
    try {
      const answer = await listRequests(api, party.id)
      setRequests({ items: answer.items.map((item) => ({ ...item, href: `${prefix}${recordAddress({ type: item.record.type, id: item.record.id, label: item.record.label, companyId: item.companyId }, OFFICE_PAGES)}` })), problem: null })
    } catch (error) {
      setRequests({ items: null, problem: partnerProblem(error) })
    }
  }, [api, can.view, party.id, prefix])

  useEffect(() => {
    void load()
    void loadRequests()
  }, [load, loadRequests])

  const live = useLiveBus({
    onChange: (change) => {
      if (partnerChangeOf(change, party.id)) {
        const userId = signedInOf(change)
        void load().then((answer) => {
          const person = userId ? answer?.people.find((entry) => entry.id === userId) : undefined
          if (person) setSignedIn({ name: person.displayName, at: new Date().toISOString(), first: change.fields.firstSignIn === true })
        })
      }
      if (change.type.startsWith('partner_task.') && change.fields.partyId === party.id) void loadRequests()
    },
    onReconnect: () => {
      void load()
      void loadRequests()
    },
  })

  const setDialog = (next: PortalDialog | null) => {
    setDialogState(next)
    setDialogProblem(null)
    if (next?.kind !== 'invite') inviteKey.current = null
    if (next?.kind !== 'ask') askKey.current = null
  }

  /** One change after a fresh code when asked: done → its notice, the dialog closes, the tab is read again. */
  const write = async (sentence: string, work: () => Promise<unknown>, done: PortalNotice, inDialog: boolean): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    try {
      await guard(sentence, work)
      setDialog(null)
      setNotice(done)
      await load()
      return true
    } catch (error) {
      if (!isStepUpCancelled(error)) {
        const key = partnerProblem(error)
        if (inDialog) setDialogProblem(key)
        else setNotice({ key, tone: key === 'problem.conflict' ? 'warning' : 'danger' })
        if (isApiError(error) && error.kind === 'conflict') void load()
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  /** A run over the ticked people: one call each, one after the other (one fresh code covers them); ONE notice. */
  const runRows = async (action: RowAction, people: readonly PartnerPerson[], reason: string): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    const done: PartnerPerson[] = []
    const refused: Array<{ name: string; problem: string }> = []
    try {
      for (const person of people) {
        try {
          await guard<unknown>(SENTENCE[action], (): Promise<unknown> => {
            if (action === 'resend') return resendInvitation(api, party.id, person.id)
            if (action === 'revoke') return revokeInvitation(api, party.id, person.id, person.version)
            return changePartnerStatus(api, party.id, person.id, action, { version: person.version, ...(reason ? { reason } : {}) })
          })
          done.push(person)
        } catch (error) {
          if (isStepUpCancelled(error)) throw error
          refused.push({ name: person.displayName, problem: partnerProblem(error) })
        }
      }
    } catch {
      setBusy(false)
      return false
    }
    setBusy(false)
    setDialog(null)
    setSelected([])
    setNotice({ key: `done.${action}`, tone: refused.length === 0 ? 'success' : done.length === 0 ? 'danger' : 'warning', params: { count: done.length }, ...(refused.length > 0 ? { refused } : {}) })
    await load()
    return true
  }

  const today = dayOf(now)

  return (
    <PortalAccessView
      model={{
        side,
        prefix,
        partyName: party.name,
        access,
        problem,
        can,
        today,
        now,
        asOf,
        live,
        signedIn,
        showLeft,
        selected,
        dialog,
        busy,
        dialogProblem,
        notice,
        stepUp,
        requests: { ...requests, selected: selectedRequests },
        previewing,
      }}
      actions={{
        onRetry: () => {
          setProblem(null)
          setAccess(null)
          void load()
        },
        onRetryRequests: () => {
          setRequests({ items: null, problem: null })
          void loadRequests()
        },
        onDialog: setDialog,
        onSelected: setSelected,
        onSelectedRequests: setSelectedRequests,
        onShowLeft: setShowLeft,
        onSaveSettings: (draft) => {
          if (!access) return Promise.resolve(false)
          const body = settingsBody(access.settings, draft)
          if (!body) return Promise.resolve(true)
          return write('stepUp.sentence.settings', () => changeSettings(api, party.id, body, newIdempotencyKey()), { key: 'done.settings', tone: 'success' }, false)
        },
        onInvite: (draft) => {
          inviteKey.current ??= newIdempotencyKey()
          const key = inviteKey.current
          return write('stepUp.sentence.invite', () => invitePartner(api, party.id, inviteBody(draft), key), { key: 'done.invited', tone: 'success', params: { name: draft.name.trim(), email: draft.email.trim() } }, true)
        },
        onChangePerson: (person, draft) => {
          const body = personBody(person, draft)
          if (!body) return Promise.resolve(true)
          return write('stepUp.sentence.person', () => changePartnerPerson(api, party.id, person.id, body, newIdempotencyKey()), { key: 'done.changed', tone: 'success', params: { name: person.displayName } }, true)
        },
        onRows: runRows,
        onPreview: () => {
          if (!access || previewing) return
          setPreviewing(true)
          openPreview(api, party.id, portalAddress(access.party.code))
            .then(() => setNotice({ key: 'done.preview', tone: 'info', params: { name: access.party.name } }))
            .catch((error: unknown) => setNotice({ key: partnerProblem(error), tone: 'danger' }))
            .finally(() => setPreviewing(false))
        },
        onAsk: async (kind, due) => {
          askKey.current ??= newIdempotencyKey()
          const key = askKey.current
          setBusy(true)
          setDialogProblem(null)
          try {
            await askPartner(api, party.id, { kind, recordType: 'Party', recordId: party.id, dueAt: due ? endOfDay(due) : null, ...(party.companyId === null && session.company ? { companyId: session.company.id } : {}) }, key)
            setDialog(null)
            setNotice({ key: 'done.asked', tone: 'success', params: { name: access?.party.name ?? party.name } })
            void loadRequests()
            return true
          } catch (error) {
            setDialogProblem(partnerProblem(error))
            return false
          } finally {
            setBusy(false)
          }
        },
        onCancelRequests: async (rows) => {
          setBusy(true)
          setDialogProblem(null)
          const refused: Array<{ name: string; problem: string }> = []
          let count = 0
          for (const row of rows) {
            try {
              await cancelRequest(api, row.id, row.version, newIdempotencyKey())
              count += 1
            } catch (error) {
              refused.push({ name: row.record.label, problem: partnerProblem(error) })
            }
          }
          setBusy(false)
          setDialog(null)
          setSelectedRequests([])
          setNotice({ key: 'done.cancelled', tone: refused.length === 0 ? 'success' : count === 0 ? 'danger' : 'warning', params: { count }, ...(refused.length > 0 ? { refused } : {}) })
          void loadRequests()
          return true
        },
        onStepUp: (code) => void submitStepUp(code),
        onStepUpClose: cancelStepUp,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
