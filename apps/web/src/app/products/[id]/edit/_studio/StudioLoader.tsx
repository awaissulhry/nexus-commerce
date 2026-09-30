'use client'

/**
 * The authenticated editor load.
 *
 * The browser owns the API session cookie. Start the authenticated reads here and cancel them
 * on navigation; the page can show its skeleton immediately without an unauthenticated pass.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import { Button } from '@/design-system/primitives'
import { EmptyState } from '@/design-system/components'

import { StudioClient } from './StudioClient'
import { loadStudioData, type StudioData } from './studio-data'
import { prefetchStudio } from './studioPrefetch'
import { preloadStudioTab } from './studioTabs'
import Loading from '../studio/loading'
import styles from './studio.module.css'

export function StudioLoader({ id }: { id: string }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; data: StudioData } | { kind: 'failed'; message: string }
  >({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  // P2 (I4-2) — the destination check and the sheet read need only the URL: start them now, beside the frame's own
  // reads, instead of after them. The hooks adopt them only if they resolve exactly the same reads. The tab the URL
  // opens loads its code meanwhile too (I4-7: every tab is its own chunk). The URL is read once, here, from the
  // location: subscribing to it (`useSearchParams`) would re-render the whole studio on every cell the URL records.
  useEffect(() => {
    const search = new URLSearchParams(window.location.search)
    prefetchStudio(id, search)
    preloadStudioTab(search.get('tab'))
  }, [id])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setState({ kind: 'loading' })
    void (async () => {
      const result = await loadStudioData(id, controller.signal)
      if (cancelled) return
      if (result.kind === 'ok') {
        setState({ kind: 'ok', data: result.data })
      } else if (result.kind === 'notfound') {
        setState({ kind: 'failed', message: 'This product no longer exists.' })
      } else {
        setState({
          kind: 'failed',
          // The code, when there is one: a 403 and a cold-start timeout are different problems and
          // "Couldn't load" alone sends the operator looking in the wrong place.
          message: result.code
            ? `The product could not be loaded (HTTP ${result.code}).`
            : 'The product could not be loaded — the request did not complete.',
        })
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [id, attempt])

  if (state.kind === 'loading') {
    return <Loading />
  }

  if (state.kind === 'failed') {
    return (
      <div className={styles.shell}>
        <div className={styles.centered}>
          <EmptyState
            icon={<AlertTriangle size={20} />}
            title="Couldn't open this product"
            description={state.message}
            action={
              <Button size="sm" variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  return (
    <StudioClient
      product={state.data.product}
      family={state.data.family}
      marketplaces={state.data.marketplaces}
      primaryLanguage={state.data.primaryLanguage}
      marketplacesFailed={state.data.marketplacesFailed}
    />
  )
}
