'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveChanges } from '../../../../record-panels/live'
import { getScale, listScales } from '../api'
import { createRule, getRule, listPoms, listRules, saveRuleSteps, setRuleStatus, updateRule, type RuleRow, type RuleView } from './api'
import { csvOf, depthProblem, readProblemOf, statusQuery, stepsOf, type DepthFilters, type RuleDraft, type StepRow } from './model'
import type { RuleFields } from './view/GradeRuleDialog'
import type { OpenRule, RuleDialog, RulesActions, RulesViewModel } from './view/RulesView'

/**
 * Sizes › Grade rules' container hook (B-W2b-240 on B-W2b-224's API): the rules as the address filters them (live
 * `grade_rule.changed` behind "N updates · Show"), the scales for the filter and New grade rule (a picked scale's sizes
 * read for the base size), the Grade rule pop-up of `?open=<id>` (the rule with its steps, the garment points it may add;
 * Save = the fields at the rule's version, then every step at the version that answered), the selection archived or
 * restored in one write.
 */
export function useRules({
  api,
  filters,
  enabled,
  openId,
  onOpen,
  words,
}: {
  api: ApiClient
  filters: DepthFilters
  enabled: boolean
  openId: string | null
  onOpen: (id: string | null) => void
  words: { csvHeader: string[]; format: (format: string) => string; status: (status: string) => string }
}): { model: Omit<RulesViewModel, 'prefix' | 'can' | 'filters' | 'companies' | 'companyId'>; actions: Omit<RulesActions, 'onFilters'> } {
  const [rows, setRows] = useState<RulesViewModel['rows']>({ items: null, more: false, count: null, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [scales, setScales] = useState<RulesViewModel['scales']>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<RulesViewModel['notice']>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<RuleDialog | null>(null)
  const [newRule, setNewRule] = useState<RulesViewModel['newRule']>(null)
  const [open, setOpen] = useState<OpenRule | null>(null)
  const [points, setPoints] = useState<OpenRule['points']>(null)
  const seq = useRef(0)
  const items = useRef<RuleRow[]>([])
  items.current = rows.items ?? []
  const writing = useRef(0)

  const load = useCallback(async () => {
    if (!enabled) return
    const mine = ++seq.current
    setRows((current) => ({ ...current, items: null, problem: null }))
    try {
      const page = await listRules(api, { q: filters.q, scaleId: filters.scaleId ?? undefined, status: statusQuery(filters.status) })
      if (mine !== seq.current) return
      setRows({ items: page.rules, more: page.nextCursor !== null, count: page.count, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (mine === seq.current) setRows({ items: null, more: false, count: null, problem: readProblemOf(error) })
    }
  }, [api, enabled, filters.q, filters.scaleId, filters.status])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!enabled || scales !== null) return
    listScales(api, { status: 'ACTIVE', limit: 200 })
      .then((page) => setScales(page.scales.map((scale) => ({ id: scale.id, code: scale.code, name: scale.name }))))
      .catch(() => setScales([]))
  }, [api, enabled])

  const readRule = useCallback(
    (id: string) => {
      setOpen((current) => ({ id, rule: current?.id === id && current.rule.status === 'ready' ? current.rule : { status: 'loading' }, busy: false, refused: null, points: null }))
      getRule(api, id)
        .then((rule) => setOpen((current) => (current?.id === id ? { ...current, rule: { status: 'ready', value: rule } } : current)))
        .catch((error: unknown) => setOpen((current) => (current?.id === id ? { ...current, rule: { status: 'error', problem: readProblemOf(error) } } : current)))
    },
    [api],
  )

  useEffect(() => {
    if (!enabled || !openId) {
      setOpen(null)
      return
    }
    readRule(openId)
    if (points === null)
      listPoms(api, { kind: 'GARMENT', status: 'ACTIVE', limit: 200 })
        .then((page) => setPoints(page.points.map((point) => ({ id: point.id, code: point.code, name: point.name, uom: point.uom }))))
        .catch(() => setPoints([]))
  }, [enabled, openId, readRule])

  useLiveChanges(
    {
      onChange: (change) => {
        if (change.type !== 'grade_rule.changed' || writing.current > 0) return
        setUpdates((count) => count + 1)
      },
      onReconnect: () => setUpdates((count) => count + 1),
    },
    enabled,
  )

  const replace = (rule: RuleRow) => setRows((current) => ({ ...current, items: current.items ? current.items.map((row) => (row.id === rule.id ? { ...row, ...rule } : row)) : current.items }))

  const actions: Omit<RulesActions, 'onFilters'> = {
    onRetry: () => void load(),
    onShowUpdates: () => void load(),
    onMore: () => {
      if (!cursor) return
      listRules(api, { q: filters.q, scaleId: filters.scaleId ?? undefined, status: statusQuery(filters.status), cursor })
        .then((page) => {
          setRows((current) => ({ items: [...(current.items ?? []), ...page.rules], more: page.nextCursor !== null, count: page.count, problem: null }))
          setCursor(page.nextCursor)
        })
        .catch((error: unknown) => setNotice({ key: readProblemOf(error), tone: 'danger' }))
    },
    onDialog: (next) => {
      setDialog(next)
      setNewRule(next?.kind === 'new' ? { sizes: null, busy: false, refused: null } : null)
    },
    onOpen,
    onReadRule: () => openId && readRule(openId),
    onScale: (scaleId) => {
      setNewRule((current) => (current ? { ...current, sizes: null } : current))
      getScale(api, scaleId)
        .then((scale) => setNewRule((current) => (current ? { ...current, sizes: [...scale.sizes].sort((a, b) => a.seq - b.seq).map((size) => ({ code: size.code, label: size.label, fitCode: size.fitCode ?? null, status: size.status })) } : current)))
        .catch(() => setNewRule((current) => (current ? { ...current, sizes: [] } : current)))
    },
    onCreate: async (draft: RuleDraft) => {
      setNewRule((current) => (current ? { ...current, busy: true, refused: null } : current))
      writing.current++
      try {
        const rule = await createRule(api, { companyId: draft.companyId, code: draft.code.trim().toUpperCase(), name: draft.name.trim(), sizeScaleId: draft.scaleId, baseSize: draft.baseSize, format: draft.format, steps: [] })
        setDialog(null)
        setNewRule(null)
        setNotice({ key: 'rules.notice.created', tone: 'success', params: { code: rule.code } })
        void load()
        onOpen(rule.id)
        return true
      } catch (error) {
        setNewRule((current) => (current ? { ...current, busy: false, refused: depthProblem(error) } : current))
        return false
      } finally {
        writing.current--
      }
    },
    onSaveRule: async (rule: RuleView, fields: RuleFields, stepRows: StepRow[]) => {
      setOpen((current) => (current ? { ...current, busy: true, refused: null } : current))
      writing.current++
      try {
        let saved = rule
        const fieldsChanged = fields.name.trim() !== rule.name || fields.baseSize !== rule.baseSize || fields.format !== rule.format
        const steps = stepsOf(stepRows)
        // The API checks every step against the rule's base and format: an absolute rule's steps start at its base. So a
        // rule that becomes absolute (or moves its base) takes its new steps while it counts relatively (any step is a
        // relative step), then its new base and format; any other change sends the fields, then the steps.
        const toAbsolute = fieldsChanged && fields.format === 'ABSOLUTE' && (rule.format !== 'ABSOLUTE' || rule.baseSize !== fields.baseSize)
        if (toAbsolute) {
          if (rule.format === 'ABSOLUTE') saved = await updateRule(api, saved, { format: 'RELATIVE' })
          saved = await saveRuleSteps(api, saved, steps)
          saved = await updateRule(api, saved, { name: fields.name.trim(), baseSize: fields.baseSize, format: 'ABSOLUTE' })
        } else {
          if (fieldsChanged) saved = await updateRule(api, saved, { name: fields.name.trim(), baseSize: fields.baseSize, format: fields.format })
          saved = await saveRuleSteps(api, saved, steps)
        }
        replace(saved)
        setOpen((current) => (current ? { ...current, busy: false, rule: { status: 'ready', value: saved } } : current))
        setNotice({ key: 'rules.notice.saved', tone: 'success', params: { code: saved.code } })
        return true
      } catch (error) {
        const problem = depthProblem(error)
        setOpen((current) => (current ? { ...current, busy: false, refused: problem } : current))
        return false
      } finally {
        writing.current--
      }
    },
    onStatus: async (ids, to) => {
      const picked = items.current.filter((row) => ids.includes(row.id))
      if (picked.length === 0) return false
      setBusy(true)
      writing.current++
      try {
        const done = await setRuleStatus(api, picked, to)
        for (const rule of done) replace(rule)
        setNotice({ key: to === 'ARCHIVED' ? 'rules.notice.archived' : 'rules.notice.restored', tone: 'success', params: { count: done.length } })
        setDialog(null)
        void load()
        return true
      } catch (error) {
        const problem = depthProblem(error)
        setNotice({ key: problem.key, tone: 'danger' })
        if (problem.reload) void load()
        return false
      } finally {
        setBusy(false)
        writing.current--
      }
    },
    onExport: (ids) => {
      const picked = items.current.filter((row) => ids.includes(row.id))
      const csv = csvOf([words.csvHeader, ...picked.map((row) => [row.code, row.name, row.scale.code, row.baseSize, row.points, row.steps, words.format(row.format), row.specs, words.status(row.status)])])
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `grade-rules-${new Date().toISOString().slice(0, 10)}.csv`
      link.click()
      URL.revokeObjectURL(link.href)
    },
    onDismissNotice: () => setNotice(null),
  }

  return { model: { rows, scales, asOf, updates, notice, busy, dialog, newRule, open: open ? { ...open, points } : null }, actions }
}
