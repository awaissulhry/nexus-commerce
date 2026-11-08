'use client'

import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { LiveState } from '../../../_shared/hooks'
import { TIME_ZONE } from '../../../_shared/model'
import { NoPlantAccess, PlantMessages, type Loaded } from '../../../_shared/parts'
import type { WallAnswer } from '../../depth/api'
import type { WallFilter } from '../../depth/model'
import { DepthMessages, useDepthWords } from '../../depth/parts'
import { StatusWall } from '../../depth/view/StatusWall'

/** SCR-150-wall — the status wall's own tab: one view model, nothing fetched. */
export interface WallTabModel {
  readonly prefix: string
  readonly canView: boolean
  /** The site the wall shows (its code), or null: every site the person sees. */
  readonly siteCode: string | null
  readonly loaded: Loaded<WallAnswer>
  readonly filter: WallFilter
  readonly live: LiveState
  readonly asOf: string | null
}

export interface WallTabActions {
  readonly onFilter?: (filter: WallFilter) => void
  readonly onRetry?: () => void
}

/**
 * Plant › Machines & tools › Status wall (design plant.machines tab:wall, "left open on an office screen; live, read-only"):
 * every machine in use as a tile by line, coloured by its live status and saying it, filtered by status; a tile opens the
 * machine in another tab so the wall stays. No person, no money.
 */
export function WallTabView({ model, actions }: { model: WallTabModel; actions?: WallTabActions }) {
  return (
    <PlantMessages>
      <DepthMessages>
        <WallTab model={model} actions={actions} />
      </DepthMessages>
    </PlantMessages>
  )
}

function WallTab({ model, actions }: { model: WallTabModel; actions?: WallTabActions | undefined }) {
  const t = useDepthWords()
  const locale = useLocale()
  if (!model.canView) {
    return (
      <main className="fw-md-window">
        <NoPlantAccess />
      </main>
    )
  }
  const value = model.loaded.status === 'ready' ? model.loaded.value : null
  return (
    <main className="fw-md-window">
      <header className="fw-md-head">
        <h1 className="fw-md-h3">{model.siteCode ? t('wall.tabTitleSite', { site: model.siteCode }) : t('wall.tabTitle')}</h1>
        {value && <span className="fw-md-muted">{t('wall.readAt', { time: formatDateTime(value.at, { locale, timeZone: TIME_ZONE }) })}</span>}
      </header>
      <StatusWall loaded={model.loaded} filter={model.filter} prefix={model.prefix} live={model.live} asOf={model.asOf} newTab onFilter={actions?.onFilter} onRetry={actions?.onRetry} />
    </main>
  )
}
