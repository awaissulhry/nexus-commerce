'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Select, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { Combobox, EditModeBar } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import type { DefaultRow, SitePlaces } from '../api'
import {
  addableKinds,
  auditHref,
  cellKey,
  cellOptions,
  cellValue,
  DEFAULT_PURPOSES,
  defaultChanges,
  defaultKindsOf,
  defaultsHeld,
  fallbackFor,
  kindsServing,
  locationsHref,
  NONE_VALUE,
  savedCell,
  siteOf,
  sitesOfScope,
  type DefaultPurpose,
  type HeldItemKind,
} from '../model'
import type { WarehouseSettingsActions, WarehouseSettingsModel } from '../view-model'
import { CardDescription, CardFailed, NS, ViewOnly } from './parts'

/** The words of a place: "BIN-A1 · Rack A, bin 1". */
const placeWords = (place: { readonly code: string; readonly name: string }) => `${place.code} · ${place.name}`

/**
 * sec:ws-defaults — Default locations (SCM-179; B-W2b-289's API): per site, a small table of kind of material × purpose
 * (receiving, quality, issue, return, put-away) → the place a command takes when nobody names one (DS Combobox; only places
 * whose kind may serve the purpose and hold the goods). The first row is the site's fallback for every kind without its own;
 * a kind is added as a row. A cell left empty follows the fallback where it may hold the goods, else the command's own rule.
 * EditModeBar, ⌘S: one write per changed cell at the version read.
 */
export function DefaultsCard({ model, actions, shortcut }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions; shortcut: boolean }) {
  const t = useT(NS)
  const sites = model.sites?.value ? sitesOfScope(model.sites.value, model.address.scope, model.companyId) : null
  const site = sites ? siteOf(sites, model.address) : null
  const defaults = model.defaults?.value ?? null
  const may = model.can.locationsManage
  const held = defaultsHeld({ may, offline: model.live === 'offline', busy: model.busy !== null })

  const body = (): ReactNode => {
    if (!model.sites) return <p className="fw-whs-held">{t('held.noLocationsView')}</p>
    if (model.sites.problem) return <CardFailed title={t('defaults.failed')} problem={model.sites.problem} onRetry={actions?.onRetrySites} />
    if (!sites) return <Skeleton height={320} />
    if (!site) return <EmptyState title={t('defaults.noSite.title')} description={t('defaults.noSite.body')} />
    const picker =
      sites.length > 1 ? (
        sites.length <= 4 ? (
          <SegmentedControl size="sm" ariaLabel={t('defaults.site')} value={site.id} onChange={(value) => actions?.onSite?.(value)} options={sites.map((entry) => ({ value: entry.id, label: entry.code }))} />
        ) : (
          <Select size="sm" aria-label={t('defaults.site')} value={site.id} onChange={(event) => actions?.onSite?.(event.target.value)}>
            {sites.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {placeWords(entry)}
              </option>
            ))}
          </Select>
        )
      ) : null
    const table = (): ReactNode => {
      if (!model.defaults) return null
      if (model.defaults.problem) return <CardFailed title={t('defaults.failed')} problem={model.defaults.problem} onRetry={actions?.onRetryDefaults} />
      if (!defaults) return <Skeleton height={240} />
      return <DefaultsTable model={model} actions={actions} site={site} defaults={defaults} editable={may && model.busy === null && model.live !== 'offline'} />
    }
    const changes = defaults ? defaultChanges(defaults, model.defaultsDraft).length : 0
    return (
      <div className="fw-whs-stack">
        <div className="fw-whs-inforce-row">
          <span className="fw-whs-sub">{t('defaults.siteOf', { site: placeWords(site) })}</span>
          {picker}
        </div>
        {!may && <p className="fw-whs-held">{t('held.noLocationsRight')}</p>}
        {may && model.live === 'offline' && <p className="fw-whs-held">{t('held.offline')}</p>}
        {table()}
        <ul className="fw-whs-notes">
          <li>{t('defaults.noteOrder')}</li>
          <li>{t('defaults.noteKinds')}</li>
          <li>
            {t('defaults.notePlaces')}{' '}
            <Link className="fw-whs-link" href={locationsHref(model.prefix)}>
              {t('defaults.locationsLink')} <ExternalLink size={12} aria-hidden />
            </Link>
          </li>
        </ul>
        {changes > 0 && (
          <EditModeBar
            count={changes}
            busy={model.busy === 'defaults'}
            applyHeldReason={held && held !== 'held.busy' ? t(held) : null}
            applyLabel={t('common.save')}
            onDiscard={() => actions?.onDiscard?.('defaults')}
            onApply={() => actions?.onApply?.('defaults')}
            saveShortcut={shortcut}
          />
        )}
      </div>
    )
  }

  return (
    <Card
      header={t('defaults.title')}
      description={<CardDescription text={t('defaults.description')} changed={defaults ? model.changed.defaults : undefined} href={model.can.audit && defaults && defaults.length > 0 ? auditHref(model.prefix, 'DefaultLocation') : null} />}
      headerAction={model.sites && !may ? <ViewOnly reason={t('held.noLocationsRight')} /> : undefined}
      headingLevel={2}
      className="fw-whs-card fw-whs-wide"
    >
      {body()}
    </Card>
  )
}

/** The table: the kinds as rows (the fallback first), the purposes as columns, a place per cell. */
function DefaultsTable({ model, actions, site, defaults, editable }: { model: WarehouseSettingsModel; actions?: WarehouseSettingsActions; site: SitePlaces; defaults: readonly DefaultRow[]; editable: boolean }) {
  const t = useT(NS)
  const kinds = defaultKindsOf(defaults, model.defaultsDraft, model.addedKinds)
  const addable = addableKinds(kinds)
  const kindWords = (kind: HeldItemKind | null) => (kind ? t(`itemKind.${kind}`) : t('defaults.everyKind'))

  const cell = (purpose: DefaultPurpose, kind: HeldItemKind | null): ReactNode => {
    const key = cellKey(purpose, kind)
    const value = cellValue(defaults, model.defaultsDraft, purpose, kind)
    const options = cellOptions(site, purpose, kind)
    const saved = savedCell(defaults, purpose, kind)
    const place = value ? (site.locations.find((entry) => entry.id === value) ?? (saved?.location.id === value ? saved.location : null)) : null
    const typed = key in model.defaultsDraft && (model.defaultsDraft[key] ?? null) !== (saved?.location.id ?? null)
    const fallback = kind && !value ? fallbackFor(defaults, model.defaultsDraft, site, purpose, kind) : null
    const empty = (): string => {
      if (fallback) return t('defaults.usesFallback', { place: fallback.code })
      return t(`defaults.ownRule.${purpose}`)
    }
    const labelId = `whs-cell-${purpose}-${kind ?? 'all'}`
    return (
      <td key={purpose} className={typed ? 'fw-whs-cellbox typed' : 'fw-whs-cellbox'} data-label={t(`purpose.${purpose}`)}>
        <span id={labelId} hidden>
          {t('defaults.cellLabel', { purpose: t(`purpose.${purpose}`), kind: kindWords(kind) })}
        </span>
        {editable && options.length > 0 ? (
          <Combobox
            options={[{ value: NONE_VALUE, label: t('defaults.none') }, ...options.map((option) => ({ value: option.id, label: placeWords(option) }))]}
            value={value ?? NONE_VALUE}
            placeholder={t('defaults.pick')}
            labelledBy={labelId}
            onChange={(next) => actions?.onCell?.(key, next === NONE_VALUE || !next ? null : next)}
          />
        ) : (
          <span className="fw-whs-value">{place ? placeWords(place) : '—'}</span>
        )}
        {place && place.status !== 'ACTIVE' && <span className="fw-whs-warn small">{t('defaults.archivedPlace')}</span>}
        {!value && <span className="fw-whs-sub">{empty()}</span>}
        {editable && options.length === 0 && <span className="fw-whs-sub">{t('defaults.noneServes', { kinds: kindsServing(purpose).map((entry) => t(`locationKind.${entry}`)).join(', ') })}</span>}
      </td>
    )
  }

  return (
    <div className="fw-whs-stack">
      <div className="fw-whs-tablewrap">
        <table className="fw-whs-table">
          <caption className="fw-whs-caption">{t('defaults.caption', { site: site.code })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('defaults.kindColumn')}</th>
              {DEFAULT_PURPOSES.map((purpose) => (
                <th key={purpose} scope="col">
                  <span className="fw-whs-cell">
                    <span>{t(`purpose.${purpose}`)}</span>
                    <span className="fw-whs-sub">{t(`purposeHint.${purpose}`)}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kinds.map((kind) => (
              <tr key={kind ?? '*'}>
                <th scope="row">
                  <span className="fw-whs-cell">
                    <strong>{kindWords(kind)}</strong>
                    {kind === null && <span className="fw-whs-sub">{t('defaults.everyKindHint')}</span>}
                  </span>
                </th>
                {DEFAULT_PURPOSES.map((purpose) => cell(purpose, kind))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && addable.length > 0 && (
        <span className="fw-whs-add">
          <Select size="sm" aria-label={t('defaults.addKind')} value="" onChange={(event) => event.target.value && actions?.onAddKind?.(event.target.value as HeldItemKind)}>
            <option value="">{t('defaults.addKind')}</option>
            {addable.map((kind) => (
              <option key={kind} value={kind}>
                {t(`itemKind.${kind}`)}
              </option>
            ))}
          </Select>
        </span>
      )}
    </div>
  )
}
