'use client'

// EC.2.2 — useFieldSource consumer hook.
//
// Card-facing facade over the FieldSourceProvider. Each consumer (a
// Title input, an Aspects card, the Pricing card) calls
// useFieldSource(fieldKey, ...) and gets back the current state plus
// an action API that handles the diff modal + resolver invocation
// internally.
//
// The resolver contract is intentionally tiny — cards know best how
// to compute values for each source (master comes from a prop the
// card receives, AI comes from an endpoint the card knows about,
// sibling comes from a list the card can iterate). The hook owns
// the state machine; the card owns the data plumbing.

import { useCallback, useMemo } from 'react'
import { useFieldSourceContext } from './FieldSourceProvider'
import type { FieldSource, FieldSourceState, ResolveValue } from './types'

interface Options {
  /** Human-readable field label for diff-modal title + screenreader. */
  label: string
  /** Initial source + value used the first time this field is read
   *  (before the operator has touched it). Typically derived from
   *  the listing → master fallback in useEbayCompositor. */
  initial: { source: FieldSource; value: string }
  /** Compute the value for a candidate source. Return null if the
   *  card has no way to resolve that source for this field. */
  resolveValue: ResolveValue
}

interface Api {
  state: FieldSourceState
  /** True if a value exists (non-empty string). */
  hasValue: boolean
  /** True if the value was authored by the operator (vs auto-bound). */
  isManual: boolean
  /** True if at least one history entry exists. */
  canUndo: boolean
  /** Set the displayed value. If current source !== 'manual', flips
   *  to 'manual' automatically (typing implicitly takes ownership). */
  setValue(next: string): void
  /** Begin a source switch. Invokes resolveValue, shows diff modal,
   *  and only applies on confirm. No-op if locked + nextSource !==
   *  current. */
  switchSource(nextSource: FieldSource): Promise<void>
  lock(): void
  unlock(): void
  /** Pop the most recent history entry back onto the field. */
  undo(): boolean
}

export function useFieldSource(fieldKey: string, options: Options): Api {
  const ctx = useFieldSourceContext()
  const state = ctx.read(fieldKey, options.initial)

  const setValue = useCallback(
    (next: string) => ctx.setValue(fieldKey, next),
    [ctx, fieldKey],
  )

  const switchSource = useCallback(
    async (nextSource: FieldSource) => {
      if (state.locked && nextSource !== state.source) {
        // Locked fields refuse source switches. UI should surface a
        // hint; we silently no-op rather than throw to keep callsites
        // simple.
        return
      }
      if (nextSource === state.source) return
      const resolved = await Promise.resolve(options.resolveValue(nextSource))
      const nextValue = resolved ?? ''
      // No diff needed if values are identical — apply silently.
      if (nextValue === state.value) {
        ctx.applySwitch(fieldKey, nextSource, nextValue)
        return
      }
      ctx.requestDiff({
        fieldKey,
        fieldLabel: options.label,
        fromSource: state.source,
        toSource: nextSource,
        currentValue: state.value,
        nextValue,
        loading: false,
        error: null,
        onConfirm: () => ctx.applySwitch(fieldKey, nextSource, nextValue),
        onCancel: () => {/* no-op — provider closes the modal */},
      })
    },
    [ctx, fieldKey, options, state.locked, state.source, state.value],
  )

  const lock = useCallback(() => ctx.lock(fieldKey, true), [ctx, fieldKey])
  const unlock = useCallback(() => ctx.lock(fieldKey, false), [ctx, fieldKey])
  const undo = useCallback(() => ctx.undo(fieldKey), [ctx, fieldKey])

  return useMemo<Api>(
    () => ({
      state,
      hasValue: state.value.length > 0,
      isManual: state.source === 'manual',
      canUndo: state.history.length > 0,
      setValue,
      switchSource,
      lock,
      unlock,
      undo,
    }),
    [state, setValue, switchSource, lock, unlock, undo],
  )
}
