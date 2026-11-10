'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { useLiveChanges } from '../../../../../record-panels/live'
import { listStyles, type StyleView } from '../../api'
import type { StyleNotice } from '../record-model'
import {
  assignGtins,
  listGtinRanges,
  listTypes,
  moveLifecycle,
  putText,
  readGateSummary,
  readLifecycle,
  readPrivateLabel,
  readStyleType,
  readTexts,
  readWhereUsed,
  removeText,
  setPrivateLabel,
  setReplacement,
  setStyleType,
  type GateSummaryRow,
  type LifecycleView,
  type PrivateLabelView,
  type StyleTypeView,
  type TextsView,
  type TypeView,
  type WhereUsedView,
} from './api'
import {
  depthCan,
  depthProblem,
  NO_ASSIGN,
  ready,
  textInputOf,
  type AssignModel,
  type DepthDialog,
  type DepthNotice,
  type DepthPart,
  type DepthWrite,
  type MatrixShow,
  type StyleChoice,
  type StyleDepthActions,
  type StyleDepthModel,
} from './model'

/**
 * The Style studio's depth (B-W2b-237; SCR-342), its container hook: reads the lifecycle, the product type, the names per
 * language, the private label, where the style is used and its completeness while the Overview shows (each on its own: a
 * part that fails says so and the rest stays usable; again when the style's version changes, the texts on
 * `style.texts_changed`), and the GTIN ranges when Assign GTINs opens on Colourways & sizes. Every write goes through the
 * studio's ONE write queue (`write`: one at a time, the band's save words); a refusal is said here in our words and the
 * part is read again; a write that changed the style reads the style again (`reloadStyle`).
 */
export function useStyleDepth({
  api,
  style,
  prefix,
  tab,
  permissions,
  gateKey,
  write,
  reloadStyle,
}: {
  api: ApiClient
  style: StyleView | null
  prefix: string
  tab: string
  permissions: readonly string[]
  /** Changes when the revisions or the draft's BOM change: the completeness is read again. */
  gateKey: string | null
  write: (work: () => Promise<void>, done?: StyleNotice) => Promise<boolean>
  reloadStyle: () => void
}): { model: StyleDepthModel | null; actions: StyleDepthActions } {
  const can = depthCan(permissions)
  const styleId = style?.id ?? null
  const overview = tab === 'overview' && can.view && !!styleId
  const [lifecycle, setLifecycle] = useState<DepthPart<LifecycleView>>({ status: 'idle' })
  const [type, setType] = useState<DepthPart<StyleTypeView>>({ status: 'idle' })
  const [texts, setTexts] = useState<DepthPart<TextsView>>({ status: 'idle' })
  const [privateLabel, setPrivateLabelPart] = useState<DepthPart<PrivateLabelView>>({ status: 'idle' })
  const [whereUsed, setWhereUsed] = useState<DepthPart<WhereUsedView>>({ status: 'idle' })
  const [gate, setGate] = useState<DepthPart<GateSummaryRow | null>>({ status: 'idle' })
  const [types, setTypes] = useState<DepthPart<TypeView[]>>({ status: 'idle' })
  const [replacements, setReplacements] = useState<{ query: string; found: StyleChoice[] | null }>({ query: '', found: null })
  const [dialog, setDialog] = useState<DepthDialog | null>(null)
  const [notice, setNotice] = useState<DepthNotice | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(true)
  const [matrixShow, setMatrixShow] = useState<MatrixShow>('state')
  const [assign, setAssign] = useState<AssignModel>(NO_ASSIGN)
  const lifecycleRef = useRef<LifecycleView | null>(null)
  const textsRef = useRef<TextsView | null>(null)
  const labelRef = useRef<PrivateLabelView | null>(null)
  const assignRef = useRef<AssignModel>(NO_ASSIGN)
  assignRef.current = assign
  const dialogRef = useRef<DepthDialog | null>(null)
  dialogRef.current = dialog

  /** One read into its part: kept on screen while it is read again; a failure says why in our words. */
  const readInto = useCallback(<T,>(read: () => Promise<T>, set: (part: DepthPart<T>) => void, keep: { current: T | null } | null = null) => {
    if (!keep?.current) set({ status: 'loading' })
    read()
      .then((value) => {
        if (keep) keep.current = value
        set(ready(value))
      })
      .catch((error: unknown) => set({ status: 'error', problem: depthProblem(error, 'read').key }))
  }, [])

  const loadLifecycle = useCallback(() => styleId && readInto(() => readLifecycle(api, styleId), setLifecycle, lifecycleRef), [api, styleId, readInto])
  const loadType = useCallback(() => styleId && readInto(() => readStyleType(api, styleId), setType), [api, styleId, readInto])
  const loadTexts = useCallback(() => styleId && readInto(() => readTexts(api, styleId), setTexts, textsRef), [api, styleId, readInto])
  const loadLabel = useCallback(() => styleId && readInto(() => readPrivateLabel(api, styleId), setPrivateLabelPart, labelRef), [api, styleId, readInto])
  const loadWhereUsed = useCallback(() => styleId && readInto(() => readWhereUsed(api, styleId), setWhereUsed), [api, styleId, readInto])
  const loadGate = useCallback(() => styleId && readInto(() => readGateSummary(api, [styleId]).then((answer) => answer.styles.find((row) => row.styleId === styleId) ?? null), setGate), [api, styleId, readInto])

  // The style's own reads, again when its version changes (a move, the private label, the type, a W1 change).
  const versionKey = overview && style ? `${style.id}:${style.version}` : null
  useEffect(() => {
    if (!versionKey) return
    loadLifecycle()
    loadType()
    loadLabel()
    loadTexts()
    // The key holds the style and its version.
  }, [versionKey])
  // Where it is used: once per style on the Overview (other records change it; a reconnect reads it again).
  useEffect(() => {
    if (overview) loadWhereUsed()
  }, [overview, styleId])
  // The completeness: again when a revision or the draft's BOM changes.
  const completenessKey = overview && style ? `${style.id}:${style.version}:${gateKey ?? ''}` : null
  useEffect(() => {
    if (completenessKey) loadGate()
  }, [completenessKey])

  useLiveChanges(
    {
      onChange: (change) => {
        if (change.fields['styleId'] !== styleId || busy) return
        if (change.type === 'style.texts_changed') loadTexts()
        if (change.type === 'style.revision_released') loadGate()
      },
      onReconnect: () => {
        if (!overview) return
        loadWhereUsed()
        loadGate()
        loadTexts()
      },
    },
    overview,
  )

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

  /** One write through the studio's queue; the part takes the answer; a refusal is said in our words and read again. */
  const run = async (kind: DepthWrite, work: () => Promise<void>, done?: DepthNotice, after?: () => void): Promise<boolean> => {
    let failure: unknown = null
    setBusy(true)
    setProblem(null)
    const ok = await write(async () => {
      try {
        await work()
      } catch (error) {
        failure = error
        throw error
      }
    })
    setBusy(false)
    if (ok) {
      setNotice(done ?? null)
      after?.()
      return true
    }
    const said = depthProblem(failure, kind)
    // In a pop-up the refusal is said above its buttons; else in the section's banner.
    setProblem(said.key)
    setNotice(dialogRef.current ? null : { key: said.key, tone: 'danger' })
    if (said.reload) {
      reloadStyle()
      if (kind === 'text') loadTexts()
      if (kind === 'move') loadLifecycle()
      if (kind === 'label') loadLabel()
      if (kind === 'type') loadType()
    }
    return false
  }

  const closeOnSuccess = (ok: boolean) => {
    if (ok) setDialog(null)
    return ok
  }

  /** Assign GTINs: the ranges of the style's company, the first one picked and previewed. */
  const preview = (rangeId: string) => {
    if (!styleId) return
    setAssign((current) => ({ ...current, rangeId, preview: { status: 'loading' }, done: null, problem: null }))
    assignGtins(api, styleId, { rangeId, dryRun: true })
      .then((answer) => setAssign((current) => (current.rangeId === rangeId ? { ...current, preview: ready(answer) } : current)))
      .catch((error: unknown) => setAssign((current) => (current.rangeId === rangeId ? { ...current, preview: { status: 'error', problem: depthProblem(error, 'preview').key } } : current)))
  }
  const openAssign = () => {
    setAssign({ ...NO_ASSIGN, ranges: { status: 'loading' } })
    listGtinRanges(api, style?.companyId ?? null)
      .then((answer) => {
        const usable = answer.ranges.filter((range) => range.status === 'ACTIVE' && (style?.companyId === null || range.companyId === style?.companyId))
        const first = usable.find((range) => range.left > 0) ?? usable[0] ?? null
        setAssign((current) => ({ ...current, ranges: ready({ ...answer, ranges: usable }), rangeId: first?.id ?? null }))
        if (first) preview(first.id)
      })
      .catch((error: unknown) => setAssign((current) => ({ ...current, ranges: { status: 'error', problem: depthProblem(error, 'read').key } })))
  }

  const actions: StyleDepthActions = {
    onRetry: () => {
      loadLifecycle()
      loadType()
      loadTexts()
      loadLabel()
      loadWhereUsed()
      loadGate()
    },
    onDialog: (next) => {
      setProblem(null)
      setDialog(next)
      if (next?.kind === 'assign') openAssign()
      if (next?.kind === 'type' && style) {
        setTypes({ status: 'loading' })
        listTypes(api, { productType: style.productType, companyId: style.companyId })
          .then((rows) => setTypes(ready(rows)))
          .catch((error: unknown) => setTypes({ status: 'error', problem: depthProblem(error, 'read').key }))
      }
      if (next?.kind === 'move' || next?.kind === 'replacement') setReplacements({ query: '', found: null })
      if (next === null) setAssign(NO_ASSIGN)
    },
    onDismissNotice: () => setNotice(null),
    onMove: async (to, reason, replacedById) => {
      const current = lifecycleRef.current
      if (!styleId || !current) return false
      const ok = await run(
        'move',
        async () => {
          const next = await moveLifecycle(api, styleId, current.style.version, { to, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(replacedById !== undefined ? { replacedById } : {}) })
          lifecycleRef.current = next
          setLifecycle(ready(next))
        },
        { key: 'lifecycle.notice.moved', tone: 'success', params: { state: to } },
        reloadStyle,
      )
      return closeOnSuccess(ok)
    },
    onReplacement: async (replacedById, reason) => {
      const current = lifecycleRef.current
      if (!styleId || !current) return false
      const ok = await run(
        'move',
        async () => {
          const next = await setReplacement(api, styleId, current.style.version, replacedById, reason.trim() || undefined)
          lifecycleRef.current = next
          setLifecycle(ready(next))
        },
        { key: 'lifecycle.notice.replacement', tone: 'success' },
        reloadStyle,
      )
      return closeOnSuccess(ok)
    },
    onFindReplacement: (query) => {
      setReplacements({ query, found: null })
      if (query.trim().length < 2) return
      listStyles(api, { q: query.trim(), status: 'OPEN', limit: 10 })
        .then((page) => setReplacements((current) => (current.query === query ? { query, found: page.styles.filter((row) => row.id !== styleId).map((row) => ({ id: row.id, code: row.code, name: row.name })) } : current)))
        .catch(() => setReplacements((current) => (current.query === query ? { query, found: [] } : current)))
    },
    onSaveText: async (draft, version) => {
      if (!styleId) return false
      const ok = await run(
        'text',
        async () => {
          const next = await putText(api, styleId, draft.language.trim(), textInputOf(draft), version)
          textsRef.current = next
          setTexts(ready(next))
        },
        { key: version === null ? 'text.notice.added' : 'text.notice.saved', tone: 'success', params: { language: draft.language.trim() } },
      )
      return closeOnSuccess(ok)
    },
    onRemoveText: async (language, version) => {
      if (!styleId) return false
      const ok = await run(
        'text',
        async () => {
          const next = await removeText(api, styleId, language, version)
          textsRef.current = next
          setTexts(ready(next))
        },
        { key: 'text.notice.removed', tone: 'success', params: { language } },
      )
      return closeOnSuccess(ok)
    },
    onSoldUnderOurName: async (value, reason) => {
      const current = labelRef.current
      if (!styleId || !current) return false
      const ok = await run(
        'label',
        async () => {
          const next = await setPrivateLabel(api, styleId, { version: current.style.version, brandPartyId: current.brand?.id ?? null, soldUnderOurName: value, ...(reason.trim() ? { reason: reason.trim() } : {}) })
          labelRef.current = next
          setPrivateLabelPart(ready(next))
        },
        { key: value ? 'label.notice.ours' : 'label.notice.theirs', tone: 'success' },
        reloadStyle,
      )
      return closeOnSuccess(ok)
    },
    onSetType: async (typeId) => {
      const current = type.status === 'ready' ? type.value : null
      if (!styleId || !current) return false
      const ok = await run(
        'type',
        async () => {
          const next = await setStyleType(api, styleId, current.style.version, typeId)
          setType(ready(next))
        },
        { key: typeId ? 'type.notice.set' : 'type.notice.cleared', tone: 'success' },
        reloadStyle,
      )
      return closeOnSuccess(ok)
    },
    onMatrixShow: setMatrixShow,
    onPickRange: (rangeId) => preview(rangeId),
    onPreview: () => {
      if (assignRef.current.rangeId) preview(assignRef.current.rangeId)
    },
    onAssign: async () => {
      const current = assignRef.current
      const shown = current.preview?.status === 'ready' ? current.preview.value : null
      if (!styleId || !current.rangeId || !shown) return false
      let given: StyleDepthModel['assign']['done'] = null
      const ok = await run(
        'assign',
        async () => {
          given = await assignGtins(api, styleId, { rangeId: current.rangeId!, dryRun: false, rangeVersion: shown.rangeVersion, count: shown.count })
        },
        { key: 'gtin.notice.given', tone: 'success', params: { count: shown.count } },
        reloadStyle,
      )
      // Given: the dialog says what each SKU got. Refused: the preview is read again (the range or the SKUs moved).
      if (ok) setAssign((now) => ({ ...now, done: given, preview: null }))
      else preview(current.rangeId)
      return ok
    },
  }

  if (!style) return { model: null, actions }
  return {
    model: {
      prefix,
      styleId: style.id,
      styleCode: style.code,
      companyId: style.companyId,
      archived: style.status === 'ARCHIVED',
      can,
      online,
      busy,
      notice,
      lifecycle,
      type,
      texts,
      privateLabel,
      whereUsed,
      gate,
      dialog,
      types,
      replacements,
      matrixShow,
      assign,
      problem,
    },
    actions,
  }
}
