'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Plus, ShieldPlus } from 'lucide-react'
import { Banner, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { AsOf, DetailModal } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { isListKey } from '../../../../list-frame/model'
import { localName, planPrintHref, roleSheetsHref, sheetsOf, tileAction, tilesOf, type TileId } from '../model'
import type { RiskPageActions, RiskPageModel } from '../view-model'
import '../risk.css'
import { MeasureDialog, MoveDialog } from './MeasureParts'
import { InForcePill, KeysModal, NoRiskAccess, RISK_NAMESPACES, useWords } from './parts'
import { AssessmentsSection, MeasuresSection, RolesSection } from './Sections'
import { NewSheetDialog, SheetButtons, SheetCard } from './SheetCard'
import { VersionDialog } from './VersionDialog'

export type { RiskPageActions, RiskPageModel } from '../view-model'

/**
 * SCR-209 — Plant › Health & safety › Risk assessment (design plant.risk; QHS-230, QHS-234, QHS-236; D.Lgs. 81/2008 artt.
 * 28-29): the band (when it was read, the version in force of the top bar's site; Add measure `c`, New DVR version; ⋯ Print
 * role sheets, the improvement plan, Inspector pack (Later), Export, the keys), the tiles ("what the assessment still owes":
 * each filters its section), Assessments, the Improvement plan and the Role sheets, each section loading and failing on its
 * own; the dialogs and a role sheet's window open from the address. One view model, nothing fetched. The page fills the main
 * area (no max-width); every word from the catalogues; every held button says why.
 */
export function RiskPageView({ model, actions }: { model: RiskPageModel; actions?: RiskPageActions }) {
  return (
    <WithMessages namespaces={RISK_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: RiskPageModel; actions?: RiskPageActions | undefined }) {
  const t = useWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const [heldSaid, setHeldSaid] = useState(false)
  const dvrsRef = useRef<HTMLElement | null>(null)
  const measuresRef = useRef<HTMLElement | null>(null)
  const rolesRef = useRef<HTMLElement | null>(null)
  const { address, can } = model
  const dialogOpen = !!address.add || !!address.sheet || !!model.move || keysOpen
  const assessments = model.assessments.status === 'ready' ? model.assessments.value.assessments : null
  const measureHeld = !can.manage ? t('held.manage') : !model.companyId ? t('held.company') : assessments && assessments.length === 0 ? t('held.noAssessment') : null
  const versionHeld = !can.manage ? t('held.manage') : !model.companyId ? t('held.company') : !can.upload ? t('held.upload') : null

  const goTo = (ref: { current: HTMLElement | null }) => {
    const section = ref.current
    if (!section) return
    section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }

  // c adds a measure, ? the keys (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'c') {
        event.preventDefault()
        if (measureHeld) setHeldSaid(true)
        else actions?.onAddress?.({ add: 'measure' })
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        setKeysOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!can.view) {
    return (
      <div className="fw-rk">
        <NoRiskAccess />
      </div>
    )
  }

  const counts = model.counts.status === 'ready' ? model.counts.value : null
  const tileClick = (id: TileId) => {
    const action = tileAction(id)
    if ('view' in action) {
      actions?.onAddress?.({ view: model.address.view === action.view ? 'open' : action.view })
      goTo(measuresRef)
    } else {
      actions?.onAddress?.({ tile: model.address.tile === action.tile ? null : action.tile })
      goTo(action.tile === 'roles' ? rolesRef : dvrsRef)
    }
  }
  const metrics: Metric[] = tilesOf(counts).map((tile): Metric => {
    const action = tileAction(tile.id)
    return {
      label: t(`tile.${tile.id}.label`),
      value: tile.value === null ? model.counts.status === 'loading' ? <Skeleton width={40} height={24} /> : '—' : String(tile.value),
      hint: t(`tile.${tile.id}.hint`),
      onClick: () => tileClick(tile.id),
      active: 'view' in action ? address.view === action.view : address.tile === action.tile,
      ...(tile.tone ? { accent: tile.tone === 'danger' ? 'var(--nds-danger)' : 'var(--nds-warning)' } : {}),
    }
  })
  const siteAssessment = model.scope.site && assessments ? (assessments.find((row) => row.siteId === model.scope.site!.id) ?? null) : null
  const sheetIds = model.sheets.status === 'ready' ? sheetsOf(model.sheets.value.roleSheets, null).map((row) => row.id) : []
  const notice = model.notice

  return (
    <div className="fw-rk">
      <div className="fw-rk-band" role="group" aria-label={t('band.label')}>
        <span className="fw-rk-status">
          {model.readAt ? <AsOf at={model.readAt} /> : <span className="fw-rk-muted">{t('band.reading')}</span>}
          {model.scope.site && assessments ? siteAssessment ? <InForcePill version={siteAssessment.inForce} /> : <span className="fw-rk-muted">{t('band.noAssessment')}</span> : null}
        </span>
        <span className="fw-rk-actions">
          <Button size="sm" aria-keyshortcuts="c" heldReason={measureHeld} onClick={() => actions?.onAddress?.({ add: 'measure' })}>
            <Plus size={14} aria-hidden /> {t('band.addMeasure')}
          </Button>
          <Button size="sm" variant="primary" heldReason={versionHeld} onClick={() => actions?.onAddress?.({ add: 'version', assessment: siteAssessment?.id ?? null })}>
            <ShieldPlus size={14} aria-hidden /> {t('band.newVersion')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'sheets', label: t('band.printSheets'), description: t('band.printSheetsHint'), disabled: sheetIds.length === 0, onSelect: () => window.open(roleSheetsHref(model.prefix, sheetIds), '_blank', 'noopener') },
              { id: 'plan', label: t('band.printPlan'), description: t('band.printPlanHint'), onSelect: () => window.open(planPrintHref(model.prefix, { assessments: (assessments ?? []).map((row) => row.id) }), '_blank', 'noopener') },
              { id: 'pack', label: t('band.inspectorPack'), description: t('band.inspectorPackLater'), disabled: true },
              { id: 'export', label: t('band.export'), description: t('band.exportHint'), disabled: true },
              { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
            ]}
          />
        </span>
      </div>

      {heldSaid && measureHeld && (
        <Banner
          tone="info"
          title={measureHeld}
          action={
            <Button size="sm" variant="quiet" onClick={() => setHeldSaid(false)}>
              {t('common.close')}
            </Button>
          }
        />
      )}
      {notice && (
        <Banner
          tone={notice.tone}
          title={t(notice.key, notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.close')}
            </Button>
          }
        />
      )}

      <section className="fw-rk-section" aria-labelledby="fw-rk-tiles">
        <h2 id="fw-rk-tiles" className="fw-rk-vh">
          {t('tile.title')}
        </h2>
        <MetricStrip metrics={metrics} minTileWidth={190} />
        {model.counts.status === 'loading' && <span className="fw-rk-slow">{t('common.stillLoading')}</span>}
        {model.counts.status === 'error' && (
          <Banner
            tone="warning"
            title={t('tile.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetryCounts?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(model.counts.problem)}
          </Banner>
        )}
      </section>

      <section ref={dvrsRef} className="fw-rk-section fw-rk-anchor" aria-labelledby="fw-rk-dvrs">
        <AssessmentsSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>
      <section ref={measuresRef} className="fw-rk-section fw-rk-anchor" aria-labelledby="fw-rk-measures">
        <MeasuresSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>
      <section ref={rolesRef} className="fw-rk-section fw-rk-anchor" aria-labelledby="fw-rk-roles">
        <RolesSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      {model.measure && <MeasureDialog frame={model} state={model.measure} assessments={assessments} actions={actions} />}
      {model.move && <MoveDialog state={model.move} actions={actions} />}
      {model.version && <VersionDialog frame={model} state={model.version} assessments={assessments} fixed={false} actions={actions} />}
      {model.sheet && <SheetWindow model={model} actions={actions} />}
      {model.newSheet && <NewSheetDialog frame={model} state={model.newSheet} sites={model.scope.sites.map((site) => ({ id: site.id, name: site.name }))} actions={actions} />}
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}

/** A role sheet from the index (design: "Row opens the sheet"): its form card in a DetailModal, J / K over the index's rows. */
function SheetWindow({ model, actions }: { model: RiskPageModel; actions?: RiskPageActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const state = model.sheet!
  const rows = model.sheets.status === 'ready' ? sheetsOf(model.sheets.value.roleSheets, model.address.tile) : null
  const ids = useMemo(() => (rows ? rows.map((row) => row.id) : []), [rows])
  const sheet = state.read.status === 'ready' ? state.read.value.roleSheet : null
  return (
    <DetailModal
      open
      onClose={() => actions?.onAddress?.({ sheet: null })}
      title={sheet ? localName(sheet, locale) : t('sheet.noun')}
      subtitle={sheet ? `${sheet.code} · ${sheet.site.name}` : undefined}
      actions={sheet && state.mode === 'view' ? <SheetButtons frame={model} sheet={sheet} actions={actions} /> : undefined}
      nav={ids.includes(state.id) && state.mode === 'view' ? { ids, current: state.id, onGo: (id) => actions?.onAddress?.({ sheet: id }), noun: t('sheet.noun') } : undefined}
      loading={state.read.status === 'loading'}
      error={state.read.status === 'error' ? t(state.read.problem) : undefined}
      onRetry={actions?.onSheetRetry}
    >
      {state.read.status === 'ready' && <SheetCard frame={model} state={state} actions={actions} chrome="bare" />}
    </DetailModal>
  )
}
