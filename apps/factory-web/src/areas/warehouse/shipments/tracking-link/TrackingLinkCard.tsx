'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../hooks'
import { makeTrackingLink, readTrackingLinks, revokeTrackingLink } from './api'
import { emailProblem, initialCard, outcomeOfError, type TrackingLinkCardActions, type TrackingLinkCardModel } from './model'
import { TrackingLinkCardView } from './view/TrackingLinkCardView'

/**
 * The shipment's tracking-page card on the record's Tracking & delivery tab (B-W2b-170; SCR-067): reads the links
 * (`GET /shipping/shipments/:id/tracking-links`, shipping.view), reads again when a tracking link of this shipment is made
 * anywhere (the live event shipment.tracking_link_made) or on reconnect, and does what the view asks, one write at a time,
 * each with its own Idempotency-Key. A link to pass on is copied to the clipboard at once and shown this once.
 */
export function TrackingLinkCard({ shipmentId }: { shipmentId: string }) {
  const api = useOfficeApi()
  const [model, setModel] = useState<TrackingLinkCardModel>(initialCard)
  const latest = useRef(model)
  latest.current = model

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setModel((state) => ({ ...state, state: state.read ? state.state : 'loading' }))
      try {
        const read = await readTrackingLinks(api, shipmentId)
        setModel((state) => ({ ...state, state: 'ready', read }))
      } catch {
        setModel((state) => (quiet && state.read ? state : { ...state, state: 'error' }))
      }
    },
    [api, shipmentId],
  )

  useEffect(() => {
    void load()
  }, [load])

  useLive(
    (change) => {
      if (change.type === 'shipment.tracking_link_made' && change.fields.shipmentId === shipmentId) void load(true)
    },
    () => void load(true),
  )

  const copyText = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => true)
      .catch(() => false) ?? Promise.resolve(false)

  const make = useCallback(
    async (busy: 'send' | 'other' | 'copy', body: { send: boolean; email?: string }) => {
      setModel((state) => ({ ...state, busy, outcome: null, passOn: busy === 'copy' ? null : state.passOn }))
      try {
        const made = await makeTrackingLink(api, shipmentId, body, newIdempotencyKey())
        const copied = made.url ? await copyText(made.url) : false
        setModel((state) => ({
          ...state,
          busy: null,
          read: made.tracking,
          passOn: made.url ? { url: made.url, copied } : state.passOn,
          other: busy === 'other' ? { open: false, email: '', problem: null } : state.other,
          outcome: body.send ? (made.links.length > 0 ? { kind: 'sent', count: made.links.length } : { kind: 'skipped' }) : null,
        }))
      } catch (error) {
        setModel((state) => ({ ...state, busy: null, outcome: outcomeOfError(error) }))
      }
    },
    [api, shipmentId],
  )

  const actions = useMemo<TrackingLinkCardActions>(
    () => ({
      onRetry: () => void load(),
      onSend: () => void make('send', { send: true }),
      onCopy: () => void make('copy', { send: false }),
      onOther: (open) => setModel((state) => ({ ...state, other: { ...state.other, open, problem: null } })),
      onOtherEmail: (email) => setModel((state) => ({ ...state, other: { ...state.other, email, problem: null } })),
      onSendOther: () => {
        const { email } = latest.current.other
        const problem = emailProblem(email)
        if (problem) {
          setModel((state) => ({ ...state, other: { ...state.other, problem } }))
          return
        }
        void make('other', { send: true, email: email.trim() })
      },
      onCopyAgain: () => {
        const passOn = latest.current.passOn
        if (passOn) void copyText(passOn.url).then((copied) => setModel((state) => (state.passOn ? { ...state, passOn: { ...state.passOn, copied } } : state)))
      },
      onRevoke: (linkId) => {
        setModel((state) => ({ ...state, busy: `revoke:${linkId}`, outcome: null }))
        revokeTrackingLink(api, shipmentId, linkId, newIdempotencyKey())
          .then((read) => setModel((state) => ({ ...state, busy: null, read })))
          .catch((error: unknown) => setModel((state) => ({ ...state, busy: null, outcome: outcomeOfError(error) })))
      },
    }),
    [api, shipmentId, load, make],
  )

  return <TrackingLinkCardView model={model} actions={actions} />
}
