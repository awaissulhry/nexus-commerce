'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { listContacts } from '../../../quality/complaints/api'
import { sendClaimLink } from './api'
import { claimLinkBody, claimLinkHeld, claimLinkRefusal, type ClaimLinkActions, type ClaimLinkModel } from './model'
import { ClaimLinkDialog } from './view/ClaimLinkDialog'

/**
 * F-OS-303 (order SHIPMENTS tab) — Send a claim link…, mounted only while open (the order's Shipments tab: a shipment's row ⋯ for that
 * shipment, the section's ⋯ for the order): reads the customer's contacts with an e-mail (parties.view; without it only an address
 * typed), then ONE `POST /sales/claim-links` with its own Idempotency-Key. Sent, it says to whom and until when; Close ends it.
 */
export function ClaimLink({ partyId, record, onClose }: { partyId: string; record: ClaimLinkModel['record']; onClose: () => void }) {
  const api = useOfficeApi()
  const [model, setModel] = useState<ClaimLinkModel>({ record, contacts: null, to: '', email: '', busy: false, problem: null, sent: null })
  const latest = useRef(model)
  latest.current = model
  const key = useRef(newIdempotencyKey())

  useEffect(() => {
    const abort = new AbortController()
    listContacts(api, partyId, abort.signal)
      .then((contacts) => {
        const withMail = contacts.flatMap((contact) => (contact.email ? [{ id: contact.id, name: contact.name, email: contact.email }] : []))
        setModel((state) => ({ ...state, contacts: withMail, to: state.to || (withMail.length === 1 ? withMail[0]!.id : '') }))
      })
      .catch(() => !abort.signal.aborted && setModel((state) => ({ ...state, contacts: [] })))
    return () => abort.abort()
  }, [api, partyId])

  const send = useCallback(() => {
    const state = latest.current
    if (state.sent || claimLinkHeld(state)) return
    setModel((current) => ({ ...current, busy: true, problem: null }))
    sendClaimLink(api, claimLinkBody(state), key.current)
      .then((answer) => {
        key.current = newIdempotencyKey()
        setModel((current) => ({ ...current, busy: false, sent: answer }))
      })
      .catch((error: unknown) => setModel((current) => ({ ...current, busy: false, problem: claimLinkRefusal(error) })))
  }, [api])

  const actions = useMemo<ClaimLinkActions>(
    () => ({
      onTo: (to) => setModel((state) => ({ ...state, to, problem: null })),
      onEmail: (email) => setModel((state) => ({ ...state, email, problem: null })),
      onSend: send,
      onClose,
    }),
    [send, onClose],
  )

  return <ClaimLinkDialog model={model} actions={actions} />
}
