'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { browserApi } from '../../lib/api/browser'
import type { ApiClient } from '../../lib/api/client'
import { brandingTokensOf } from '../../lib/api/branding'
import { openLink } from '../../lib/api/links'
import { readChallenge, readSearchHead, searchShipments, type SearchBody } from './api'
import { useTracking } from './hooks'
import { EMPTY_SEARCH, hasProblems, initialTracking, searchFieldProblems, searchRefusal, type TrackingActions, type TrackingViewModel } from './model'
import { solveChallenge } from './pow'
import { TrackingView } from './view/TrackingView'

/**
 * `/t?tenant=<slug>&company=<code>` — Find your order (SCR-194 sec:search; B-W2b-170; LOG-062): the public search by the
 * customer's order reference and the delivery postcode, for whoever has no link. The page heads with the company's public
 * branding (`GET /branding/portal-sign-in`, B-W2b-164's head: whose company, whom to ask). The fields are checked here
 * first (the API's own rule); a search answers the same for every miss; a 429 holds the button with the wait, or asks the
 * browser to solve a proof of work once and sends again (B-W2b-159). A shipment found brings a one-day link's token: the
 * page opens it (`POST /link/open`) and shows its tracking below, from memory only — reloading the page starts over.
 */
export function TrackSearch({ address }: { address: { readonly tenant: string; readonly company: string | null } | null }) {
  const [model, setModel] = useState<TrackingViewModel>(() => initialTracking({ ...EMPTY_SEARCH, head: address ? 'loading' : 'missing' }))
  const [linkApi, setLinkApi] = useState<ApiClient | null>(null)
  const publicApi = useMemo(() => browserApi(), [])
  const tracking = useTracking(linkApi, model, setModel)
  const latest = useRef(model)
  latest.current = model

  useEffect(() => {
    if (!address) return
    let live = true
    readSearchHead(publicApi, address)
      .then((head) => {
        if (!live) return
        const sender = { ...brandingTokensOf(head.branding, 'company'), contactEmail: head.contact.email }
        setModel((state) => ({ ...state, search: state.search ? { ...state.search, head: 'ready', sender } : state.search }))
      })
      .catch(() => live && setModel((state) => ({ ...state, search: state.search ? { ...state.search, head: 'failed' } : state.search })))
    return () => {
      live = false
    }
  }, [address, publicApi])

  const open = useCallback((token: string) => {
    const client = browserApi({ linkToken: token })
    // The open is evidence on the link (never a use); a failed open still lets the read say what is wrong.
    void openLink(client).catch(() => undefined)
    setModel((state) => ({ ...initialTracking(state.search), search: state.search ? { ...state.search, state: state.search.state === 'several' ? 'several' : 'idle' } : null }))
    setLinkApi(client)
  }, [])

  const run = useCallback(
    async (proof?: SearchBody['proof']) => {
      if (!address) return
      const search = latest.current.search!
      try {
        const answer = await searchShipments(publicApi, { tenant: address.tenant, company: address.company, reference: search.reference, postcode: search.postcode, ...(proof ? { proof } : {}) })
        if (answer.shipments.length === 0) setModel((state) => ({ ...state, search: { ...state.search!, state: 'miss', found: [] } }))
        else if (answer.shipments.length === 1) {
          setModel((state) => ({ ...state, search: { ...state.search!, state: 'idle', found: [] } }))
          open(answer.shipments[0]!.token)
        } else setModel((state) => ({ ...state, search: { ...state.search!, state: 'several', found: answer.shipments } }))
      } catch (error) {
        const refusal = searchRefusal(error)
        if (refusal.kind === 'challenge' && !proof) {
          setModel((state) => ({ ...state, search: { ...state.search!, state: 'checking' } }))
          try {
            const challenge = await readChallenge(publicApi)
            const nonce = await solveChallenge(challenge.challenge, challenge.bits)
            if (nonce) return run({ challenge: challenge.challenge, nonce })
          } catch {
            // Said below as an error.
          }
          setModel((state) => ({ ...state, search: { ...state.search!, state: 'error' } }))
        } else if (refusal.kind === 'wait') setModel((state) => ({ ...state, search: { ...state.search!, state: 'wait', waitMinutes: refusal.minutes } }))
        else setModel((state) => ({ ...state, search: { ...state.search!, state: 'error' } }))
      }
    },
    [address, open, publicApi],
  )

  const actions = useMemo<TrackingActions>(
    () => ({
      ...tracking,
      onSearchField: (field, value) =>
        setModel((state) => {
          if (!state.search) return state
          const problems = { ...state.search.problems }
          delete problems[field]
          return { ...state, search: { ...state.search, [field]: value, problems, state: state.search.state === 'miss' || state.search.state === 'error' ? 'idle' : state.search.state } }
        }),
      onSearch: () => {
        const search = latest.current.search
        if (!search || search.state === 'searching' || search.state === 'checking') return
        const problems = searchFieldProblems(search.reference, search.postcode)
        if (hasProblems(problems)) {
          setModel((state) => ({ ...state, search: { ...state.search!, problems } }))
          return
        }
        setLinkApi(null)
        setModel((state) => ({ ...initialTracking({ ...state.search!, problems: {}, state: 'searching', found: [] }) }))
        void run()
      },
      onPick: (token) => open(token),
      onSearchAgain: () => {
        setLinkApi(null)
        setModel((state) => initialTracking(state.search ? { ...state.search, state: 'idle', found: [] } : null))
      },
    }),
    [tracking, run, open],
  )

  return <TrackingView model={model} actions={actions} />
}
