'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { FileSearch, MoreHorizontal, SlidersHorizontal, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MultiSelect } from '@nexus/ui/components'
import { SectionLayout } from '@nexus/ui/patterns'
import { Button, Select, Tag } from '@nexus/ui/primitives'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ArrangeDialog } from '../../../quality/reports/view/ArrangeDialog'
import { isPageKey } from '../../../quality/_shared/hooks'
import { boardCsvRows, printAddress, rowsShown } from '../model'
import { CellModal } from './CellModal'
import { AllActionsDialog, EvidenceFinder, KeysDialog } from './dialogs'
import { OverrideModal } from './OverrideModal'
import { ActionsPanel, cellWord, ExpiryPanel, GatesPanel, KpiPanel, MatrixPanel } from './Panels'
import { STATUS_SECTIONS, type StatusActions, type StatusModel, type StatusSection } from './types'
import '../status.css'

export type { Read, StatusActions, StatusModel } from './types'

/**
 * SCR-119 — Compliance › Status board (design compliance.status; PRD-271, PRD-272, PRD-277; B-W2b-266): the band (as of, live,
 * "Show evidence for…" as the primary, Arrange, ⋯ Export board (CSV), Print board in a new tab (SCR-314), Keyboard shortcuts),
 * the scope (markets, brand, rows by styles — orders and lots held with the reason —, a gap filter as a chip), then the panels
 * in the person's order and widths: Readiness tiles (a tile filters the matrix or opens its list), Needs action (the top five
 * blockers with who can clear them and the Fix button; See all), Style × market (the list frame; a cell opens its checklist,
 * cs-cell), Gate refusals of the last 7 days (the list frame; Override… for the roles the requirement names, cs-override, after
 * a fresh code) and What expires next (12 months as chips with the ValidityBar). Each part reads and fails on its own.
 */
export function StatusView({ model, actions }: { model: StatusModel; actions?: StatusActions }) {
  return (
    <WithMessages namespaces={['compliance-status', 'quality-reports', 'quality']}>
      <Status model={model} actions={actions} />
    </WithMessages>
  )
}

function Status({ model, actions }: { model: StatusModel; actions?: StatusActions | undefined }) {
  const t = useT('compliance-status')
  const [keys, setKeys] = useState(model.keysOpen ?? false)
  const print = printAddress(model.prefix, model.address)
  const blocked = model.arranging || model.cell !== null || model.override !== null || model.finder || model.allActions !== null || keys

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || blocked) return
      if (event.key === 'e') {
        event.preventDefault()
        actions?.onFinder?.(true)
      } else if (event.key === 'a') {
        event.preventDefault()
        actions?.onArrange?.(true)
      } else if (event.key === 'p') {
        event.preventDefault()
        window.open(print, '_blank', 'noopener')
      } else if (event.key === '?') {
        event.preventDefault()
        setKeys(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, blocked, print])

  if (!model.can.view) {
    return (
      <div className="fw-cs">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const board = model.board.status === 'ready' ? model.board.value : null
  const exportBoard = () => {
    if (!board) return
    const codes = board.markets.map((market) => market.code)
    actions?.onExport?.('board', [t('csv.style'), t('csv.name'), t('csv.brand'), ...codes], boardCsvRows(rowsShown(board.rows, model.address.status), codes, (state, missing) => cellWord(t, state, missing)))
  }
  const panels: Record<StatusSection, ReactNode> = {
    kpi: <KpiPanel model={model} actions={actions} />,
    actions: <ActionsPanel model={model} actions={actions} />,
    matrix: <MatrixPanel model={model} actions={actions} />,
    gates: <GatesPanel model={model} actions={actions} />,
    expiry: <ExpiryPanel model={model} actions={actions} />,
  }
  const brandName = model.address.brandId ? (model.brands.find((brand) => brand.id === model.address.brandId)?.name ?? t('scope.thisBrand')) : null

  return (
    <div className="fw-cs">
      <div className="fw-cs-band" role="group" aria-label={t('band.label')}>
        <span className="fw-cs-status">
          {model.asOf ? <AsOf at={model.asOf} /> : <span className="fw-cs-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-cs-actions">
          <Button size="sm" variant="primary" onClick={() => actions?.onFinder?.(true)} aria-keyshortcuts="e">
            <FileSearch size={14} aria-hidden /> {t('band.evidence')}
          </Button>
          <Button size="sm" onClick={() => actions?.onArrange?.(true)} aria-keyshortcuts="a">
            <SlidersHorizontal size={14} aria-hidden /> {t('band.arrange')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'csv', label: t('band.csv'), onSelect: exportBoard, ...(board ? {} : { disabled: true, description: t('band.csvHeld') }) },
              { id: 'print', label: t('band.print'), href: print, target: '_blank' as const },
              { id: 'arrange', label: t('band.arrange'), onSelect: () => actions?.onArrange?.(true) },
              { id: 'keys', label: t('band.keys'), onSelect: () => setKeys(true) },
            ]}
          />
        </span>
      </div>

      {model.live === 'offline' ? <Banner tone="warning" title={t('offline.title')}>
          {t('offline.body')}
        </Banner> : null}
      {model.notice ? <Banner tone="success" title={t(model.notice.key, model.notice.params)} onDismiss={() => actions?.onDismissNotice?.()} /> : null}

      <div className="fw-cs-scope" role="group" aria-label={t('scope.label')}>
        <MultiSelect
          size="sm"
          options={model.knownMarkets.map((market) => ({ value: market.code, label: `${market.code} · ${market.name}` }))}
          value={model.address.markets}
          onChange={(next) => actions?.onAddress?.({ markets: next })}
          ariaLabel={t('scope.markets')}
          placeholder={t('scope.marketsAll')}
          formatLabel={(value) => (value.length === 0 ? t('scope.marketsAll') : t('scope.marketsChosen', { count: value.length, codes: value.join(', ') }))}
        />
        <Select size="sm" aria-label={t('scope.brand')} value={model.address.brandId ?? ''} onChange={(event) => actions?.onAddress?.({ brandId: event.target.value || null })}>
          <option value="">{t('scope.allBrands')}</option>
          {model.address.brandId && !model.brands.some((brand) => brand.id === model.address.brandId) ? <option value={model.address.brandId}>{brandName}</option> : null}
          {model.brands.map((brand) => (
            <option key={brand.id} value={brand.id}>{`${brand.code} · ${brand.name}`}</option>
          ))}
        </Select>
        <Select size="sm" aria-label={t('scope.rows')} value="styles" onChange={() => undefined}>
          <option value="styles">{t('scope.rowsStyles')}</option>
          <option value="orders" disabled>
            {t('scope.rowsOrders')}
          </option>
          <option value="lots" disabled>
            {t('scope.rowsLots')}
          </option>
        </Select>
        {model.address.gap ? (
          <span className="fw-cs-chip-filter">
            <Tag tone="info">{t('scope.gapChip', { gap: t(`gap.${model.address.gap}`) })}</Tag>
            <Button size="sm" variant="quiet" aria-label={t('scope.gapClear')} onClick={() => actions?.onAddress?.({ gap: null })}>
              <X size={13} aria-hidden />
            </Button>
          </span>
        ) : null}
        <span className="fw-cs-hint">{t('scope.every')}</span>
        {brandName ? <span className="fw-cs-hint">{t('scope.brandOnly', { brand: brandName })}</span> : null}
      </div>

      <SectionLayout sections={model.specs} value={model.layout} onChange={() => undefined} className="fw-cs-sections">
        {Object.fromEntries(STATUS_SECTIONS.map((id) => [id, panels[id]]))}
      </SectionLayout>

      <CellModal model={model} actions={actions} />
      <OverrideModal model={model} actions={actions} />
      <AllActionsDialog model={model} actions={actions} />
      <EvidenceFinder model={model} actions={actions} />
      {model.arranging && <ArrangeDialog specs={model.specs.map((spec) => ({ ...spec, label: t(`section.${spec.id}`) }))} layout={model.layout} onApply={(next) => actions?.onArranged?.(next)} onClose={() => actions?.onArrange?.(false)} />}
      {keys && <KeysDialog onClose={() => setKeys(false)} />}
    </div>
  )
}
