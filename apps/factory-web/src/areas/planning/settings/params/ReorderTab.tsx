'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ItemPlanningPatch } from '@nexus/factory-domain/planning/settings/items'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../../../_shared/buying/hooks'
import { createItemParameters, editItemParameters, listItemParameters, listReorderRules, type ItemEntry, type ItemParameters } from '../api'
import { readProblem, type TabHost } from '../model'
import { useEchoes, useMarks, useRowQueue } from './hooks'
import { bulkResult, clearedWords, isReorderMethod, parseCell, planPatch, refusalWords, rowKeyOf, ruleTarget, type Notice, type QtyField, type Words } from './model'
import { ReorderView, type ReorderModel, type RuleSearch } from './view/ReorderView'

const keyOf = (rule: Pick<ItemParameters, 'item' | 'colour'>) => rowKeyOf(rule.item.id, rule.colour?.id ?? null)
const nameOf = (rule: Pick<ItemParameters, 'item' | 'colour'>) => (rule.colour ? `${rule.item.code} · ${rule.colour.name}` : rule.item.code)

/**
 * Planning settings › Reorder rules (SCR-127, design sec:reorder): reads the site's rules (`GET /planning/reorder-rules`,
 * REORDER_POINT and MIN_MAX rows; the site is the warehouse), saves each cell on its own at the version read (a rule's
 * writes wait for each other), switches a rule's method with its two values, adds a rule from an item search (an item
 * that already has a row for that colour has it changed), and plans the selected from orders again. Live
 * `planning.item_parameters_changed` of this site from someone else → "Changed by someone else · Reload".
 */
export function ReorderTab({ host }: { host: TabHost }) {
  const api = useOfficeApi()
  const site = host.site
  const [load, setLoad] = useState<ReorderModel['load']>({ status: 'loading' })
  const [rules, setRules] = useState<ItemParameters[] | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState<RuleSearch>({ status: 'idle', items: [] })
  const { marks, setMark, fade, failedCount } = useMarks()
  const queue = useRowQueue()
  const echoes = useEchoes()
  const rulesRef = useRef<ItemParameters[] | null>(null)
  rulesRef.current = rules
  const onStatus = host.onStatus

  const read = useCallback(async () => {
    try {
      const answer = await listReorderRules(api, site.id)
      setRules(answer.rules)
      setLoad({ status: 'ready' })
      setChangedElsewhere(false)
    } catch (error) {
      setRules(null)
      setLoad({ status: 'error', problem: readProblem(error) })
    }
  }, [api, site.id])
  useEffect(() => {
    void read()
  }, [read])

  useLive(
    (change) => {
      if (change.type !== 'planning.item_parameters_changed' || change.fields.siteId !== site.id) return
      if (echoes.isOurs(rowKeyOf(String(change.fields.itemId), change.fields.itemColourId ? String(change.fields.itemColourId) : null))) return
      setChangedElsewhere(true)
    },
    () => void read(),
  )

  /** The rules with one put in (still a reorder rule) or taken out (planned from orders now). */
  const put = (row: ItemParameters) =>
    setRules((current) => {
      if (!current) return current
      const others = current.filter((rule) => rule.id !== row.id)
      if (!isReorderMethod(row.method)) return others
      return [...others, row].sort((a, b) => a.item.code.localeCompare(b.item.code) || (a.colour?.code ?? '').localeCompare(b.colour?.code ?? ''))
    })

  const edit = (id: string, patch: ItemPlanningPatch): Promise<{ ok: true; row: ItemParameters; cleared: string[] } | { ok: false; words: Words; unknown: boolean }> =>
    queue(id, async () => {
      const rule = rulesRef.current?.find((entry) => entry.id === id)
      if (!rule) return { ok: false as const, words: { key: 'ps.problem.gone' }, unknown: false }
      const plan = planPatch(rule, patch)
      if (plan.kind === 'refused') return { ok: false as const, words: plan.words, unknown: false }
      if (plan.kind === 'none') return { ok: true as const, row: rule, cleared: [] }
      echoes.expect(keyOf(rule))
      try {
        const answer = await editItemParameters(api, rule.id, { ...plan.patch, version: rule.version }, newIdempotencyKey())
        put(answer.parameters)
        return { ok: true as const, row: answer.parameters, cleared: answer.cleared }
      } catch (error) {
        const refusal = refusalWords(error)
        if (refusal.conflict) setChangedElsewhere(true)
        return { ok: false as const, words: refusal.words, unknown: refusal.unknown }
      }
    })

  const saveCell = (rule: ItemParameters, field: QtyField | 'method', patch: ItemPlanningPatch) => {
    const plan = planPatch(rulesRef.current?.find((entry) => entry.id === rule.id) ?? rule, patch)
    if (plan.kind === 'none') return
    if (plan.kind === 'refused') {
      setMark(rule.id, field, { state: 'refused', problem: plan.words })
      return
    }
    setMark(rule.id, field, { state: 'saving' })
    onStatus({ kind: 'saving' })
    void edit(rule.id, patch).then((outcome) => {
      if (outcome.ok) {
        setMark(rule.id, field, { state: 'saved' })
        fade(rule.id, field)
        onStatus({ kind: 'saved', at: new Date().toISOString() })
        const cleared = clearedWords(outcome.cleared)
        if (cleared) setNotice({ tone: 'info', words: cleared })
      } else {
        setMark(rule.id, field, { state: outcome.unknown ? 'unknown' : 'refused', problem: outcome.words })
        onStatus({ kind: 'failed', count: failedCount + 1 })
      }
    })
  }

  const model: ReorderModel = { site, can: host.can, load, rules, marks, notice, changedElsewhere, busy, search }

  return (
    <ReorderView
      model={model}
      actions={{
        onRetry: () => {
          setLoad({ status: 'loading' })
          void read()
        },
        onReload: () => void read(),
        onCell: (rule, field, raw) => {
          const parsed = parseCell(field, raw)
          if ('problem' in parsed) {
            setMark(rule.id, field, { state: 'refused', problem: parsed.problem })
            return
          }
          saveCell(rule, field, { [field]: parsed.value } as ItemPlanningPatch)
        },
        onMethod: (rule, patch) => saveCell(rule, 'method', patch as ItemPlanningPatch),
        onSearch: (query) => {
          setSearch((current) => ({ status: 'loading', items: current.items }))
          listItemParameters(api, { siteId: site.id, q: query, limit: 20 })
            .then((page) => setSearch({ status: 'ready', items: page.items }))
            .catch(() => setSearch({ status: 'error', items: [] }))
        },
        onRule: async (entry: ItemEntry, colourId, patch) => {
          setNotice(null)
          const target = ruleTarget(entry, colourId) ?? rulesRef.current?.find((rule) => rule.item.id === entry.item.id && (rule.colour?.id ?? null) === colourId) ?? null
          const key = rowKeyOf(entry.item.id, colourId)
          echoes.expect(key)
          onStatus({ kind: 'saving' })
          try {
            const answer = target
              ? await editItemParameters(api, target.id, { ...(patch as ItemPlanningPatch), version: target.version }, newIdempotencyKey())
              : await createItemParameters(api, { siteId: site.id, itemId: entry.item.id, itemColourId: colourId, ...(patch as ItemPlanningPatch) }, newIdempotencyKey())
            put(answer.parameters)
            setNotice({ tone: 'success', words: { key: target ? 'pp.rule.changed' : 'pp.rule.added', params: { item: nameOf(answer.parameters) } } })
            onStatus({ kind: 'saved', at: new Date().toISOString() })
            return true
          } catch (error) {
            const refusal = refusalWords(error)
            if (refusal.conflict) setChangedElsewhere(true)
            setNotice({ tone: 'danger', words: refusal.words })
            onStatus({ kind: 'failed', count: 1 })
            return false
          }
        },
        onOrders: async (picked) => {
          setBusy(true)
          setNotice(null)
          let saved = 0
          const refused: { name: string; words: Words }[] = []
          for (const rule of picked) {
            const outcome = await edit(rule.id, { method: 'ORDERS' })
            if (outcome.ok) saved += 1
            else refused.push({ name: nameOf(rule), words: outcome.words })
          }
          setBusy(false)
          setNotice(refused.length === 0 ? { tone: 'success', words: { key: 'pp.reorder.toOrdersDone', params: { count: saved } } } : bulkResult(saved, refused))
          if (saved > 0) onStatus({ kind: 'saved', at: new Date().toISOString() })
          return true
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
