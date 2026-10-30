'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { useLiveChanges } from '../../../../record-panels/live'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { putToStore, storeUrl } from '../../../../record-panels/store'
import {
  addBomLine,
  addColourway,
  addSteps,
  announceDocument,
  archiveStyle,
  assignLabel,
  compareCost,
  confirmDocument,
  copyRevision,
  documentDownload,
  exportBom,
  findMaterials,
  findOperations,
  generateSkus,
  getBom,
  getCompliance,
  getCostSheet,
  getMaterial,
  getRouting,
  getStyle,
  listBrands,
  listColours,
  listLabelTemplates,
  listScales,
  listWorkshops,
  obsoleteRevision,
  reactivateStyle,
  releaseRevision,
  removeBomLine,
  removeStep,
  reorderSteps,
  setBomColours,
  setBomSizes,
  setGarmentTracking,
  startRevision,
  updateBomLine,
  updateColourway,
  updateRevision,
  updateSku,
  updateStep,
  updateStyle,
  type BomExportFormat,
  type BomView,
  type CostDiffView,
  type CostSheetView,
  type MaterialView,
  type RoutingView,
  type StyleComplianceView,
  type StyleView,
} from '../api'
import { useDuplicate } from '../duplicate/use-duplicate'
import { EVERY_COMPANY, useSheetImport } from '../import/sheet-import'
import { abilitiesOf, grainsOf, releasedOf, revisionInView, sha256Of, tabOf, type StyleTab } from '../model'
import { readProblem, writeProblem } from '../problems'
import type { BomViewMode, Loaded, Part, SaveState, StyleDialog, StyleNotice, StyleRecordViewModel } from './record-model'
import { StyleRecordView } from './view/StyleRecordView'

const WIDE = '(min-width: 1280px)'
const DOCK_KEY = 'fw.products.dock.Style'

/**
 * `/w/<company>/products/styles/<id>` (SCR-041 … SCR-045): loads the style (product.styles.view; the API checks the
 * company) and, for the revision in view, the parts the person's role reads — the BOM (its release check), the routing,
 * the compliance tab — each failing alone; it does what the view asks, one write at a time, each with the version as
 * read (a 409 reads it again and says so, never overwrites). Live: the style's events read it again; with unsaved work
 * the page says it changed instead.
 */
export function StyleRecord({ styleId }: { styleId: string }) {
  return (
    <WithMessages namespaces={['products', 'records']}>
      <StyleRecordContainer styleId={styleId} />
    </WithMessages>
  )
}

function StyleRecordContainer({ styleId }: { styleId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const askedRevision = params?.get('rev') ?? null
  const prefix = pathname.replace(/\/products\/styles\/[^/]+\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const grains = useMemo(() => grainsOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const locale = useLocale()
  const t = useT('products')

  const [style, setStyle] = useState<Loaded<StyleView>>({ status: 'loading' })
  const styleRef = useRef<StyleView | null>(null)
  const [bom, setBom] = useState<Part<BomView>>({ status: 'idle' })
  const bomRef = useRef<BomView | null>(null)
  const [routing, setRouting] = useState<Part<RoutingView>>({ status: 'idle' })
  const routingRef = useRef<RoutingView | null>(null)
  const [compliance, setCompliance] = useState<Part<StyleComplianceView>>({ status: 'idle' })
  const [cost, setCost] = useState<Part<CostSheetView>>({ status: 'idle' })
  const [costCompare, setCostCompare] = useState<CostDiffView | null>(null)
  const [costCell, setCostCell] = useState<{ colourwayId: string; size: string } | null>(null)
  const [materials, setMaterials] = useState<Record<string, MaterialView | null>>({})
  const [materialSearch, setMaterialSearch] = useState<StyleRecordViewModel['materialSearch']>({ query: '', results: null, problem: null })
  const [operationSearch, setOperationSearch] = useState<StyleRecordViewModel['operationSearch']>({ query: '', kind: null, results: null, problem: null })
  /** The latest version of the revision in view (a revision's BOM and routing are one versioned record). */
  const revisionVersionRef = useRef<{ id: string; version: number } | null>(null)
  const [libraries, setLibraries] = useState<StyleRecordViewModel['libraries']>({ scales: null, colours: null, brands: null, labels: null, workshops: null })
  const [refused, setRefused] = useState<string[]>([])
  const [exporting, setExporting] = useState<BomExportFormat | null>(null)
  const [save, setSave] = useState<SaveState>({ state: 'idle', at: null })
  const [dialog, setDialog] = useState<StyleDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<StyleNotice | null>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [dockOpen, setDockOpen] = useState(false)
  const [bomView, setBomView] = useState<BomViewMode>('lines')
  const inFlight = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  const value = style.status === 'ready' ? style.value : null
  const revision = value ? revisionInView(value.revisions, askedRevision) : null
  const revisionId = revision?.id ?? null

  const setStyleValue = useCallback((next: StyleView) => {
    styleRef.current = next
    setStyle({ status: 'ready', value: next })
  }, [])
  const setBomValue = useCallback((next: BomView) => {
    bomRef.current = next
    revisionVersionRef.current = { id: next.revision.id, version: next.revision.version }
    setBom({ status: 'ready', value: next })
  }, [])
  const setRoutingValue = useCallback((next: RoutingView) => {
    routingRef.current = next
    revisionVersionRef.current = { id: next.revision.id, version: next.revision.version }
    setRouting({ status: 'ready', value: next })
  }, [])

  const loadStyle = useCallback(async () => {
    try {
      setStyleValue(await getStyle(api, styleId))
      setChanged(null)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setStyle({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setStyle({ status: 'forbidden' })
      else setStyle({ status: 'error', problem: readProblem(error) })
    }
  }, [api, styleId, setStyleValue])

  /** The cost sheet of a revision, and (for a draft of a style with a released revision) the change against it. */
  const loadCost = (id: string) => {
    const style = styleRef.current
    // A tenant-wide style is priced for the company the page works in; a company's style for its own company.
    const pricedFor = style && style.companyId === null ? companyId : null
    setCost((current) => (current.status === 'ready' && current.value.revision.id === id ? current : { status: 'loading' }))
    getCostSheet(api, styleId, id, pricedFor)
      .then((sheet) => setCost({ status: 'ready', value: sheet }))
      .catch((error: unknown) => setCost({ status: 'error', problem: readProblem(error) }))
    const released = style ? releasedOf(style.revisions) : null
    const viewing = style?.revisions.find((entry) => entry.id === id)
    if (released && viewing && viewing.status === 'DRAFT') {
      compareCost(api, styleId, released.id, id, pricedFor)
        .then(setCostCompare)
        .catch(() => setCostCompare(null))
    } else setCostCompare(null)
  }

  const loadParts = useCallback(
    (id: string | null) => {
      if (!id) {
        bomRef.current = null
        setBom({ status: 'idle' })
        setRouting({ status: 'idle' })
      } else {
        if (can.bomView) {
          setBom((current) => (current.status === 'ready' && current.value.revision.id === id ? current : { status: 'loading' }))
          getBom(api, styleId, id)
            .then(setBomValue)
            .catch((error: unknown) => setBom({ status: 'error', problem: readProblem(error) }))
        }
        if (can.routingView) {
          setRouting((current) => (current.status === 'ready' && current.value.revision.id === id ? current : { status: 'loading' }))
          getRouting(api, styleId, id)
            .then(setRoutingValue)
            .catch((error: unknown) => setRouting({ status: 'error', problem: readProblem(error) }))
        }
        if (can.costView) loadCost(id)
      }
      if (can.complianceView) {
        getCompliance(api, styleId, id)
          .then((next) => setCompliance({ status: 'ready', value: next }))
          .catch((error: unknown) => setCompliance({ status: 'error', problem: readProblem(error) }))
      }
    },
    [api, styleId, can.bomView, can.routingView, can.complianceView, can.costView, setBomValue, setRoutingValue],
  )

  useEffect(() => {
    void loadStyle()
  }, [loadStyle])

  // The parts of the revision in view, read again when another revision is chosen.
  const versionKey = value ? `${revisionId}:${value.revisions.map((entry) => `${entry.id}.${entry.status}`).join(',')}` : null
  useEffect(() => {
    if (versionKey !== null) loadParts(revisionId)
    // The key holds the revision in view and every revision's state.
  }, [versionKey])

  // The libraries the forms pick from (each optional: without it the field is drawn as text).
  useEffect(() => {
    listScales(api, companyId)
      .then((scales) => setLibraries((current) => ({ ...current, scales })))
      .catch(() => undefined)
    listColours(api, companyId)
      .then((colours) => setLibraries((current) => ({ ...current, colours })))
      .catch(() => undefined)
    if (can.brands)
      listBrands(api)
        .then((brands) => setLibraries((current) => ({ ...current, brands })))
        .catch(() => undefined)
    if (can.labels && can.complianceView)
      listLabelTemplates(api)
        .then((labels) => setLibraries((current) => ({ ...current, labels })))
        .catch(() => setLibraries((current) => ({ ...current, labels: [] })))
  }, [api, companyId, can.brands, can.labels, can.complianceView])

  // The thread beside the tab (Owner O1), remembered on this device (a per-viewer convenience).
  useEffect(() => {
    try {
      setDockOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setDockOpen(false)
    }
  }, [])
  const toggleDock = () => {
    let wide = false
    try {
      wide = window.matchMedia(WIDE).matches
    } catch {
      wide = false
    }
    if (!wide) {
      router.push(hrefFor('activity'))
      return
    }
    setDockOpen((current) => {
      try {
        window.localStorage.setItem(DOCK_KEY, current ? '0' : '1')
      } catch {
        // Not kept on this device; the dock still toggles.
      }
      return !current
    })
  }

  const hrefFor = (next: StyleTab, rev: string | null = askedRevision) => `${prefix}/products/styles/${styleId}?tab=${next}${rev ? `&rev=${rev}` : ''}`

  // ---- live -----------------------------------------------------------------------------------------------------------
  const reloadAll = useCallback(() => {
    void loadStyle()
    loadParts(revisionId)
  }, [loadStyle, loadParts, revisionId])

  // W2a: Duplicate style (the band's ⋯) and Import BOM (importer product.bom; the rows name their styles).
  const duplicate = useDuplicate(api)
  const companies = useMemo(() => session.companies.map((company) => ({ id: company.id, name: company.name })), [session.companies])
  const importRights = useMemo(() => ({ view: session.permissions.includes('imports.view'), run: can.imports, apply: can.importsApply, people: false }), [session.permissions, can.imports, can.importsApply])
  const bomImport = useSheetImport(api, {
    importerKey: 'product.bom',
    // The job's company is the style's: a style of every company is imported by a job for every company.
    companyId: value ? (value.companyId ?? EVERY_COMPANY) : (companyId ?? ''),
    companies,
    everyCompany: t('newStyle.everyCompany'),
    rights: importRights,
    locale,
    onApplied: () => reloadAll(),
  })

  useLiveChanges({
    onChange: (change) => {
      if (change.fields.styleId !== styleId) return
      if (inFlight.current > 0) return
      if (dialog) setChanged({ at: new Date().toISOString() })
      else reloadAll()
    },
    onReconnect: () => {
      if (inFlight.current === 0 && !dialog) reloadAll()
    },
  })

  // ---- writes ---------------------------------------------------------------------------------------------------------
  const enqueue = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work)
    queue.current = next.catch(() => undefined)
    return next
  }, [])

  /** One write; true when the server took it. A 409 reads the style again and says why. */
  const run = useCallback(
    async (work: () => Promise<void>, done?: StyleNotice): Promise<boolean> =>
      enqueue(async () => {
        inFlight.current++
        setBusy(true)
        setSave({ state: 'saving', at: null })
        try {
          await work()
          setSave({ state: 'saved', at: new Date().toISOString() })
          setNotice(done ?? null)
          setRefused([])
          return true
        } catch (error) {
          const problem = writeProblem(error)
          setNotice({ key: problem.key, tone: 'danger' })
          setRefused(problem.paths)
          setSave((state) => ({ state: 'failed', at: state.at }))
          if (problem.reload) reloadAll()
          return false
        } finally {
          inFlight.current--
          setBusy(false)
        }
      }),
    [enqueue, reloadAll],
  )

  const current = () => styleRef.current
  const revisionVersion = (id: string): { id: string; version: number } | null => {
    if (revisionVersionRef.current?.id === id) return revisionVersionRef.current
    const fromBom = bomRef.current?.revision.id === id ? bomRef.current.revision : null
    if (fromBom) return { id, version: fromBom.version }
    const listed = styleRef.current?.revisions.find((entry) => entry.id === id)
    return listed ? { id, version: listed.version } : null
  }

  const goToRevision = (id: string) => router.replace(hrefFor(tab, id))

  /** After a BOM write: the routing (its version moved) and the cost read again; and the other way round. */
  const afterBom = () => {
    if (!revisionId) return
    if (can.routingView) getRouting(api, styleId, revisionId).then(setRoutingValue).catch(() => undefined)
    if (can.costView) loadCost(revisionId)
  }
  const afterRouting = () => {
    if (!revisionId) return
    if (can.bomView) getBom(api, styleId, revisionId).then(setBomValue).catch(() => undefined)
    if (can.costView) loadCost(revisionId)
  }
  const bomWrite = (work: (target: { id: string; version: number }) => Promise<BomView>, done?: StyleNotice) =>
    run(async () => {
      const target = revisionId ? revisionVersion(revisionId) : null
      if (!target) return
      setBomValue(await work(target))
      afterBom()
    }, done)
  const routingWrite = (work: (target: { id: string; version: number }) => Promise<RoutingView>, done?: StyleNotice) =>
    run(async () => {
      const target = revisionId ? revisionVersion(revisionId) : null
      if (!target) return
      setRoutingValue(await work(target))
      afterRouting()
    }, done)

  const loadMaterial = (itemId: string) => {
    setMaterials((current) => (itemId in current ? current : { ...current, [itemId]: null }))
    getMaterial(api, itemId)
      .then((material) => setMaterials((current) => ({ ...current, [itemId]: material })))
      .catch(() => undefined)
  }
  const materialSeq = useRef(0)
  const onMaterialQuery = (query: string) => {
    const mine = ++materialSeq.current
    setMaterialSearch({ query, results: null, problem: null })
    findMaterials(api, query, companyId)
      .then((results) => mine === materialSeq.current && setMaterialSearch({ query, results, problem: null }))
      .catch((error: unknown) => mine === materialSeq.current && setMaterialSearch({ query, results: null, problem: readProblem(error) }))
  }
  const operationSeq = useRef(0)
  const onOperationQuery = (query: string, kind: string | null) => {
    const mine = ++operationSeq.current
    setOperationSearch({ query, kind, results: null, problem: null })
    findOperations(api, query, kind, companyId)
      .then((results) => mine === operationSeq.current && setOperationSearch({ query, kind, results, problem: null }))
      .catch((error: unknown) => mine === operationSeq.current && setOperationSearch({ query, kind, results: null, problem: readProblem(error) }))
  }

  const exportFile = (format: BomExportFormat) => {
    const style = styleRef.current
    const rev = style && revisionId ? style.revisions.find((entry) => entry.id === revisionId) : null
    if (!style || !rev || exporting) return
    setExporting(format)
    exportBom(api, style.id, rev.id, format, locale)
      .then((bytes) => {
        const type = format === 'pdf' ? 'application/pdf' : format === 'csv' ? 'text/csv;charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${style.code}-r${rev.revision}-bom.${format}`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      })
      .catch((error: unknown) => setNotice({ key: readProblem(error), tone: 'danger' }))
      .finally(() => setExporting(null))
  }

  const loadWorkshops = () => {
    if (!can.workshops) return
    listWorkshops(api)
      .then((workshops) => setLibraries((current) => ({ ...current, workshops })))
      .catch(() => setLibraries((current) => ({ ...current, workshops: [] })))
  }

  const model: StyleRecordViewModel = {
    prefix,
    tab,
    can,
    grains,
    companyId,
    style,
    revisionId,
    bom,
    routing,
    cost,
    costCompare,
    compliance,
    libraries,
    materials,
    materialSearch,
    operationSearch,
    bomView,
    costCell,
    save,
    dialog,
    busy,
    notice,
    changed,
    dockOpen,
    refused,
    duplicate: duplicate.model,
    bomImport: bomImport.model,
    exporting,
  }

  return (
    <StyleRecordView
      model={model}
      panels={value ? <RecordPanels record={{ type: 'Style', id: value.id, companyId: value.companyId, siteId: null }} title={`${value.code} · ${value.name}`} party={value.brand ? { id: value.brand.id, name: value.brand.name, emails: [] } : null} /> : null}
      actions={{
        onRetry: () => void loadStyle(),
        onReload: reloadAll,
        onDock: toggleDock,
        onDialog: (next) => {
          // A new material search starts empty (never the last dialog's results under an empty box).
          if (next?.kind === 'bomLine' && next.lineId === null) setMaterialSearch({ query: '', results: null, problem: null })
          setDialog(next)
        },
        onDismissNotice: () => setNotice(null),
        onRevision: goToRevision,
        onSaveIdentity: (patch) =>
          run(async () => {
            const style = current()
            if (style) setStyleValue(await updateStyle(api, style, patch))
          }, { key: 'notice.saved', tone: 'success' }),
        onSaveRange: (range) =>
          run(async () => {
            const style = current()
            if (!style) return
            setStyleValue(await updateStyle(api, style, { ...(range.sizeScaleId !== style.sizeScale.id ? { sizeScaleId: range.sizeScaleId } : {}), sizes: range.sizes, baseSize: range.baseSize }))
            loadParts(revisionId)
          }, { key: 'notice.rangeSaved', tone: 'success' }),
        onColourway: (input, colourwayId) =>
          run(async () => {
            const style = current()
            if (!style) return
            if (colourwayId === null) setStyleValue(await addColourway(api, style.id, input))
            else {
              const colourway = style.colourways.find((entry) => entry.id === colourwayId)
              if (!colourway) return
              const patch = { ...(input.code !== colourway.code && !colourway.inUse ? { code: input.code } : {}), name: input.name, colourId: input.colourId, description: input.description }
              setStyleValue(await updateColourway(api, style.id, colourway, patch))
            }
            loadParts(revisionId)
          }, { key: colourwayId === null ? 'notice.colourwayAdded' : 'notice.saved', tone: 'success' }),
        onColourwayStatus: (colourwayId, status) =>
          void run(async () => {
            const style = current()
            const colourway = style?.colourways.find((entry) => entry.id === colourwayId)
            if (!style || !colourway) return
            setStyleValue(await updateColourway(api, style.id, colourway, { status }))
            loadParts(revisionId)
          }, { key: status === 'ARCHIVED' ? 'notice.colourwayArchived' : 'notice.colourwayRestored', tone: 'success' }),
        onGenerate: () =>
          run(async () => {
            const style = current()
            if (!style) return
            const answer = await generateSkus(api, style.id, false)
            setStyleValue(answer.style)
            setNotice({ key: 'notice.generated', tone: 'success', params: { count: answer.skus.length } })
          }),
        onSkus: (changes) =>
          run(async () => {
            for (const change of changes) {
              const style = current()
              if (!style) return
              const { skuId, version: _version, ...patch } = change
              // Each SKU with the version the latest answer holds (a row toggle writes one after the other).
              const latest = style.skus.find((sku) => sku.id === skuId)
              setStyleValue(await updateSku(api, style.id, { id: skuId, version: latest?.version ?? change.version }, patch))
            }
          }, { key: 'notice.skusSaved', tone: 'success', params: { count: changes.length } }),
        onRelease: (changeNote) =>
          run(async () => {
            const style = current()
            const target = revisionId ? revisionVersion(revisionId) : null
            if (!style || !target) return
            setBomValue(await releaseRevision(api, style.id, target, changeNote || undefined))
            await loadStyle()
            loadParts(revisionId)
          }, { key: 'notice.released', tone: 'success', params: { revision: revision?.revision ?? 0 } }),
        onStartRevision: (changeNote) =>
          run(async () => {
            const style = current()
            if (!style) return
            const from = releasedOf(style.revisions) ?? [...style.revisions].sort((a, b) => b.revision - a.revision)[0] ?? null
            const nextId = from ? (await copyRevision(api, style.id, from.id, changeNote || undefined)).revision.id : (await startRevision(api, style.id, changeNote || undefined)).id
            await loadStyle()
            goToRevision(nextId)
          }, { key: 'notice.revisionStarted', tone: 'success' }),
        onAbandon: (reason) =>
          run(async () => {
            const style = current()
            const draft = style?.revisions.find((entry) => entry.status === 'DRAFT')
            const target = draft ? revisionVersion(draft.id) : null
            if (!style || !target) return
            await obsoleteRevision(api, style.id, target, reason || undefined)
            await loadStyle()
            const released = releasedOf(styleRef.current?.revisions ?? [])
            if (released) goToRevision(released.id)
          }, { key: 'notice.abandoned', tone: 'success' }),
        onArchive: (reason) =>
          run(async () => {
            const style = current()
            if (style) setStyleValue(await archiveStyle(api, style, reason || undefined))
          }, { key: 'notice.archived', tone: 'success' }),
        onReactivate: () =>
          void run(async () => {
            const style = current()
            if (style) setStyleValue(await reactivateStyle(api, style))
          }, { key: 'notice.reactivated', tone: 'success' }),
        onBomView: setBomView,
        onMaterialQuery,
        onLoadMaterial: loadMaterial,
        onAddLine: (input) => bomWrite((target) => addBomLine(api, styleId, target, input), { key: 'notice.lineAdded', tone: 'success' }),
        onEditLine: (lineId, input) => bomWrite((target) => updateBomLine(api, styleId, target, lineId, input), { key: 'notice.saved', tone: 'success' }),
        onRemoveLine: (lineId) => bomWrite((target) => removeBomLine(api, styleId, target, lineId), { key: 'notice.lineRemoved', tone: 'success' }),
        onLineSizes: (lineId, sizes) => void bomWrite((target) => setBomSizes(api, styleId, target, lineId, sizes)),
        onLineColours: (lineId, colours) => void bomWrite((target) => setBomColours(api, styleId, target, lineId, colours)),
        onHideYield: (pct) => bomWrite((target) => updateRevision(api, styleId, target, { plannedHideYieldPct: pct }), { key: 'notice.saved', tone: 'success' }),
        onOperationQuery,
        onSubcontract: (stepId, subcontract) => routingWrite((target) => updateStep(api, styleId, target, stepId, { subcontract }), { key: subcontract ? 'notice.subcontractSaved' : 'notice.inHouse', tone: 'success' }),
        onLoadWorkshops: loadWorkshops,
        onDuplicate: () => {
          const style = styleRef.current
          if (style) duplicate.open({ id: style.id, code: style.code, name: style.name })
        },
        duplicate: duplicate.actions,
        onImportBom: bomImport.open,
        bomImport: bomImport.actions,
        onExportBom: exportFile,
        onAddSteps: (operationIds) => routingWrite((target) => addSteps(api, styleId, target, operationIds), { key: 'notice.stepsAdded', tone: 'success', params: { count: operationIds.length } }),
        onStep: (stepId, patch) => routingWrite((target) => updateStep(api, styleId, target, stepId, patch)),
        onRemoveStep: (stepId) => routingWrite((target) => removeStep(api, styleId, target, stepId), { key: 'notice.stepRemoved', tone: 'success' }),
        onMoveStep: (stepId, delta) => {
          const steps = routingRef.current?.steps ?? []
          const index = steps.findIndex((step) => step.id === stepId)
          const to = index + delta
          if (index < 0 || to < 0 || to >= steps.length) return
          const order = steps.map((step) => step.id)
          ;[order[index], order[to]] = [order[to]!, order[index]!]
          void routingWrite((target) => reorderSteps(api, styleId, target, order))
        },
        onCostCell: setCostCell,
        onUpload: ({ kind, language, number, file }) =>
          run(async () => {
            if (!revisionId) return
            const sha256 = await sha256Of(file)
            const announced = await announceDocument(api, styleId, { revisionId, kind, language, number, originalName: file.name, contentType: 'application/pdf', sizeBytes: file.size, sha256 })
            await putToStore(announced.upload, file)
            await confirmDocument(api, styleId, announced.documentId, announced.fileId)
            setCompliance({ status: 'ready', value: await getCompliance(api, styleId, revisionId) })
          }, { key: 'notice.uploaded', tone: 'success' }),
        onDownload: (documentId, fileId) => {
          documentDownload(api, styleId, documentId, fileId)
            .then((download) => {
              const anchor = document.createElement('a')
              anchor.href = storeUrl(download.url)
              anchor.rel = 'noopener'
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
            })
            .catch((error: unknown) => setNotice({ key: readProblem(error), tone: 'danger' }))
        },
        onGarmentTracking: (tracking) =>
          run(async () => {
            const style = current()
            if (style) setStyleValue(await setGarmentTracking(api, style, tracking))
          }, { key: 'notice.trackingSaved', tone: 'success' }),
        onAssignLabel: (templateId) =>
          run(async () => {
            const target = revisionId ? revisionVersion(revisionId) : null
            if (!target) return
            await assignLabel(api, styleId, target, templateId)
            loadParts(revisionId)
            if (can.bomView && revisionId) setBomValue(await getBom(api, styleId, revisionId))
          }, { key: 'notice.labelNamed', tone: 'success' }),
      }}
    />
  )
}
