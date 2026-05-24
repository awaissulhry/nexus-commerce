'use client'

// EC.2.2 — FieldSourceProvider
//
// Single React context that owns every field's source state for one
// (productId, marketplace) pair, plus the cockpit-wide diff-modal
// slot. The provider exposes a tiny imperative API — useFieldSource
// is the consumer-facing facade that wraps it for ergonomics.
//
// Persistence: localStorage during EC.2. EC.10 wires the same shape
// into the DSP-series Save All flow → PATCH
// /api/products/:id/listings/:ch/:mp { platformAttributes: { _fieldSources } }
// without consumer-side changes.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { FieldSource, FieldSourceState, HistoryEntry, PendingDiff } from './types'

const MAX_HISTORY = 5

interface InternalState {
  fields: Record<string, FieldSourceState>
}

interface ProviderApi {
  /** Read current state for a field. Falls back to a default entry if
   *  the field hasn't been touched yet. */
  read(fieldKey: string, fallback: { source: FieldSource; value: string }): FieldSourceState
  /** Write a new value WITHOUT changing the source (used for direct
   *  typing in manual mode + when a resolver applies a value). */
  setValue(fieldKey: string, value: string): void
  /** Switch source. Pushes the prior {source,value} into history.
   *  Caller is responsible for invoking the resolver and showing the
   *  diff modal first — see useFieldSource.switchSource. */
  applySwitch(fieldKey: string, nextSource: FieldSource, nextValue: string): void
  lock(fieldKey: string, locked: boolean): void
  undo(fieldKey: string): boolean
  /** Open the cockpit-wide diff modal. Only one can be open at a
   *  time; opening a second cancels the first. */
  requestDiff(pending: PendingDiff): void
  pendingDiff: PendingDiff | null
}

const FieldSourceContext = createContext<ProviderApi | null>(null)

function storageKey(productId: string, marketplace: string) {
  return `nx.ebay-cockpit.field-sources.${productId}.${marketplace}`
}

function loadFromStorage(productId: string, marketplace: string): InternalState {
  try {
    const raw = window.localStorage.getItem(storageKey(productId, marketplace))
    if (!raw) return { fields: {} }
    const parsed = JSON.parse(raw) as InternalState
    if (parsed && typeof parsed === 'object' && parsed.fields) return parsed
    return { fields: {} }
  } catch {
    return { fields: {} }
  }
}

function saveToStorage(productId: string, marketplace: string, state: InternalState) {
  try {
    window.localStorage.setItem(
      storageKey(productId, marketplace),
      JSON.stringify(state),
    )
  } catch {
    // ignore — private mode / quota
  }
}

interface ProviderProps {
  productId: string
  marketplace: string
  children: React.ReactNode
}

export function FieldSourceProvider({ productId, marketplace, children }: ProviderProps) {
  const [state, setState] = useState<InternalState>(() => ({ fields: {} }))
  const [pendingDiff, setPendingDiff] = useState<PendingDiff | null>(null)
  const hydratedRef = useRef(false)
  const persistTimerRef = useRef<number | null>(null)

  // Hydrate from localStorage once on mount. We deliberately do this
  // in an effect (vs lazy useState) because localStorage is undefined
  // during SSR — the page does prerender once.
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    setState(loadFromStorage(productId, marketplace))
  }, [productId, marketplace])

  // Persist on change, debounced. Debounce is short (250ms) because
  // operators may switch sources rapidly and we don't want to thrash
  // localStorage on every keystroke either.
  useEffect(() => {
    if (!hydratedRef.current) return
    if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(() => {
      saveToStorage(productId, marketplace, state)
    }, 250)
    return () => {
      if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current)
    }
  }, [state, productId, marketplace])

  const read = useCallback(
    (fieldKey: string, fallback: { source: FieldSource; value: string }): FieldSourceState => {
      const entry = state.fields[fieldKey]
      if (entry) return entry
      return {
        source: fallback.source,
        value: fallback.value,
        locked: false,
        history: [],
      }
    },
    [state],
  )

  const setValue = useCallback((fieldKey: string, value: string) => {
    setState((prev) => {
      const entry = prev.fields[fieldKey] ?? {
        source: 'manual' as FieldSource,
        value: '',
        locked: false,
        history: [],
      }
      // Typing into a non-manual-source field implicitly switches it
      // to manual (so the value isn't reverted on next master refresh).
      const nextSource: FieldSource =
        entry.source === 'manual' ? 'manual' : 'manual'
      const history: HistoryEntry[] = entry.value !== value
        ? [{ source: entry.source, value: entry.value, timestamp: new Date().toISOString() }, ...entry.history].slice(0, MAX_HISTORY)
        : entry.history
      return {
        fields: {
          ...prev.fields,
          [fieldKey]: { ...entry, source: nextSource, value, history },
        },
      }
    })
  }, [])

  const applySwitch = useCallback(
    (fieldKey: string, nextSource: FieldSource, nextValue: string) => {
      setState((prev) => {
        const entry = prev.fields[fieldKey] ?? {
          source: 'default' as FieldSource,
          value: '',
          locked: false,
          history: [],
        }
        const history: HistoryEntry[] = [
          { source: entry.source, value: entry.value, timestamp: new Date().toISOString() },
          ...entry.history,
        ].slice(0, MAX_HISTORY)
        return {
          fields: {
            ...prev.fields,
            [fieldKey]: { ...entry, source: nextSource, value: nextValue, history },
          },
        }
      })
    },
    [],
  )

  const lock = useCallback((fieldKey: string, locked: boolean) => {
    setState((prev) => {
      const entry = prev.fields[fieldKey]
      if (!entry) {
        return {
          fields: {
            ...prev.fields,
            [fieldKey]: { source: 'manual', value: '', locked, history: [] },
          },
        }
      }
      return { fields: { ...prev.fields, [fieldKey]: { ...entry, locked } } }
    })
  }, [])

  const undo = useCallback((fieldKey: string): boolean => {
    let didUndo = false
    setState((prev) => {
      const entry = prev.fields[fieldKey]
      if (!entry || entry.history.length === 0) return prev
      const [last, ...rest] = entry.history
      if (!last) return prev
      didUndo = true
      return {
        fields: {
          ...prev.fields,
          [fieldKey]: {
            ...entry,
            source: last.source,
            value: last.value,
            history: rest,
          },
        },
      }
    })
    return didUndo
  }, [])

  const requestDiff = useCallback((pending: PendingDiff) => {
    setPendingDiff(pending)
  }, [])

  // Wrap pending.onConfirm / onCancel so they clear the slot
  // automatically; callers should NOT have to remember to close.
  const enhancedPending = useMemo<PendingDiff | null>(() => {
    if (!pendingDiff) return null
    return {
      ...pendingDiff,
      onConfirm: () => {
        pendingDiff.onConfirm()
        setPendingDiff(null)
      },
      onCancel: () => {
        pendingDiff.onCancel()
        setPendingDiff(null)
      },
    }
  }, [pendingDiff])

  const api = useMemo<ProviderApi>(
    () => ({ read, setValue, applySwitch, lock, undo, requestDiff, pendingDiff: enhancedPending }),
    [read, setValue, applySwitch, lock, undo, requestDiff, enhancedPending],
  )

  return (
    <FieldSourceContext.Provider value={api}>
      {children}
    </FieldSourceContext.Provider>
  )
}

export function useFieldSourceContext(): ProviderApi {
  const ctx = useContext(FieldSourceContext)
  if (!ctx) {
    throw new Error('useFieldSource must be used inside <FieldSourceProvider>')
  }
  return ctx
}
