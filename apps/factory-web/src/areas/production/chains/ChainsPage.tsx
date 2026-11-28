'use client'

import { useCallback, useEffect, useState } from 'react'
import { isApiError } from '../../../lib/api/errors'
import { useOfficeApi } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useCoalesced, useLive } from '../_shared/hooks'
import { readChain, readLines, type Chain, type ChainLine } from './api'
import { CHAINS_NAMESPACES } from './model'
import { ChainsView } from './view/ChainsView'

/**
 * owb-fl9 step 3 — `/w/<company>/production/chains`: the chains, the first one open; its lots × steps read again when the floor reports
 * (a burst of scans is one read).
 */
export function ChainsPage() {
  return (
    <WithMessages namespaces={CHAINS_NAMESPACES}>
      <Container />
    </WithMessages>
  )
}

const problemKey = (error: unknown) => (isApiError(error) && error.kind === 'forbidden' ? 'error.forbidden' : 'error.read')

function Container() {
  const api = useOfficeApi()
  const [lines, setLines] = useState<readonly ChainLine[]>([])
  const [lineId, setLineId] = useState<string | null>(null)
  const [chain, setChain] = useState<Chain | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [problem, setProblem] = useState<string | null>(null)

  const loadLines = useCallback(() => {
    setState('loading')
    readLines(api)
      .then((answer) => {
        setLines(answer.lines)
        setLineId((now) => now ?? answer.lines[0]?.id ?? null)
        if (answer.lines.length === 0) setState('ready')
      })
      .catch((error: unknown) => {
        setState('failed')
        setProblem(problemKey(error))
      })
  }, [api])

  const loadChain = useCallback(() => {
    if (!lineId) return
    readChain(api, lineId)
      .then((answer) => {
        setChain(answer)
        setState('ready')
        setProblem(null)
      })
      .catch((error: unknown) => {
        setState('failed')
        setProblem(problemKey(error))
      })
  }, [api, lineId])

  useEffect(() => loadLines(), [loadLines])
  useEffect(() => loadChain(), [loadChain])

  const reread = useCoalesced(loadChain, 1500)
  useLive((change) => (change.type.startsWith('production.') ? reread() : undefined), loadChain)

  return (
    <ChainsView
      model={{ lines, lineId, chain, state, problem }}
      onLine={(id) => {
        setChain(null)
        setLineId(id || null)
      }}
      onRetry={() => (lineId ? loadChain() : loadLines())}
    />
  )
}
