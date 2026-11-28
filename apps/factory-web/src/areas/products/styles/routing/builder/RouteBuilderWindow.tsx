'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import type { DepartmentAnswer } from '../../../../../lib/department/model'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { RouteParty } from '../route/api'
import { deptLooksOf, totalMinutesOf, type Words } from '../route/model'
import { createTemplate, readCustomers, readRouteSources, readTemplates, setTemplateOpen, type RouteSource, type RouteTemplate } from './api'
import {
  addStep,
  builderProblems,
  copyOptionsOf,
  copyStepsOf,
  copySteps,
  kindOfLooks,
  moveStep,
  paletteOf,
  refusalOf,
  removeStep,
  reorderSteps,
  saveHeldOf,
  setForWhom,
  setMinutes,
  setName,
  setReason,
  startBuilder,
  stepRowsOf,
  stepsOut,
  templateHeldOf,
  endIndexFor,
  type BuilderMode,
  type BuilderState,
  type StartStep,
} from './model'
import { RouteBuilder, type BuilderViewModel } from './view/RouteBuilder'

/**
 * owb-pd6 step 6.2 (S4) — the route builder's container: the route being built (pure, ./model.ts), the ready-made routes and the routes
 * of other products for "Start from a copy", the customers a new route may be only for, "Save as ready-made…" and closing / opening a
 * ready-made route. The host decides who may open it (only product.routing.manage: route/model.ts routeEditHeld, the line's
 * `may.exception`) and saves it with its own call per mode (`onSave` answers a refusal in words, or null when saved: the host closes
 * the window). Used by the Route tab (product, model / customer, new) and by the order's "Route of each line" (line).
 */

/** How the builder opens: its mode, the steps it starts from, and a model / customer route's name and who it is for. */
export interface BuilderOpen {
  readonly mode: BuilderMode
  /** The product (or the order line) and which route, for the window's second line. */
  readonly subtitle: string
  readonly start: readonly StartStep[]
  /** The start steps count as added in this window (a new route: a closed department may not come in). */
  readonly fresh?: boolean
  readonly name?: string
  readonly forWhom?: 'MODEL' | 'CUSTOMER'
  readonly partyId?: string | null
}

export interface RouteBuilderWindowProps {
  readonly api: ApiClient
  readonly open: BuilderOpen
  /** The factory's departments (lib/department rows, closed ones too). */
  readonly departments: readonly DepartmentAnswer[]
  /** The customer the product is made for: a route may be only for that one; null: any active customer of the company. */
  readonly fixedParty?: RouteParty | null
  /** The company whose customers are offered. */
  readonly companyId?: string | null
  /** Saves with the host's call; answers the refusal in words, or null when saved. */
  readonly onSave: (state: BuilderState) => Promise<Words | null>
  readonly onClose: () => void
}

type Loaded<T> = { readonly state: 'idle' | 'reading' | 'ready' | 'failed'; readonly list: readonly T[] }

export function RouteBuilderWindow({ api, open, departments, fixedParty = null, companyId = null, onSave, onClose }: RouteBuilderWindowProps) {
  const locale = useLocale()
  const looks = useMemo(() => deptLooksOf(departments, locale), [departments, locale])
  const kindOf = useMemo(() => kindOfLooks(looks), [looks])
  const [state, setState] = useState<BuilderState>(() => startBuilder(open.mode, open.start, { fresh: open.fresh, name: open.name, forWhom: open.forWhom, partyId: open.partyId ?? fixedParty?.id ?? null }))
  const [templates, setTemplates] = useState<Loaded<RouteTemplate>>({ state: 'reading', list: [] })
  const [templatesRound, setTemplatesRound] = useState(0)
  const [query, setQuery] = useState('')
  const [sources, setSources] = useState<Loaded<RouteSource>>({ state: 'reading', list: [] })
  const [customers, setCustomers] = useState<Loaded<RouteParty>>({ state: 'idle', list: [] })
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<Words | null>(null)
  const [templateName, setTemplateName] = useState('')
  const [templateBusy, setTemplateBusy] = useState(false)
  const [templateProblem, setTemplateProblem] = useState<Words | null>(null)
  const [templateDone, setTemplateDone] = useState<string | null>(null)
  const routeMode = state.mode === 'new' || state.mode === 'route'

  // The ready-made routes, open and closed (again after one is saved, closed or opened).
  useEffect(() => {
    const control = new AbortController()
    readTemplates(api, control.signal).then(
      (list) => setTemplates({ state: 'ready', list }),
      () => {
        if (!control.signal.aborted) setTemplates((current) => ({ state: 'failed', list: current.list }))
      },
    )
    return () => control.abort()
  }, [api, templatesRound])

  // The routes of other products: the first 50 at once, then as the person types (a quarter second after the last key).
  useEffect(() => {
    const control = new AbortController()
    const timer = setTimeout(
      () =>
        readRouteSources(api, query, control.signal).then(
          (list) => setSources({ state: 'ready', list }),
          () => {
            if (!control.signal.aborted) setSources((current) => ({ state: 'failed', list: current.list }))
          },
        ),
      query ? 250 : 0,
    )
    return () => {
      clearTimeout(timer)
      control.abort()
    }
  }, [api, query])

  // The customers, once, when a route only for one customer is chosen and the product is not made for one already.
  const wantCustomers = routeMode && state.forWhom === 'CUSTOMER' && !fixedParty && customers.state === 'idle'
  useEffect(() => {
    if (!wantCustomers) return
    const control = new AbortController()
    setCustomers({ state: 'reading', list: [] })
    readCustomers(api, companyId, control.signal).then(
      (list) => setCustomers({ state: 'ready', list }),
      () => {
        if (!control.signal.aborted) setCustomers({ state: 'failed', list: [] })
      },
    )
    return () => control.abort()
  }, [api, companyId, wantCustomers])

  const change = (next: (current: BuilderState) => BuilderState) => {
    setState(next)
    setProblem(null)
  }

  const save = async () => {
    if (saveHeldOf(state, looks, saving)) return
    setSaving(true)
    setProblem(null)
    try {
      const refused = await onSave(state)
      if (refused) setProblem(refused)
    } finally {
      setSaving(false)
    }
  }

  const saveTemplate = async () => {
    if (templateHeldOf(state, templateName, templates.list, looks, templateBusy)) return
    setTemplateBusy(true)
    setTemplateProblem(null)
    setTemplateDone(null)
    try {
      await createTemplate(api, { name: templateName.trim(), steps: stepsOut(state) })
      setTemplateDone(templateName.trim())
      setTemplateName('')
      setTemplatesRound((round) => round + 1)
    } catch (error) {
      setTemplateProblem(refusalOf(error))
    } finally {
      setTemplateBusy(false)
    }
  }

  const templateOpen = async (templateId: string, open: boolean) => {
    const entry = templates.list.find((each) => each.id === templateId)
    if (!entry || templateBusy) return
    setTemplateBusy(true)
    setTemplateProblem(null)
    try {
      await setTemplateOpen(api, entry, open)
      setTemplatesRound((round) => round + 1)
    } catch (error) {
      setTemplateProblem(refusalOf(error))
    } finally {
      setTemplateBusy(false)
    }
  }

  const problems = builderProblems(state, looks)
  const steps = stepRowsOf(state, looks)
  const options = copyOptionsOf(templates.list, sources.list)
  const model: BuilderViewModel = {
    mode: state.mode,
    subtitle: open.subtitle,
    palette: paletteOf(state, looks, new Set()),
    steps,
    total: totalMinutesOf(state.steps.map((step) => ({ minutes: step.minutes.replace(',', '.') }))),
    errors: problems.errors.map((issue) => issue.words),
    notes: problems.notes.map((issue) => issue.words),
    copy: {
      state: templates.state === 'failed' && sources.state === 'failed' ? 'failed' : templates.state === 'reading' || sources.state === 'reading' ? 'reading' : 'ready',
      templates: options.templates,
      products: options.products,
      query,
    },
    route: routeMode ? { name: state.name, forWhom: state.forWhom, partyId: state.partyId, fixedParty, customers } : null,
    line: state.mode === 'line' ? { reason: state.reason } : null,
    template:
      state.mode === 'line'
        ? null
        : {
            name: templateName,
            held: templateHeldOf(state, templateName, templates.list, looks, templateBusy),
            open: templates.list.filter((entry) => entry.status === 'OPEN'),
            closed: templates.list.filter((entry) => entry.status === 'CLOSED'),
            busy: templateBusy,
            problem: templateProblem,
            done: templateDone,
          },
    save: { held: saveHeldOf(state, looks, saving), busy: saving, problem },
  }

  return (
    <RouteBuilder
      model={model}
      actions={{
        onAdd: (departmentId) => change((current) => addStep(current, departmentId, kindOf)),
        onDrop: (departmentId, at) => change((current) => addStep(current, departmentId, kindOf, at === 'end' ? endIndexFor(current, departmentId, kindOf) : at)),
        onReorder: (keys) => change((current) => reorderSteps(current, keys)),
        onMove: (from, to) => change((current) => moveStep(current, from, to)),
        onRemove: (index) => change((current) => removeStep(current, index)),
        onMinutes: (index, text) => change((current) => setMinutes(current, index, text)),
        onCopy: (value) => {
          const copied = copyStepsOf(value, templates.list, sources.list)
          if (copied) change((current) => copySteps(current, copied))
        },
        onQuery: setQuery,
        onName: (text) => change((current) => setName(current, text)),
        onForWhom: (forWhom) => change((current) => setForWhom(current, forWhom, forWhom === 'CUSTOMER' ? (fixedParty?.id ?? current.partyId) : null)),
        onParty: (partyId) => change((current) => setForWhom(current, 'CUSTOMER', partyId)),
        onReason: (text) => change((current) => setReason(current, text)),
        onTemplateName: (text) => {
          setTemplateName(text)
          setTemplateDone(null)
        },
        onSaveTemplate: () => void saveTemplate(),
        onTemplateOpen: (templateId, open) => void templateOpen(templateId, open),
        onSave: () => void save(),
        onClose,
      }}
    />
  )
}
