'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { isApiError } from '../../../../../lib/api/errors'
import { companyPrefix } from '../../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { isStepUpCancelled, useStepUp } from '../../../shared/step-up'
import type { PortalNotice } from '../../../../sales/customers/portal/model'
import { changePartnerPerson, changePartnerStatus, getPortalAccess, revokeInvitation, type PortalAccess } from '../api'
import { dayOf, endOfDay, partnerCan, partnerChangeOf, partnerProblem } from '../model'
import { PartnerOrganisationView } from './view/PartnerOrganisationView'

/**
 * User › Partner organisation (`/w/<company>/admin/users/<id>?tab=partner`, B-W2b-180): the person's organisation's portal
 * access (`GET /partners/:partyId`: its admins and this person's role, capabilities and end of access); a new end date
 * (`PATCH /partners/:partyId/people/:userId`) and "Remove from organisation" (`POST …/deactivate`, an invited person's
 * invitation revoked instead), each after a fresh code when the API asks; `onChanged` reads the user record again.
 */
export function PartnerOrganisation({ userId, partyId, onChanged }: { userId: string; partyId: string; onChanged?: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => partnerCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const [access, setAccess] = useState<PortalAccess | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<PortalNotice | null>(null)
  const [now, setNow] = useState(() => new Date().toISOString())
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const load = useCallback(async () => {
    try {
      setAccess(await getPortalAccess(api, partyId))
      setProblem(null)
      setNow(new Date().toISOString())
    } catch (error) {
      setProblem(partnerProblem(error))
    }
  }, [api, partyId])
  useEffect(() => {
    void load()
  }, [load])
  useLiveBus({ onChange: (change) => (partnerChangeOf(change, partyId) ? void load() : undefined), onReconnect: () => void load() })

  const person = access?.people.find((entry) => entry.id === userId) ?? null

  const change = async (sentence: string, work: () => Promise<unknown>, done: PortalNotice, inDialog: boolean): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    try {
      await guard(sentence, work)
      setConfirm(false)
      setNotice(done)
      await load()
      onChanged?.()
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

  return (
    <PartnerOrganisationView
      model={{ prefix, userId, access, problem, can, today: dayOf(now), now, confirm, busy, dialogProblem, notice, stepUp }}
      actions={{
        onRetry: () => {
          setProblem(null)
          setAccess(null)
          void load()
        },
        onUntil: (day) =>
          person
            ? change('stepUp.sentence.person', () => changePartnerPerson(api, partyId, userId, { accessUntil: day ? endOfDay(day) : null, version: person.version }, newIdempotencyKey()), { key: 'done.until', tone: 'success', params: { name: person.displayName } }, false)
            : Promise.resolve(false),
        onConfirm: (open) => {
          setConfirm(open)
          setDialogProblem(null)
        },
        onRemove: (reason) => {
          if (!person) return Promise.resolve(false)
          if (person.status === 'INVITED') return change('stepUp.sentence.invite', () => revokeInvitation(api, partyId, userId, person.version), { key: 'done.revoke', tone: 'success', params: { count: 1 } }, true)
          return change('stepUp.sentence.status', () => changePartnerStatus(api, partyId, userId, 'deactivate', { version: person.version, ...(reason ? { reason } : {}) }), { key: 'done.removed', tone: 'success', params: { name: person.displayName } }, true)
        },
        onStepUp: (code) => void submitStepUp(code),
        onStepUpClose: cancelStepUp,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
