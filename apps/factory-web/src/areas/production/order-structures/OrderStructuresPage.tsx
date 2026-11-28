'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOfficeApi } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { getProductionCustomers } from '../_shared/customer/use-customers'
import { getTeamsBoard } from '../teams/api'
import { closeRule, closeStructure, createStructure, getRules, getStructures, officePeople, orderRules, patchStructure, tryOrder, type RulesRead, type StructureRow, type StructuresRead, type TryAnswer } from './api'
import {
  aboveIds,
  moveRuleIds,
  newStructureDraftOf,
  ORDER_STRUCTURES_NS,
  problemKeyOf,
  rulesOf,
  structureBodyOf,
  structureDraftOf,
  structureHeldOf,
  togglePerson,
  toggleTeam,
  type StructureDraft,
  type Words,
} from './model'
import { useRuleWindow } from './use-rule-window'
import { OrderStructuresView } from './view/OrderStructuresView'
import { RuleWindow, StructureWindow } from './view/Windows'

/**
 * `/w/<company>/production/order-structures` (owb-ss8 8.3; design § 5zj C; prototype rules.js) — the page's container: reads the
 * structures and the rules (owb-ss6), the customers for Try and a rule, and — when a structure window opens — the teams (the board's)
 * and the office people. Arrows and "Move it up" send the whole new order (PUT …/order); Try asks the API (POST …/try) on every change.
 * Every change reads both lists again.
 */
export function OrderStructuresPage() {
  return (
    <WithMessages namespaces={[ORDER_STRUCTURES_NS]}>
      <OrderStructuresContainer />
    </WithMessages>
  )
}

function OrderStructuresContainer() {
  const api = useOfficeApi()
  const scope = useOfficeScope()
  const [structures, setStructures] = useState<{ value: StructuresRead | null; problem: string | null }>({ value: null, problem: null })
  const [rules, setRules] = useState<{ value: RulesRead | null; problem: string | null }>({ value: null, problem: null })
  const [customers, setCustomers] = useState<readonly { id: string; name: string }[] | null>(null)
  const [notice, setNotice] = useState<Words | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const readId = useRef(0)

  const load = useCallback(() => {
    const id = ++readId.current
    getStructures(api)
      .then((value) => id === readId.current && setStructures({ value, problem: null }))
      .catch((error: unknown) => id === readId.current && setStructures({ value: null, problem: problemKeyOf(error, false) }))
    getRules(api)
      .then((value) => id === readId.current && setRules({ value, problem: null }))
      .catch((error: unknown) => id === readId.current && setRules({ value: null, problem: problemKeyOf(error, false) }))
  }, [api])
  useEffect(() => load(), [load])
  useEffect(() => {
    getProductionCustomers(api, 'work-orders')
      .then((answer) => setCustomers(answer.customers.map((party) => ({ id: party.id, name: party.name }))))
      .catch(() => setCustomers([]))
  }, [api])

  // ---- Try an order ----
  const [tryTerms, setTryTerms] = useState<{ partyId: string | null; category: string | null }>({ partyId: null, category: null })
  const [tryAnswer, setTryAnswer] = useState<{ value: TryAnswer | null; reading: boolean; problem: string | null }>({ value: null, reading: false, problem: null })
  const tryId = useRef(0)
  const runTry = useCallback(
    (terms: { partyId: string | null; category: string | null }) => {
      const id = ++tryId.current
      setTryAnswer({ value: null, reading: true, problem: null })
      tryOrder(api, terms)
        .then((value) => id === tryId.current && setTryAnswer({ value, reading: false, problem: null }))
        .catch((error: unknown) => id === tryId.current && setTryAnswer({ value: null, reading: false, problem: problemKeyOf(error, false) }))
    },
    [api],
  )
  const setTry = (patch: Partial<{ partyId: string | null; category: string | null }>) => {
    const next = { ...tryTerms, ...patch }
    setTryTerms(next)
    runTry(next)
  }

  // ---- arrows ----
  const order = async (ids: readonly string[] | null, ruleId: string) => {
    if (!ids || moving) return
    setMoving(ruleId)
    try {
      await orderRules(api, ids)
      load()
    } catch (error) {
      setNotice({ key: problemKeyOf(error, true) })
    } finally {
      setMoving(null)
    }
  }
  const open = rulesOf(rules.value?.rules ?? []).open

  // ---- one rule ----
  const ruleWindow = useRuleWindow(api, {
    structures: structures.value?.structures ?? null,
    rules: rules.value?.rules ?? null,
    customers,
    manageStructures: structures.value?.may.manage ?? false,
    onSaved: (done) => {
      setNotice({ key: `notice.rule.${done}` })
      load()
      if (tryAnswer.value) runTry(tryTerms)
    },
  })

  // ---- one structure ----
  const [structureWin, setStructureWin] = useState<{ draft: StructureDraft | null; row: StructureRow | null; busy: boolean; problem: string | null }>({ draft: null, row: null, busy: false, problem: null })
  const [teams, setTeams] = useState<readonly { id: string; name: string; picture: StructureRow['teams'][number]['picture'] }[] | null>(null)
  const [people, setPeople] = useState<readonly { id: string; name: string }[] | null>(null)
  const readChoices = () => {
    if (!teams)
      getTeamsBoard(api, scope.siteId)
        .then((board) => setTeams(board.teams.map((team) => ({ id: team.id, name: team.name, picture: team.picture }))))
        .catch(() => setTeams(null))
    if (!people)
      officePeople(api)
        .then(setPeople)
        .catch(() => setPeople(null))
  }
  const openStructure = (row: StructureRow | null, copy = false) => {
    setStructureWin({ draft: row ? structureDraftOf(row, copy) : newStructureDraftOf(), row: row && !copy ? row : null, busy: false, problem: null })
    if (structures.value?.may.manage) readChoices()
  }
  const setStructure = (next: (draft: StructureDraft) => StructureDraft) => setStructureWin((current) => (current.draft && !current.busy ? { ...current, draft: next(current.draft), problem: null } : current))
  const structureHeld = structureWin.draft ? structureHeldOf(structureWin.draft, structures.value?.structures ?? []) : null
  const saveStructure = async () => {
    const draft = structureWin.draft
    if (!draft || structureWin.busy || structureHeld) return
    setStructureWin((current) => ({ ...current, busy: true, problem: null }))
    try {
      if (draft.id === null) await createStructure(api, structureBodyOf(draft))
      else await patchStructure(api, draft.id, { version: draft.version, ...structureBodyOf(draft) })
      setStructureWin({ draft: null, row: null, busy: false, problem: null })
      setNotice({ key: draft.id === null ? 'notice.structure.added' : 'notice.structure.saved', params: { name: draft.name.trim() } })
      load()
    } catch (error) {
      setStructureWin((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }
  const openClose = async (row: StructureRow, reopen: boolean) => {
    try {
      await closeStructure(api, row.id, reopen)
      setStructureWin({ draft: null, row: null, busy: false, problem: null })
      setNotice({ key: reopen ? 'notice.structure.reopened' : 'notice.structure.closed', params: { name: row.name } })
      load()
    } catch (error) {
      if (structureWin.draft) setStructureWin((current) => ({ ...current, problem: problemKeyOf(error, true) }))
      else setNotice({ key: problemKeyOf(error, true) })
    }
  }
  const reopenRule = async (ruleId: string) => {
    try {
      await closeRule(api, ruleId, true)
      setNotice({ key: 'notice.rule.reopened' })
      load()
    } catch (error) {
      setNotice({ key: problemKeyOf(error, true) })
    }
  }

  const may = { manage: structures.value?.may.manage ?? false, write: rules.value?.may.write ?? false }
  return (
    <>
      <OrderStructuresView
        model={{
          state: structures.value && rules.value ? 'ready' : structures.problem || rules.problem ? 'failed' : 'reading',
          problem: structures.problem ?? rules.problem,
          structures: structures.value?.structures ?? null,
          rules: rules.value,
          may,
          customers,
          tryTerms,
          tryAnswer,
          moving,
          notice,
        }}
        actions={{
          onRetry: load,
          onNewRule: () => ruleWindow.openNew(),
          onEditRule: ruleWindow.openRule,
          onUp: (rule) => void order(moveRuleIds(open, rule.id, -1), rule.id),
          onDown: (rule) => void order(moveRuleIds(open, rule.id, 1), rule.id),
          onAbove: (rule) => rule.deadBecause && void order(aboveIds(open, rule.id, rule.deadBecause.ruleId), rule.id),
          onReopenRule: (rule) => void reopenRule(rule.id),
          onNewStructure: () => openStructure(null),
          onOpenStructure: (row) => openStructure(row),
          onReopenStructure: (row) => void openClose(row, true),
          onTryParty: (partyId) => setTry({ partyId }),
          onTryCategory: (category) => setTry({ category }),
          onDismissNotice: () => setNotice(null),
        }}
      />
      <RuleWindow model={ruleWindow.model} actions={ruleWindow.actions} />
      <StructureWindow
        model={{ open: structureWin.draft !== null, draft: structureWin.draft, row: structureWin.row, teams, people, manage: may.manage, write: may.write, held: structureHeld, busy: structureWin.busy, problem: structureWin.problem }}
        actions={{
          onClose: () => setStructureWin((current) => (current.busy ? current : { draft: null, row: null, busy: false, problem: null })),
          onName: (name) => setStructure((draft) => ({ ...draft, name })),
          onNote: (note) => setStructure((draft) => ({ ...draft, note })),
          onTeam: (teamId) => setStructure((draft) => toggleTeam(draft, teamId)),
          onPerson: (userId) => setStructure((draft) => togglePerson(draft, userId)),
          onSave: () => void saveStructure(),
          onCloseStructure: () => structureWin.row && void openClose(structureWin.row, false),
          onCopy: () => structureWin.row && openStructure(structureWin.row, true),
          onNewRule: () => {
            const row = structureWin.row
            setStructureWin({ draft: null, row: null, busy: false, problem: null })
            if (row) ruleWindow.openNew({ structureId: row.id })
          },
        }}
      />
    </>
  )
}
