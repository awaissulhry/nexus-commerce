'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../../lib/api/client'
import type { StyleView } from '../../../api'
import type { StyleNotice } from '../../record-model'
import { ready, type DepthPart } from '../model'
import { readStyleMarkets, saveStyleMarkets, type StyleMarketsView } from './api'
import { codesToSend, marketsProblem, readProblem, saveHeld, type MarketsActions, type MarketsModel } from './model'

/**
 * The Overview's "Markets" (B-W2b-283, FU1:01), its container hook: reads the style's markets while the Overview shows (again
 * when the style's version changes), keeps the pick, and saves the whole list through the studio's ONE write queue (`write`:
 * one at a time, the band's save words); a refusal is said in our words above the pick and the markets are read again; a
 * save reads the style again (its version moved).
 */
export function useStyleMarkets({
  api,
  style,
  tab,
  permissions,
  write,
  reloadStyle,
}: {
  api: ApiClient
  style: StyleView | null
  tab: string
  permissions: readonly string[]
  write: (work: () => Promise<void>, done?: StyleNotice) => Promise<boolean>
  reloadStyle: () => void
}): { model: MarketsModel | null; actions: MarketsActions } {
  const styleId = style?.id ?? null
  const shown = tab === 'overview' && permissions.includes('product.styles.view') && !!styleId
  const [part, setPart] = useState<DepthPart<StyleMarketsView>>({ status: 'idle' })
  const [pick, setPick] = useState<MarketsModel['pick']>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<MarketsModel['notice']>(null)
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(true)
  const kept = useRef<StyleMarketsView | null>(null)

  const load = useCallback(() => {
    if (!styleId) return
    if (!kept.current || kept.current.style.id !== styleId) setPart({ status: 'loading' })
    readStyleMarkets(api, styleId)
      .then((view) => {
        kept.current = view
        setPart(ready(view))
      })
      .catch((error: unknown) => setPart({ status: 'error', problem: readProblem(error) }))
  }, [api, styleId])

  const versionKey = shown && style ? `${style.id}:${style.version}` : null
  useEffect(() => {
    if (versionKey) load()
    // The key holds the style and its version.
  }, [versionKey])

  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' || navigator.onLine !== false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const model: MarketsModel | null = shown ? { styleCode: style?.code ?? '', part, online, busy, pick, problem, notice } : null

  const save = async () => {
    const view = kept.current
    if (!model || !view || !pick || !styleId || saveHeld(model)) return
    const marketCodes = codesToSend(view, pick.codes)
    let failure: unknown = null
    setBusy(true)
    setProblem(null)
    const ok = await write(async () => {
      try {
        const next = await saveStyleMarkets(api, styleId, { version: view.style.version, marketCodes })
        kept.current = next
        setPart(ready(next))
      } catch (error) {
        failure = error
        throw error
      }
    })
    setBusy(false)
    if (ok) {
      setPick(null)
      setNotice(marketCodes.length === 0 ? { key: 'markets.notice.every', tone: 'success' } : { key: 'markets.notice.saved', tone: 'success', params: { count: marketCodes.length } })
      reloadStyle()
      return
    }
    const said = marketsProblem(failure)
    setProblem(said.key)
    if (said.reload) {
      load()
      reloadStyle()
    }
  }

  const actions: MarketsActions = {
    onOpen: () => {
      const view = kept.current
      if (!view) return
      setProblem(null)
      setNotice(null)
      setPick({ codes: [...view.marketCodes] })
    },
    onToggle: (code) => setPick((current) => (current ? { codes: current.codes.includes(code) ? current.codes.filter((entry) => entry !== code) : [...current.codes, code] } : current)),
    onEvery: () => setPick((current) => (current ? { codes: [] } : current)),
    onSave: () => void save(),
    onClose: () => {
      setPick(null)
      setProblem(null)
    },
    onRetry: load,
    onDismissNotice: () => setNotice(null),
  }
  return { model, actions }
}
