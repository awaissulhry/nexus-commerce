'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import { downloadLink } from '../../../../../record-panels/api'
import { storeUrl } from '../../../../../record-panels/store'
import type { QuoteDetail } from '../../api'
import type { Grains } from '../../model'
import { checkLine, readLineConfigurator, removeArtwork, saveOrderOptions, saveQuoteOptions, uploadArtwork, type ArtworkFile, type CheckAnswer, type LineConfigurator, type LineTarget } from './api'
import { artworkRefusal, draftChanged, draftKey, draftOf, picksBody, saveHeld, setPick, togglePick, type DraftPick, type Say, type Tone } from './model'
import type { ConfiguratorActions, ConfiguratorModel } from './view/ConfiguratorView'
// B-W2b-374: an order line's artwork in the portal.
import { shareArtwork } from '../../../_shared/options-entry/api'

const CHECK_DELAY_MS = 400

export interface LineConfiguratorInput {
  api: ApiClient
  target: LineTarget
  grains: Grains
  /** QUOTE: the record takes the quote a write answers. */
  onQuote?: (next: QuoteDetail) => void
  /** ORDER: the record reads the order again after a write (its version moved). */
  onOrder?: () => void
  /** A key that moves when the line changes elsewhere (the quote's or the order's version): read again. */
  refreshKey?: string
}

const readProblem = (error: unknown): Say => ({ key: isApiError(error) && error.kind === 'forbidden' ? 'problem.forbidden' : 'problem.read' })

/**
 * THE container of a line's configurator (B-W2b-340): reads the line's configurator, keeps the person's draft, asks the API
 * to check every change of the draft (debounced: the price, margin and surcharges it would make come from B-W2b-330's
 * waterfall on the server, never computed here), writes the choice at the document's version (a quote answers the quote,
 * an order is read again by its record), and sends the customer's artwork (announce → the store → confirm).
 */
export function useLineConfigurator(input: LineConfiguratorInput): { model: ConfiguratorModel; actions: ConfiguratorActions } {
  const { api, target, grains, onQuote, onOrder } = input
  const [view, setView] = useState<LineConfigurator | null>(null)
  const [read, setRead] = useState<ConfiguratorModel['read']>({ status: 'loading' })
  const [draft, setDraft] = useState<DraftPick[]>([])
  const [preview, setPreview] = useState<ConfiguratorModel['preview']>({ status: 'idle', value: null })
  const [keepPrice, setKeepPrice] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: Tone; words: Say } | null>(null)
  const [uploading, setUploading] = useState<string[]>([])
  const [artworkProblem, setArtworkProblem] = useState<Say | null>(null)
  const [tries, setTries] = useState(0)
  const [online, setOnline] = useState(true)
  const lineKey = target.kind === 'QUOTE' ? `Q:${target.quoteId}:${target.lineId}` : `O:${target.orderId}:${target.lineId}`

  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' ? true : navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // A read after a write elsewhere keeps the person's unsaved draft; a save, Discard or the first read take the line's.
  const viewRef = useRef<LineConfigurator | null>(null)
  const draftRef = useRef<DraftPick[]>([])
  draftRef.current = draft
  const take = useCallback((next: LineConfigurator, keepUnsaved = false) => {
    const before = viewRef.current
    const unsaved = keepUnsaved && before !== null && draftChanged(draftRef.current, before.chosen, before.groups)
    viewRef.current = next
    setView(next)
    if (!unsaved) {
      setDraft(draftOf(next.chosen))
      setPreview({ status: 'idle', value: null })
      setKeepPrice(false)
    }
    setRead({ status: 'ready' })
  }, [])

  useEffect(() => {
    const control = new AbortController()
    setRead((current) => (view && current.status === 'ready' ? current : { status: 'loading' }))
    readLineConfigurator(api, target, control.signal)
      .then((next) => !control.signal.aborted && take(next, true))
      .catch((error: unknown) => !control.signal.aborted && setRead({ status: 'error', problem: readProblem(error) }))
    return () => control.abort()
    // The line, a write elsewhere (refreshKey) and Try again name the read.
  }, [api, lineKey, input.refreshKey, tries])

  const groups = view?.groups ?? []
  const changed = view ? draftChanged(draft, view.chosen, groups) : false
  const key = draftKey(draft, groups)

  // The API checks the draft (debounced); the answer of an older draft is dropped.
  const seq = useRef(0)
  useEffect(() => {
    if (!view || !changed) {
      setPreview({ status: 'idle', value: null })
      return
    }
    const mine = ++seq.current
    setPreview((current) => ({ status: 'checking', value: current.value }))
    const timer = setTimeout(() => {
      checkLine(api, target, picksBody(draft, groups))
        .then((value) => mine === seq.current && setPreview({ status: 'ready', value }))
        .catch(() => mine === seq.current && setPreview({ status: 'error', value: null }))
    }, CHECK_DELAY_MS)
    return () => clearTimeout(timer)
    // The draft's key names what is checked.
  }, [api, lineKey, key, view?.document.version])

  const save = useCallback(async () => {
    if (!view || saving) return
    setSaving(true)
    setNotice(null)
    try {
      if (target.kind === 'QUOTE') {
        const answer = await saveQuoteOptions(api, target, view.document.version, picksBody(draft, groups))
        onQuote?.(answer.quote)
        take(answer.line)
        setNotice({ tone: 'success', words: { key: answer.line.pricing.held ? 'save.done' : 'save.doneRepriced' } })
      } else {
        const answer = await saveOrderOptions(api, target, view.document.version, picksBody(draft, groups), keepPrice)
        take(answer.line)
        onOrder?.()
        setNotice({ tone: 'success', words: { key: 'save.done' } })
      }
    } catch (error) {
      const stale = isApiError(error) && error.kind === 'conflict' && (error.code === 'version_conflict' || error.issues.some((issue) => issuePath(issue).split(/[./]/).includes('version')))
      setNotice({ tone: 'danger', words: { key: stale ? 'problem.stale' : isApiError(error) && error.kind === 'forbidden' ? 'problem.forbidden' : 'problem.write' } })
      if (stale) setTries((value) => value + 1)
    } finally {
      setSaving(false)
    }
  }, [api, draft, groups, keepPrice, onOrder, onQuote, saving, take, target, view])

  const artwork = useCallback(
    async (files: File[]) => {
      setArtworkProblem(null)
      for (const file of files) {
        const refusal = artworkRefusal(file)
        if (refusal) {
          setArtworkProblem(refusal)
          continue
        }
        setUploading((current) => [...current, file.name])
        try {
          await uploadArtwork(api, target, file)
          setNotice({ tone: 'success', words: { key: 'artwork.done', params: { name: file.name } } })
        } catch {
          setArtworkProblem({ key: 'artwork.problem.failed' })
        } finally {
          setUploading((current) => current.filter((name) => name !== file.name))
        }
      }
      setTries((value) => value + 1)
    },
    [api, target],
  )

  const openArtwork = useCallback(
    async (file: ArtworkFile) => {
      try {
        const { download } = await downloadLink(api, file.fileId)
        window.open(storeUrl(download.url), '_blank', 'noopener')
      } catch {
        setArtworkProblem({ key: 'artwork.problem.failed' })
      }
    },
    [api],
  )

  const removeFile = useCallback(
    async (file: ArtworkFile) => {
      try {
        await removeArtwork(api, file.fileId)
      } catch {
        setArtworkProblem({ key: 'artwork.problem.failed' })
      }
      setTries((value) => value + 1)
    },
    [api],
  )

  // B-W2b-374 (XF3:04): an order line's artwork shown in (or out of) the customer's portal, then the line read again.
  const shareFile = useCallback(
    async (file: ArtworkFile, shown: boolean) => {
      if (target.kind !== 'ORDER') return
      try {
        await shareArtwork(api, target.orderId, target.lineId, file.fileId, shown)
        setNotice({ tone: 'success', words: { key: shown ? 'artwork.portal.shown' : 'artwork.portal.hidden' } })
      } catch {
        setArtworkProblem({ key: 'artwork.problem.share' })
      }
      setTries((value) => value + 1)
    },
    [api, target],
  )

  const previewValue: CheckAnswer | null = preview.status === 'ready' ? preview.value : null
  const held = saveHeld({ held: view && !view.may.configure ? view.may.held : null, changed, checking: preview.status === 'checking', preview: previewValue, saving, offline: !online, keepPrice, kind: target.kind }, draft, groups)

  const model: ConfiguratorModel = useMemo(
    () => ({
      mode: target.kind,
      read,
      style: view,
      line: view,
      draft,
      preview,
      grains,
      changed,
      saveHeld: held,
      saving,
      keepPrice,
      notice,
      artwork: { uploading, problem: artworkProblem },
      pictureUrl: view?.picture ? `/api/product/pictures/${encodeURIComponent(view.picture.fileId)}` : null,
    }),
    [target.kind, read, view, draft, preview, grains, changed, held, saving, keepPrice, notice, uploading, artworkProblem],
  )

  const actions: ConfiguratorActions = {
    onToggle: (group, valueId) => setDraft((current) => togglePick(current, group, valueId)),
    onText: (valueId, text) => setDraft((current) => setPick(current, valueId, { text })),
    onColour: (valueId, colourId) => setDraft((current) => setPick(current, valueId, { colourId })),
    onLeather: (valueId, itemId, itemColourId) => setDraft((current) => setPick(current, valueId, { itemId, itemColourId })),
    onSave: () => void save(),
    onDiscard: () => view && take(view),
    onKeepPrice: setKeepPrice,
    onArtwork: (files) => void artwork(files),
    onOpenArtwork: (file) => void openArtwork(file),
    onRemoveArtwork: (file) => void removeFile(file),
    onShareArtwork: (file, shown) => void shareFile(file, shown),
    onRetry: () => setTries((value) => value + 1),
    onDismissNotice: () => setNotice(null),
  }
  return { model, actions }
}
