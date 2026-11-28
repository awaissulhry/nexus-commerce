'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { getProductionCustomers } from '../../production/_shared/customer/use-customers'
import { applyMoves, createEmployee, setTeamLead } from '../_shared/api'
import { todayIn, TIME_ZONE } from '../_shared/model'
import { problemKeyOf } from '../../production/teams/model'
import {
  applyReadyMade,
  closeUnit,
  createUnit,
  getEmployeeFacts,
  getStructure,
  getUnit,
  mergeUnits,
  moveUnit,
  patchEmployee,
  patchUnit,
  personHistory,
  previewReadyMade,
  unitHistory,
  type EmployeeFacts,
  type HistoryRow,
  type ReadyMade,
  type ReadyMadePreview,
  type Structure,
  type UnitRecord,
} from './api'
import {
  addDraftOf,
  addHeldOf,
  bossOf,
  chainOf,
  closeBlockersOf,
  isAsk,
  keepMerge,
  leaderChanged,
  mergeBodyOf,
  mergeCandidatesOf,
  mergeDraftOf,
  mergeHeldOf,
  mergeLeadersOf,
  mergeMovesOf,
  moveAskOf,
  moveTargetsOf,
  newUnitDraftOf,
  openOrdersOf,
  personBodyOf,
  personDraftOf,
  personHeldOf,
  pickColour,
  pickIcon,
  pickLetters,
  PERSON_TABS,
  STRUCTURE_NS,
  structureHref,
  structureRightsOf,
  tabOf,
  termsOf,
  tickMerge,
  toggleWorksFor,
  treeOf,
  unitBodyOf,
  unitDraftOf,
  unitHeldOf,
  UNIT_TABS,
  withLeader,
  type AddDraft,
  type Drag,
  type MergeDraft,
  type MoveAsk,
  type PersonDraft,
  type UnitDraft,
  type Words,
} from './model'
import { PersonProfileView } from './view/PersonProfileView'
import { StructureView } from './view/StructureView'
import { AddPersonWindow, CloseWindow, MergeWindow, MoveWindow, PersonWindow, ReadyMadeWindow, UnitWindow } from './view/StructureWindows'
import { UnitProfileView } from './view/UnitProfileView'

/**
 * `/w/<company>/people/structure` (owb-ss8 8.1 + 8.2; design § 5zb, § 5zd; prototype org.js) — People › Factory structure's container.
 * One page, three faces by its address (no new route): the chart / list (`?view=chart|list`), a unit's profile (`?unit=<id>&tab=…`) and
 * a person's profile (`?person=<id>&tab=…`). Reads GET /people/structure (owb-ss5), the open unit (GET /people/units/:id) and its
 * history, the open person (today's GET /people/employees/:id) and theirs. Every change is one command, then the structure (and the open
 * profile) is read again. `?new=team` (the Teams page's "New team…") opens "A new unit" as a team.
 */
export function StructurePage() {
  return (
    <WithMessages namespaces={[STRUCTURE_NS]}>
      <StructureContainer />
    </WithMessages>
  )
}

type Read<T> = { readonly value: T | null; readonly problem: string | null }
const EMPTY = { value: null, problem: null }

function StructureContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const path = pathname.replace(/\/$/, '')
  const prefix = path.replace(/\/people\/structure$/, '')
  const terms = useMemo(() => termsOf(params), [params?.toString()])
  const today = todayIn(TIME_ZONE)

  const [structure, setStructure] = useState<Read<Structure>>(EMPTY)
  const [unit, setUnit] = useState<Read<UnitRecord>>(EMPTY)
  const [facts, setFacts] = useState<Read<EmployeeFacts>>(EMPTY)
  const [history, setHistory] = useState<{ rows: readonly HistoryRow[] | null; problem: string | null }>({ rows: null, problem: null })
  const [query, setQuery] = useState('')
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<Words | null>(null)
  const readId = useRef(0)

  const tree = useMemo(() => (structure.value ? treeOf(structure.value.units, structure.value.people) : null), [structure.value])
  const rights = structureRightsOf(session.permissions, structure.value?.may.manage ?? false)
  const peopleRight = rights.manage && session.permissions.includes('people.teams.manage')
  const addPerson = rights.editPerson && peopleRight

  const loadStructure = useCallback(() => {
    const id = ++readId.current
    getStructure(api)
      .then((value) => id === readId.current && setStructure({ value, problem: null }))
      .catch((error: unknown) => id === readId.current && setStructure({ value: null, problem: problemKeyOf(error, false) }))
  }, [api])

  const loadProfile = useCallback(() => {
    if (terms.unit) {
      setUnit((current) => ({ value: current.value?.id === terms.unit ? current.value : null, problem: null }))
      getUnit(api, terms.unit)
        .then((value) => setUnit({ value, problem: null }))
        .catch((error: unknown) => setUnit({ value: null, problem: problemKeyOf(error, false) }))
      if (terms.tab === 'history')
        unitHistory(api, terms.unit)
          .then((rows) => setHistory({ rows, problem: null }))
          .catch((error: unknown) => setHistory({ rows: null, problem: problemKeyOf(error, false) }))
    } else if (terms.person) {
      getEmployeeFacts(api, terms.person)
        .then((value) => setFacts({ value, problem: null }))
        .catch((error: unknown) => setFacts({ value: null, problem: problemKeyOf(error, false) }))
      if (terms.tab === 'history')
        personHistory(api, terms.person)
          .then((rows) => setHistory({ rows, problem: null }))
          .catch((error: unknown) => setHistory({ rows: null, problem: problemKeyOf(error, false) }))
    }
  }, [api, terms.unit, terms.person, terms.tab])

  useEffect(() => loadStructure(), [loadStructure])
  useEffect(() => {
    setHistory({ rows: null, problem: null })
    setFacts(EMPTY)
    loadProfile()
  }, [loadProfile])

  const reload = useCallback(() => {
    loadStructure()
    loadProfile()
  }, [loadStructure, loadProfile])

  const go = useCallback((next: Parameters<typeof structureHref>[1]) => router.push(structureHref(path, next), { scroll: false }), [router, path])

  // ---- Edit the profile / A new unit ----
  const [unitWin, setUnitWin] = useState<{ draft: UnitDraft | null; record: UnitRecord | null; busy: boolean; problem: string | null }>({ draft: null, record: null, busy: false, problem: null })
  const [customers, setCustomers] = useState<readonly { id: string; name: string }[] | null>(null)
  const readCustomers = useCallback(() => {
    if (customers) return
    getProductionCustomers(api, 'work-orders')
      .then((answer) => setCustomers(answer.customers.map((party) => ({ id: party.id, name: party.name }))))
      .catch(() => setCustomers([]))
  }, [api, customers])
  const openNewUnit = useCallback(
    (parentId: string | null, takesOrders = false) => {
      const parent = parentId ? tree?.byId.get(parentId)?.unit : null
      const siteId = parent?.siteId ?? scope.siteId ?? tree?.roots[0]?.unit.siteId ?? scope.sites[0]?.id ?? ''
      setUnitWin({ draft: newUnitDraftOf({ siteId, parentId: parent && !parent.takesOrders ? parent.id : (tree?.roots[0]?.unit.id ?? null), takesOrders, count: tree?.order.length ?? 0 }), record: null, busy: false, problem: null })
      readCustomers()
    },
    [tree, scope.siteId, scope.sites, readCustomers],
  )
  const openEditUnit = useCallback(() => {
    if (!unit.value) return
    setUnitWin({ draft: unitDraftOf(unit.value), record: unit.value, busy: false, problem: null })
    readCustomers()
  }, [unit.value, readCustomers])

  // ?new=team (the Teams page's "New team…"): once, when the structure is read and the person may change it.
  const newDone = useRef(false)
  useEffect(() => {
    if (!terms.newTeam || newDone.current || !tree || !rights.manage) return
    newDone.current = true
    openNewUnit(tree.roots[0]?.unit.id ?? null, true)
    router.replace(structureHref(path, { view: terms.view }), { scroll: false })
  }, [terms.newTeam, terms.view, tree, rights.manage, openNewUnit, router, path])

  const setUnitDraft = (next: (draft: UnitDraft) => UnitDraft) => setUnitWin((current) => (current.draft && !current.busy ? { ...current, draft: next(current.draft), problem: null } : current))
  const otherNames = (tree?.order ?? []).filter((node) => node.unit.id !== unitWin.draft?.id).map((node) => node.unit.name)
  const unitHeld = unitWin.draft ? unitHeldOf(unitWin.draft, otherNames) : null
  const saveUnit = async () => {
    const draft = unitWin.draft
    if (!draft || unitWin.busy || unitHeld) return
    setUnitWin((current) => ({ ...current, busy: true, problem: null }))
    try {
      if (draft.id === null) {
        const made = await createUnit(api, { ...unitBodyOf(draft), siteId: draft.siteId, parentId: draft.parentId })
        setUnitWin({ draft: null, record: null, busy: false, problem: null })
        setNotice({ key: 'notice.made', params: { name: draft.name.trim() } })
        loadStructure()
        go({ unit: made.id, tab: 'people' })
      } else {
        let version = draft.version
        if (leaderChanged(draft, unitWin.record)) version = (await setTeamLead(api, draft.id, { version, employeeId: draft.leaderId })).version
        await patchUnit(api, draft.id, { ...unitBodyOf(draft), version })
        setUnitWin({ draft: null, record: null, busy: false, problem: null })
        setNotice({ key: 'notice.saved' })
        reload()
      }
    } catch (error) {
      setUnitWin((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }

  // ---- Move (drag or Move…) ----
  const [moveWin, setMoveWin] = useState<{ drag: Drag | null; ask: MoveAsk | null; refusal: Words | null; query: string; busy: boolean; problem: string | null }>({ drag: null, ask: null, refusal: null, query: '', busy: false, problem: null })
  const nameOf = (drag: Drag | null): string => {
    if (!drag || !tree) return ''
    if (drag.kind === 'unit') return tree.byId.get(drag.id)?.unit.name ?? ''
    return [...tree.order.flatMap((node) => node.here), ...tree.loose].find((row) => row.employeeId === drag.id)?.name ?? ''
  }
  const askMove = (drag: Drag, target: string | null) => {
    if (!tree) return
    const ask = moveAskOf(tree, drag, target)
    setMoveWin({ drag, ask: isAsk(ask) ? ask : null, refusal: isAsk(ask) ? null : ask, query: '', busy: false, problem: null })
  }
  const doMove = async () => {
    const ask = moveWin.ask
    if (!ask || moveWin.busy) return
    setMoveWin((current) => ({ ...current, busy: true, problem: null }))
    try {
      if (ask.kind === 'unit') await moveUnit(api, ask.unitId, ask.parentId)
      else await applyMoves(api, [{ employeeId: ask.employeeId, teamId: ask.unitId }], newIdempotencyKey())
      setNotice({ key: ask.kind === 'person' ? 'notice.movedPerson' : ask.to === null ? 'notice.movedTop' : 'notice.movedUnit', params: { name: nameOf(moveWin.drag), to: ask.to ?? '' } })
      setMoveWin({ drag: null, ask: null, refusal: null, query: '', busy: false, problem: null })
      reload()
    } catch (error) {
      setMoveWin((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }

  // ---- Merge ----
  const [mergeWin, setMergeWin] = useState<{ draft: MergeDraft | null; query: string; busy: boolean; problem: string | null }>({ draft: null, query: '', busy: false, problem: null })
  const setMerge = (next: (draft: MergeDraft) => MergeDraft) => setMergeWin((current) => (current.draft && !current.busy ? { ...current, draft: next(current.draft), problem: null } : current))
  const doMerge = async () => {
    const draft = mergeWin.draft
    if (!draft || mergeWin.busy || mergeHeldOf(draft)) return
    setMergeWin((current) => ({ ...current, busy: true, problem: null }))
    try {
      await mergeUnits(api, mergeBodyOf(draft))
      setMergeWin({ draft: null, query: '', busy: false, problem: null })
      setNotice({ key: 'notice.merged', params: { name: draft.name.trim() } })
      loadStructure()
      go({ unit: draft.keepId, tab: 'people' })
    } catch (error) {
      setMergeWin((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }

  // ---- Close ----
  const [closeWin, setCloseWin] = useState<{ unitId: string | null; busy: boolean; problem: string | null }>({ unitId: null, busy: false, problem: null })
  const closeNode = closeWin.unitId ? (tree?.byId.get(closeWin.unitId) ?? null) : null
  const closeRecord = unit.value && unit.value.id === closeWin.unitId ? unit.value : null
  const doClose = async () => {
    if (!closeNode || closeWin.busy) return
    setCloseWin((current) => ({ ...current, busy: true, problem: null }))
    try {
      await closeUnit(api, closeNode.unit.id)
      setCloseWin({ unitId: null, busy: false, problem: null })
      setNotice({ key: 'notice.closed', params: { name: closeNode.unit.name } })
      loadStructure()
      go(closeNode.unit.parentId ? { unit: closeNode.unit.parentId } : {})
    } catch (error) {
      setCloseWin((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }

  // ---- Ready-made ----
  const [ready, setReady] = useState<{ open: boolean; pick: ReadyMade | null; preview: ReadyMadePreview | null; reading: boolean; busy: boolean; problem: string | null }>({ open: false, pick: null, preview: null, reading: false, busy: false, problem: null })
  const pickReady = (kind: ReadyMade) => {
    setReady((current) => ({ ...current, pick: kind, preview: null, reading: true, problem: null }))
    previewReadyMade(api, kind)
      .then((preview) => setReady((current) => (current.pick === kind ? { ...current, preview, reading: false } : current)))
      .catch((error: unknown) => setReady((current) => (current.pick === kind ? { ...current, reading: false, problem: problemKeyOf(error, false) } : current)))
  }
  const doReady = async () => {
    if (!ready.pick || ready.busy) return
    const kind = ready.pick
    setReady((current) => ({ ...current, busy: true, problem: null }))
    try {
      await applyReadyMade(api, kind)
      setReady({ open: false, pick: null, preview: null, reading: false, busy: false, problem: null })
      setNotice({ key: `notice.ready.${kind}` })
      loadStructure()
    } catch (error) {
      setReady((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }

  // ---- Edit the person / Add a person / Make leader ----
  const [personWin, setPersonWin] = useState<{ draft: PersonDraft | null; busy: boolean; problem: string | null }>({ draft: null, busy: false, problem: null })
  const setPerson = (patch: Partial<PersonDraft>) => setPersonWin((current) => (current.draft && !current.busy ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current))
  const savePerson = async () => {
    const draft = personWin.draft
    if (!draft || personWin.busy || personHeldOf(draft)) return
    setPersonWin((current) => ({ ...current, busy: true, problem: null }))
    try {
      await patchEmployee(api, draft.employeeId, personBodyOf(draft, rights.phone))
      setPersonWin({ draft: null, busy: false, problem: null })
      setNotice({ key: 'notice.saved' })
      reload()
    } catch (error) {
      setPersonWin((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }
  const [addWin, setAddWin] = useState<{ draft: AddDraft | null; busy: boolean; problem: string | null }>({ draft: null, busy: false, problem: null })
  const setAdd = (patch: Partial<AddDraft>) => setAddWin((current) => (current.draft && !current.busy ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current))
  const doAdd = async () => {
    const draft = addWin.draft
    const home = draft?.unitId ? tree?.byId.get(draft.unitId)?.unit : null
    if (!draft || !home || addWin.busy || addHeldOf(draft)) return
    setAddWin((current) => ({ ...current, busy: true, problem: null }))
    try {
      const made = await createEmployee(api, { siteId: home.siteId, firstName: draft.firstName.trim(), lastName: draft.lastName.trim(), startDate: draft.startDate, ...(draft.role.trim() ? { jobRole: draft.role.trim() } : {}) })
      await applyMoves(api, [{ employeeId: made.id, teamId: home.id }], newIdempotencyKey())
      setAddWin({ draft: null, busy: false, problem: null })
      setNotice({ key: 'notice.added', params: { name: made.name, unit: home.name } })
      reload()
    } catch (error) {
      setAddWin((current) => ({ ...current, busy: false, problem: problemKeyOf(error, true) }))
    }
  }
  const makeLeader = async (employeeId: string) => {
    const unitId = terms.unit
    if (!unitId) return
    try {
      const record = unit.value?.id === unitId ? unit.value : await getUnit(api, unitId)
      await setTeamLead(api, unitId, { version: record.version, employeeId })
      setNotice({ key: 'notice.leader', params: { name: record.members.find((row) => row.employeeId === employeeId)?.name ?? '', unit: record.name } })
      reload()
    } catch (error) {
      setNotice({ key: problemKeyOf(error, true) })
    }
  }

  // ---- the faces ----
  const windows = (
    <>
      <UnitWindow
        model={{ open: unitWin.draft !== null, draft: unitWin.draft, record: unitWin.record, parentName: unitWin.draft?.parentId ? (tree?.byId.get(unitWin.draft.parentId)?.unit.name ?? null) : null, customers, held: unitHeld, busy: unitWin.busy, problem: unitWin.problem }}
        actions={{
          onClose: () => setUnitWin((current) => (current.busy ? current : { draft: null, record: null, busy: false, problem: null })),
          onTeam: (team) => setUnitDraft((draft) => ({ ...draft, takesOrders: team, kindWord: team ? '' : draft.kindWord })),
          onName: (name) => setUnitDraft((draft) => ({ ...draft, name })),
          onKind: (kindWord) => setUnitDraft((draft) => ({ ...draft, kindWord })),
          onAbout: (about) => setUnitDraft((draft) => ({ ...draft, about })),
          onLetters: () => setUnitDraft((draft) => ({ ...draft, picture: pickLetters(draft.picture) })),
          onIcon: (icon) => setUnitDraft((draft) => ({ ...draft, picture: pickIcon(draft.picture, icon) })),
          onColour: (colour) => setUnitDraft((draft) => ({ ...draft, picture: pickColour(draft.picture, colour) })),
          onLeader: (employeeId) => setUnitDraft((draft) => withLeader(draft, employeeId)),
          onStandIn: (employeeId) => setUnitDraft((draft) => ({ ...draft, standInId: employeeId, standInUntil: employeeId ? draft.standInUntil : '' })),
          onStandInUntil: (day) => setUnitDraft((draft) => ({ ...draft, standInUntil: day })),
          onWorksFor: (partyId) => setUnitDraft((draft) => toggleWorksFor(draft, partyId)),
          onMax: (maxBaskets) => setUnitDraft((draft) => ({ ...draft, maxBaskets })),
          onTakesNew: (takesNewOrders) => setUnitDraft((draft) => ({ ...draft, takesNewOrders })),
          onSave: () => void saveUnit(),
        }}
      />
      <MoveWindow
        model={{ open: moveWin.drag !== null, drag: moveWin.drag, name: nameOf(moveWin.drag), ask: moveWin.ask, refusal: moveWin.refusal, targets: tree && moveWin.drag ? moveTargetsOf(tree, moveWin.drag) : { top: false, units: [] }, query: moveWin.query, busy: moveWin.busy, problem: moveWin.problem }}
        actions={{
          onClose: () => setMoveWin((current) => (current.busy ? current : { drag: null, ask: null, refusal: null, query: '', busy: false, problem: null })),
          onQuery: (text) => setMoveWin((current) => ({ ...current, query: text })),
          onPick: (target) => moveWin.drag && askMove(moveWin.drag, target),
          onBack: () => setMoveWin((current) => (current.busy ? current : { ...current, ask: null, refusal: null })),
          onMove: () => void doMove(),
        }}
      />
      <MergeWindow
        model={{ open: mergeWin.draft !== null, draft: mergeWin.draft, tree, candidates: tree && mergeWin.draft ? mergeCandidatesOf(tree, mergeWin.draft.baseId) : [], leaders: tree && mergeWin.draft ? mergeLeadersOf(tree, mergeWin.draft) : [], moves: tree && mergeWin.draft ? mergeMovesOf(tree, mergeWin.draft) : { people: 0, units: 0 }, query: mergeWin.query, busy: mergeWin.busy, problem: mergeWin.problem }}
        actions={{
          onClose: () => setMergeWin((current) => (current.busy ? current : { draft: null, query: '', busy: false, problem: null })),
          onQuery: (text) => setMergeWin((current) => ({ ...current, query: text })),
          onTick: (unitId) => setMerge((draft) => tickMerge(draft, unitId)),
          onNext: () => setMerge((draft) => (draft.picked.length ? { ...draft, step: 'confirm' } : draft)),
          onBack: () => setMerge((draft) => ({ ...draft, step: 'pick' })),
          onKeep: (unitId) => tree && setMerge((draft) => keepMerge(tree, draft, unitId)),
          onName: (name) => setMerge((draft) => ({ ...draft, name })),
          onLeader: (leaderId) => setMerge((draft) => ({ ...draft, leaderId })),
          onMerge: () => void doMerge(),
        }}
      />
      <CloseWindow
        model={{ open: closeNode !== null, node: closeNode, reading: closeNode !== null && !closeRecord, blockers: closeNode ? closeBlockersOf(closeNode, openOrdersOf(closeRecord)) : [], busy: closeWin.busy, problem: closeWin.problem }}
        onClose={() => setCloseWin((current) => (current.busy ? current : { unitId: null, busy: false, problem: null }))}
        onMerge={() => {
          if (!tree || !closeNode) return
          setCloseWin({ unitId: null, busy: false, problem: null })
          setMergeWin({ draft: mergeDraftOf(tree, closeNode.unit.id), query: '', busy: false, problem: null })
        }}
        onConfirm={() => void doClose()}
      />
      <ReadyMadeWindow model={ready} onClose={() => setReady((current) => (current.busy ? current : { open: false, pick: null, preview: null, reading: false, busy: false, problem: null }))} onPick={pickReady} onApply={() => void doReady()} />
      <PersonWindow
        model={{ open: personWin.draft !== null, name: facts.value?.name ?? '', draft: personWin.draft, phone: rights.phone, held: personWin.draft ? personHeldOf(personWin.draft) : null, busy: personWin.busy, problem: personWin.problem }}
        actions={{
          onClose: () => setPersonWin((current) => (current.busy ? current : { draft: null, busy: false, problem: null })),
          onRole: (role) => setPerson({ role }),
          onPhone: (phone) => setPerson({ phone }),
          onSpeaks: (locale) => setPerson({ locale }),
          onSince: (since) => setPerson({ since }),
          onSave: () => void savePerson(),
        }}
      />
      <AddPersonWindow
        model={{ open: addWin.draft !== null, draft: addWin.draft, units: (tree?.order ?? []).map((node) => ({ id: node.unit.id, name: node.unit.name, depth: node.depth })), held: addWin.draft ? addHeldOf(addWin.draft) : null, busy: addWin.busy, problem: addWin.problem }}
        actions={{
          onClose: () => setAddWin((current) => (current.busy ? current : { draft: null, busy: false, problem: null })),
          onFirst: (firstName) => setAdd({ firstName }),
          onLast: (lastName) => setAdd({ lastName }),
          onRole: (role) => setAdd({ role }),
          onUnit: (unitId) => setAdd({ unitId: unitId || null }),
          onStart: (startDate) => setAdd({ startDate }),
          onAdd: () => void doAdd(),
        }}
      />
    </>
  )

  const openAdd = (unitId: string | null) => setAddWin({ draft: addDraftOf(unitId, today), busy: false, problem: null })
  const dismiss = () => setNotice(null)

  if (terms.unit) {
    const node = tree?.byId.get(terms.unit) ?? null
    return (
      <>
        <UnitProfileView
          model={{
            path,
            prefix,
            tab: tabOf(terms.tab, UNIT_TABS),
            state: unit.value ? 'ready' : unit.problem ? 'failed' : 'reading',
            problem: unit.problem,
            node,
            record: unit.value,
            chain: tree ? chainOf(tree, terms.unit) : [],
            history,
            manage: rights.manage,
            people: peopleRight,
            addPerson,
            notice,
          }}
          actions={{
            onRetry: reload,
            onEdit: openEditUnit,
            onMove: () => setMoveWin({ drag: { kind: 'unit', id: terms.unit! }, ask: null, refusal: null, query: '', busy: false, problem: null }),
            onMerge: () => tree && setMergeWin({ draft: mergeDraftOf(tree, terms.unit!), query: '', busy: false, problem: null }),
            onClose: () => setCloseWin({ unitId: terms.unit, busy: false, problem: null }),
            onNewUnit: () => openNewUnit(terms.unit),
            onAddPerson: () => openAdd(terms.unit),
            onMakeLeader: (employeeId) => void makeLeader(employeeId),
            onMovePerson: (employeeId) => setMoveWin({ drag: { kind: 'person', id: employeeId }, ask: null, refusal: null, query: '', busy: false, problem: null }),
            onDismissNotice: dismiss,
          }}
        />
        {windows}
      </>
    )
  }

  if (terms.person) {
    const row = tree ? ([...tree.order.flatMap((node) => node.here), ...tree.loose].find((each) => each.employeeId === terms.person) ?? null) : null
    const home = row?.unitId ? (tree?.byId.get(row.unitId)?.unit ?? null) : null
    return (
      <>
        <PersonProfileView
          model={{
            path,
            tab: tabOf(terms.tab, PERSON_TABS),
            state: row ? 'ready' : structure.problem ? 'failed' : 'reading',
            problem: structure.problem,
            row,
            line: home && tree ? [home, ...chainOf(tree, home.id)] : [],
            boss: row && tree ? bossOf(tree, row) : null,
            facts: facts.value,
            factsProblem: facts.problem,
            phone: rights.phone,
            history,
            edit: rights.editPerson,
            move: peopleRight,
            notice,
          }}
          actions={{
            onRetry: reload,
            onEdit: () => facts.value && setPersonWin({ draft: personDraftOf(facts.value), busy: false, problem: null }),
            onMove: () => setMoveWin({ drag: { kind: 'person', id: terms.person! }, ask: null, refusal: null, query: '', busy: false, problem: null }),
            onDismissNotice: dismiss,
          }}
        />
        {windows}
      </>
    )
  }

  return (
    <>
      <StructureView
        model={{ path, state: structure.value ? 'ready' : structure.problem ? 'failed' : 'reading', problem: structure.problem, tree, manage: rights.manage, addPerson, view: terms.view, query, shut, notice }}
        actions={{
          onRetry: loadStructure,
          onView: (view) => router.replace(structureHref(path, { view }), { scroll: false }),
          onQuery: setQuery,
          onToggle: (unitId) => setShut((current) => (current.has(unitId) ? new Set([...current].filter((id) => id !== unitId)) : new Set([...current, unitId]))),
          onOpenAll: (open) => setShut(open ? new Set() : new Set((tree?.order ?? []).filter((node) => node.children.length > 0 && node.unit.parentId !== null).map((node) => node.unit.id))),
          onNewUnit: (parentId) => openNewUnit(parentId),
          onAddPerson: openAdd,
          onReadyMade: () => setReady({ open: true, pick: null, preview: null, reading: false, busy: false, problem: null }),
          onMove: (drag) => setMoveWin({ drag, ask: null, refusal: null, query: '', busy: false, problem: null }),
          onDrop: askMove,
          onDismissNotice: dismiss,
        }}
      />
      {windows}
    </>
  )
}
