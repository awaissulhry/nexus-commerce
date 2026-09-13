'use client'

/**
 * PES.2 / F1–F2 — the FAMILY BAR: what this family is, and the verbs that change it.
 *
 * Closes audit row 6.16. The sheet already shows a family AS rows; what it could not say is what
 * the family IS — parent or variation, how many, varying by what — and, for a childless parent,
 * that the empty sheet below is the truth rather than a failure to load.
 *
 * F2 makes the CONTEXT-scoped verbs real. The bar declares none of them: it renders whatever
 * `familyActions` returns at `contextOf('product-family')` and runs them through `runAction`, so
 * the rules that decide whether a verb is offered, what it warns about and how hard it asks are the
 * same here as on every other surface (ruling #110). A verb this file could define would be a verb
 * only this file obeys.
 *
 * The one verb still roadmap — add variation (F4) — stays VISIBLE and disabled, on two rules: a roadmap control stays on screen
 * (feedback_keep_placeholder_controls) and a disabled control must explain itself
 * (reference_disabled_control_cannot_explain). Where the role already forbids a verb, the ROLE's
 * reason wins over "not built yet": an operator on a standalone product should learn that promotion
 * comes first, not that we have not finished something.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { actionLabel, actionsFor, contextOf, isRunnable, type ActionResult, type GridAction } from '@/design-system/grid/actions/registry'
import { useActionPress } from '@/design-system/grid/actions/useActionPress'
import type { SheetStatus } from '@/design-system/grid'
import type { MenuItemDef } from '@/design-system/components'

import { AddVariationDialog } from './AddVariationDialog'
import type { NewVariationDraft } from './addVariation'
import { summariseFamily, type FamilyResponse } from './family'
import type { StudioRow } from './types'

export interface FamilyVerbsOptions {
  family: FamilyResponse | null
  actions: readonly GridAction<StudioRow>[]
  error?: string | null
  onRetry?: () => void
  onDone?: (result: ActionResult) => void
  onCollectVariation?: (draft: NewVariationDraft | null) => void
}

const FAMILY_SCOPE = contextOf('product-family')

/**
 * CH.1 (Owner, 2026-09-05): the family verbs are ITEMS of the sheet's one ⋯ overflow, not a bar of
 * their own — the toolbar renders the same buttons on master as on every channel scope. This hook
 * is the old `FamilyVerbs` bar with its buttons taken away: the same registry read, the same
 * `useActionPress` runner, the same Add-variation collector, handed back as
 *   `items`   — one `MenuItemDef` per `CONTEXT(product-family)` verb, in the registry's declaration
 *               order so the menu never reshuffles; a refused verb is disabled WITH its reason;
 *   `status`  — the transient facts the bar used to show beside the verbs (no variations, a problem);
 *   `dialogs` — the Add-variation dialog and the runner's confirm, which the CALLER must mount, or a
 *               verb that asks would await a dialog that never renders and hang silently.
 * The verbs also stay where the registry already renders them: the row menu and the ⋯ column.
 */
export function useFamilyVerbs({ family, actions, error, onRetry, onDone, onCollectVariation }: FamilyVerbsOptions): {
  items: MenuItemDef[]
  /** Facts only; the engine owns their existing width compaction. */
  status: readonly SheetStatus[]
  dialogs: ReactNode
} {
  const summary = summariseFamily(family)
  const [collecting, setCollecting] = useState(false)
  const runWhenReady = useRef(false)
  const { press, busy, problem, confirmElement } = useActionPress<StudioRow>(onDone)
  const pressOrCollect = useCallback(
    (action: GridAction<StudioRow>) => {
      // Add variation COLLECTS first (the dialog), then runs once the draft is in the context.
      if (action.id === 'add-variation') { setCollecting(true); return }
      void press(action, [])
    },
    [press],
  )
  const addVariation = actions.find((a) => a.id === 'add-variation')
  useEffect(() => {
    if (!runWhenReady.current || !addVariation) return
    runWhenReady.current = false
    void press(addVariation, [])
  }, [addVariation, press])

  const items = useMemo<MenuItemDef[]>(() => {
    if (error) {
      return [{ id: 'family-error', label: 'Could not load the family — try again', description: error, disabled: !onRetry, onSelect: onRetry }]
    }
    return actionsFor(actions, FAMILY_SCOPE, []).map(({ action, availability }) => {
      const runnable = isRunnable(availability)
      return {
        id: action.id,
        label: busy === action.id ? `${actionLabel(action, [])} …` : actionLabel(action, []),
        disabled: !runnable || busy !== null,
        ...(availability.kind === 'disabled' ? { description: availability.reason } : {}),
        onSelect: () => pressOrCollect(action),
      }
    })
  }, [actions, error, onRetry, busy, pressOrCollect])

  const status: SheetStatus[] = []
  if (summary.childless) status.push({
    tone: 'warning', label: 'no children',
    detail: 'This parent has no children yet. Add a child or attach an existing standalone product to grow the family.',
  })
  if (problem) status.push({ tone: 'danger', label: problem })

  const dialogs = (
    <>
      <AddVariationDialog
        open={collecting}
        family={family}
        onCancel={() => { setCollecting(false); onCollectVariation?.(null) }}
        onCollected={(draft) => { setCollecting(false); runWhenReady.current = true; onCollectVariation?.(draft) }}
      />
      {confirmElement}
    </>
  )

  return { items, status, dialogs }
}

export function familySummaryOf(family: FamilyResponse | null, loading?: boolean) {
  const s = summariseFamily(family)
  return loading && !family ? { ...s, role: 'Family' } : s
}
