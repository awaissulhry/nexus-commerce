'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StyleView } from '@nexus/factory-domain/product/styles/contracts'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useLocale } from '../../../../../lib/i18n/provider'
import { isStepUpCancelled, useCoalesced, useLive, useStepUp } from '../../../../finance/_shared/hooks'
import { grainsOf } from '../../model'
import type { BySizeModel } from '../bysize/view/BySizeCard'
import type { CostStepsModel } from '../components/view/CostStepsCard'
import { goalAskOf, goalQueryOf, keepBodyOf, type GoalAsk } from '../goalseek/model'
import type { TargetPriceModel } from '../goalseek/view/TargetPriceCard'
import {
  approveTask,
  compareVersions,
  createVersion,
  goalSeek,
  keepTarget,
  listVersions,
  openSeasons,
  readBySize,
  readComponents,
  readTask,
  readVersion,
  removeVersion,
  setSurcharge,
  submitVersion,
  takeBack,
  type ApprovalTask,
  type BySizeView,
  type CompareView,
  type ComponentsView,
  type GoalSeekView,
  type SeasonOption,
  type VersionRecord,
  type VersionsView,
} from './api'
import { compareDefaults, costSheetAbilitiesOf, costSheetsTouched, readProblem, versionInView, writeProblem, type Phrase, type Read } from './model'
import { newVersionBody, type CompareModel, type NewVersionDraft, type VersionDialog, type VersionsModel } from './screen'
import type { CostSheetsActions, CostSheetsModel } from './view/CostSheetsView'

const ready = <T,>(value: T): Read<T> => ({ status: 'ready', value })

/**
 * The container of the Cost tab's cost sheets (B-W2b-430): reads the versions of the style, the version in view with its
 * lines, its waiting request (who asked, whether this person may decide), its goal-seek and its cost by size, and the live
 * components of the revision in view; writes through the API (a new version, the target kept on a draft, sent for
 * approval, approved through the engine — a fresh code when a rule asks one —, taken back, a draft deleted, a size
 * surcharge used), each with an Idempotency-Key and the version's row version; reads again on a live change.
 */
export function useCostSheets({ style, revisionId, cell }: { style: StyleView; revisionId: string | null; cell: { colourwayId: string; size: string } | null }): { model: CostSheetsModel; actions: CostSheetsActions } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const can = useMemo(() => costSheetAbilitiesOf(session.permissions), [session.permissions])
  const grains = useMemo(() => grainsOf(session.permissions), [session.permissions])
  const companyId = style.companyId ?? session.company?.id ?? null
  const revision = style.revisions.find((entry) => entry.id === revisionId) ?? null
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const [list, setList] = useState<Read<VersionsView>>({ status: 'idle' })
  const [picked, setPicked] = useState<string | null>(null)
  const [record, setRecord] = useState<Read<VersionRecord>>({ status: 'idle' })
  const [task, setTask] = useState<Read<ApprovalTask> | null>(null)
  const [seasons, setSeasons] = useState<Read<readonly SeasonOption[]>>({ status: 'idle' })
  const [dialog, setDialog] = useState<VersionDialog | null>(null)
  const [compare, setCompare] = useState<CompareModel | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const [notice, setNotice] = useState<VersionsModel['notice']>(null)
  const [goal, setGoal] = useState<Read<GoalSeekView>>({ status: 'idle' })
  const [goalProblem, setGoalProblem] = useState<Phrase | null>(null)
  const [bySize, setBySize] = useState<Read<BySizeView>>({ status: 'idle' })
  const [bySizeProblem, setBySizeProblem] = useState<Phrase | null>(null)
  const [bySizeNotice, setBySizeNotice] = useState<Phrase | null>(null)
  const [components, setComponents] = useState<Read<ComponentsView>>({ status: 'idle' })
  const [stepsSize, setStepsSize] = useState<string | null>(null)
  const [cartonPieces, setCartonPieces] = useState<number | null>(null)
  const attempt = useRef<string | null>(null)

  const rows = list.status === 'ready' ? list.value.versions : []
  const inView = versionInView(rows, picked)
  const inViewKey = inView ? `${inView.id}:${inView.version}` : null

  const readList = useCallback(async () => {
    if (!can.view) return
    try {
      setList(ready(await listVersions(api, style.id, companyId)))
    } catch (error) {
      setList({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view, companyId, style.id])

  const readRecord = useCallback(
    async (sheetId: string) => {
      setRecord((current) => (current.status === 'ready' && current.value.sheet.id === sheetId ? current : { status: 'loading' }))
      try {
        setRecord(ready(await readVersion(api, sheetId)))
      } catch (error) {
        setRecord({ status: 'error', problem: readProblem(error) })
      }
    },
    [api],
  )

  const readSizes = useCallback(
    async (sheetId: string) => {
      setBySize((current) => (current.status === 'ready' && current.value.sheet.id === sheetId ? current : { status: 'loading' }))
      try {
        setBySize(ready(await readBySize(api, sheetId)))
      } catch (error) {
        setBySize({ status: 'error', problem: readProblem(error) })
      }
    },
    [api],
  )

  const readWaiting = useCallback(
    async (taskId: string) => {
      setTask({ status: 'loading' })
      try {
        setTask(ready(await readTask(api, taskId)))
      } catch (error) {
        setTask({ status: 'error', problem: readProblem(error) })
      }
    },
    [api],
  )

  const colourwayId = cell?.colourwayId ?? null
  const readSteps = useCallback(async () => {
    if (!can.view || !revisionId) {
      setComponents({ status: 'idle' })
      return
    }
    setComponents((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    try {
      setComponents(ready(await readComponents(api, { styleId: style.id, revisionId, companyId, colourwayId, piecesPerCarton: cartonPieces })))
    } catch (error) {
      setComponents({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view, cartonPieces, colourwayId, companyId, revisionId, style.id])

  useEffect(() => {
    setList({ status: 'loading' })
    void readList()
  }, [readList])
  useEffect(() => {
    void readSteps()
  }, [readSteps])
  // The version in view: its lines, its cost by size, its waiting request; the target price starts again from its own.
  useEffect(() => {
    if (!inView) {
      setRecord({ status: 'idle' })
      setBySize({ status: 'idle' })
      setTask(null)
      return
    }
    void readRecord(inView.id)
    void readSizes(inView.id)
    if (inView.approval?.status === 'PENDING' && inView.state === 'DRAFT') void readWaiting(inView.approval.taskId)
    else setTask(null)
  }, [inViewKey, readRecord, readSizes, readWaiting]) // read again when the version (or its row version) changes
  useEffect(() => {
    setGoal({ status: 'idle' })
    setGoalProblem(null)
    setBySizeNotice(null)
    setBySizeProblem(null)
  }, [inView?.id])

  const reread = useCoalesced(() => {
    void readList()
    void readSteps()
  }, 800)
  useLive(
    (change) => {
      if (costSheetsTouched(change)) reread()
    },
    () => reread(),
    can.view,
  )

  const openDialog = (next: VersionDialog | null) => {
    attempt.current = null
    setProblem(null)
    setDialog(next)
    if (next?.kind === 'new' && next.from === 'COMPONENTS' && seasons.status !== 'ready' && companyId) {
      setSeasons({ status: 'loading' })
      openSeasons(api, companyId)
        .then((value) => setSeasons(ready(value)))
        .catch((error: unknown) => setSeasons({ status: 'error', problem: readProblem(error) }))
    }
  }

  /** One write of the versions: busy while it runs, a notice when done, the problem in the dialog (and a read again when moved). */
  const write = async (work: (key: string) => Promise<unknown>, done: Phrase, after?: () => void) => {
    if (busy) return
    attempt.current ??= newIdempotencyKey()
    const key = attempt.current
    setBusy(true)
    setProblem(null)
    try {
      await work(key)
      attempt.current = null
      setDialog(null)
      setNotice({ tone: 'success', words: done })
      after?.()
      await readList()
    } catch (error) {
      if (isStepUpCancelled(error)) return
      const words = writeProblem(error)
      setProblem({ key: words.key, ...(words.params ? { params: words.params } : {}) })
      if (words.reload) void readList()
    } finally {
      setBusy(false)
    }
  }

  const compareRead = (a: string, b: string) => {
    setCompare({ a, b, result: a === b ? { status: 'idle' } : { status: 'loading' } })
    if (a === b) return
    compareVersions(api, a, b)
      .then((value: CompareView) => setCompare((current) => (current && current.a === a && current.b === b ? { a, b, result: ready(value) } : current)))
      .catch((error: unknown) => setCompare((current) => (current && current.a === a && current.b === b ? { a, b, result: { status: 'error', problem: readProblem(error) } } : current)))
  }

  const versions: VersionsModel = {
    styleId: style.id,
    revision: revision ? { id: revision.id, revision: revision.revision } : null,
    sizes: style.sizes,
    baseSize: style.baseSize,
    can,
    grains,
    list,
    inView,
    record,
    task,
    seasons,
    dialog,
    compare,
    busy,
    problem,
    notice,
    stepUp: { open: stepUp.open, busy: stepUp.busy, problem: stepUp.problem ? stepUp.problem.replace('stepUp.problem.', 'verStepUp.problem.') : null },
  }

  const goalModel: TargetPriceModel = { sheet: inView, sizes: list.status === 'ready' ? list.value.style.sizes : style.sizes, can, grains, ask: goalAskOf(inView, locale), result: goal, busy, problem: goalProblem }
  const bySizeModel: BySizeModel = { sheet: inView, result: bySize, can, grains, busy, problem: bySizeProblem, notice: bySizeNotice }
  const stepsModel: CostStepsModel = { components, size: stepsSize ?? cell?.size ?? null, cartonPieces, grains }

  return {
    model: { steps: stepsModel, versions, goal: goalModel, bySize: bySizeModel },
    actions: {
      steps: {
        onSize: setStepsSize,
        onCartonPieces: setCartonPieces,
        onRetry: () => void readSteps(),
      },
      versions: {
        onPick: (id) => setPicked(id),
        onDialog: openDialog,
        onCreate: (draft: NewVersionDraft) =>
          void write(
            async (key) => {
              const made = await createVersion(api, newVersionBody(draft, { styleId: style.id, revisionId, companyId: style.companyId === null ? companyId : null, colourwayId, grains }), key)
              setPicked(made.id)
            },
            { key: 'verNotice.made' },
          ),
        onSend: (input) => inView && void write((key) => submitVersion(api, inView, { ...(input.note ? { note: input.note } : {}), ...(input.coveredByTyped ? { coveredByTyped: true } : {}) }, key), { key: 'verNotice.sent', params: { version: inView.sheetVersion } }),
        onApprove: (comment) => {
          if (!inView || task?.status !== 'ready') return
          const waiting = task.value
          void write((key) => guard('verStepUp.sentence', () => approveTask(api, waiting, comment, key)), { key: 'verNotice.approved', params: { version: inView.sheetVersion } })
        },
        onTakeBack: (reason) => inView && void write((key) => takeBack(api, inView, reason, key), { key: 'verNotice.takenBack', params: { version: inView.sheetVersion } }),
        onRemove: () =>
          inView &&
          void write(
            () => removeVersion(api, inView),
            { key: 'verNotice.removed', params: { version: inView.sheetVersion } },
            () => setPicked(null),
          ),
        onCompareOpen: () => {
          const pair = compareDefaults(rows)
          if (pair) compareRead(pair.a, pair.b)
        },
        onCompare: compareRead,
        onCompareClose: () => setCompare(null),
        onRetry: (part) => {
          if (part === 'list') {
            setList({ status: 'loading' })
            void readList()
          } else if (part === 'record' && inView) void readRecord(inView.id)
          else if (part === 'task' && inView?.approval) void readWaiting(inView.approval.taskId)
        },
        onDismissNotice: () => setNotice(null),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      },
      goal: {
        onSeek: (ask: GoalAsk) => {
          if (!inView) return
          const sheetId = inView.id
          setGoal({ status: 'loading' })
          setGoalProblem(null)
          goalSeek(api, sheetId, goalQueryOf(ask, grains))
            .then((value) => setGoal(ready(value)))
            .catch((error: unknown) => setGoal({ status: 'error', problem: readProblem(error) }))
        },
        onKeep: (ask: GoalAsk) => {
          if (!inView || busy) return
          setBusy(true)
          setGoalProblem(null)
          keepTarget(api, inView, keepBodyOf(ask, grains))
            .then(async () => {
              setNotice({ tone: 'success', words: { key: 'verNotice.targetKept', params: { version: inView.sheetVersion } } })
              await readList()
            })
            .catch((error: unknown) => {
              const words = writeProblem(error)
              setGoalProblem({ key: words.key })
              if (words.reload) void readList()
            })
            .finally(() => setBusy(false))
        },
      },
      bySize: {
        onUse: (row) => {
          if (busy || !inView) return
          setBusy(true)
          setBySizeProblem(null)
          setBySizeNotice(null)
          setSurcharge(api, style.id, row)
            .then(async () => {
              setBySizeNotice({ key: 'bysize.used', params: { size: row.size } })
              await readSizes(inView.id)
            })
            .catch((error: unknown) => setBySizeProblem({ key: writeProblem(error).key }))
            .finally(() => setBusy(false))
        },
        onRetry: () => inView && void readSizes(inView.id),
      },
    },
  }
}
