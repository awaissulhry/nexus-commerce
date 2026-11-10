import { createElement, useEffect, useState } from 'react'
import { useT } from '../../../../../../lib/i18n/provider'
import { inShell, PREFIX, type RoleCase } from '../../../../../quality/_shared/fixtures'
import { LOT_TILES } from '../../../model'
import type { DeclarationsViewModel } from '../../../declarations/view-model'
import { DeclarationsView } from '../../../declarations/view/DeclarationsView'
import { ProfileCardView, type ProfileCardModel } from '../../../profiles/card/view/ProfileCardView'
import { ProfilesView, type ProfilesViewModel } from '../../../profiles/view/ProfilesView'
import type { SubstancesViewModel } from '../../view-model'
import { SubstancesView } from '../../view/SubstancesView'
import { DepthMessages, useDepthMetrics, ViewSwitch } from '../../frame/parts'
import type { DepthCounts, DepthTile, PageFrame, TestsView } from '../../frame/views'

/**
 * The design review's wrappers of B-W2b-267's views (local `/design` only; a fixtures file so only fixtures and tests import
 * it): the Office shell around the page, the page's frame with made-up tile counts, and a selection the reviewer can change
 * (ticks, the header box, shift-click, x). No data is read: every model is made up (`../fixtures.ts`). It exports no
 * `designScreen`: the screens are the folders' own fixtures.
 */

const LOT_COUNTS: Record<(typeof LOT_TILES)[number], number> = { onHold: 4, waiting: 2, failed: 1, released: 18 }
export const DEMO_TILE_COUNTS: DepthCounts = { declarationsOverdue: 1, profilesIncomplete: 2, rerequest: 1 }

/** The frame as a page would draw it: W1's four lot tiles, the three W2b tiles, the view switch. */
export function useDemoFrame(view: TestsView, active: DepthTile | null = null, counts: DepthCounts = DEMO_TILE_COUNTS, withDepth = true, withLots = true): PageFrame {
  const t = useT('lab')
  const depth = useDepthMetrics(counts, active, () => undefined)
  const lots = withLots ? LOT_TILES.map((id) => ({ label: t(`tile.${id}`), value: String(LOT_COUNTS[id]), hint: t(`tile.${id}Hint`, { max: 200 }), active: false, onClick: () => undefined })) : []
  return { tiles: [...lots, ...(withDepth ? depth : [])], switcher: createElement(ViewSwitch, { prefix: PREFIX, view }) }
}

/** A role's frame: the W2b tiles need compliance.certificates.view, the lot tiles quality.lots.view. */
const FRAME_OF: Readonly<Record<RoleCase, { depth: boolean; lots: boolean }>> = {
  owner: { depth: true, lots: true },
  inspector: { depth: true, lots: true },
  production: { depth: true, lots: false },
  readOnly: { depth: true, lots: true },
  sales: { depth: false, lots: false },
  warehouse: { depth: false, lots: true },
  supervisor: { depth: false, lots: false },
}

function useSelection(initial: readonly string[]) {
  const [selected, setSelected] = useState<readonly string[]>(initial)
  useEffect(() => setSelected(initial), [initial])
  return [selected, setSelected] as const
}

export interface DeclarationsCase {
  readonly model: Omit<DeclarationsViewModel, 'frame'>
  readonly role: RoleCase
  readonly active?: DepthTile | null
}

function DeclarationsInner({ value }: { value: DeclarationsCase }) {
  const frameOf = FRAME_OF[value.role]
  const frame = useDemoFrame('declarations', value.active ?? null, DEMO_TILE_COUNTS, frameOf.depth, frameOf.lots)
  const [selected, setSelected] = useSelection(value.model.selected)
  return createElement(DeclarationsView, { model: { ...value.model, frame, selected }, actions: { onSelect: (ids: readonly string[]) => setSelected([...ids]) } })
}

export function DeclarationsDesign({ model }: { model: DeclarationsCase }) {
  return inShell('/compliance/tests', createElement(DepthMessages, null, createElement(DeclarationsInner, { value: model })), model.role)
}

export interface ProfilesCase {
  readonly model: Omit<ProfilesViewModel, 'frame'>
  readonly role: RoleCase
  readonly active?: DepthTile | null
}

function ProfilesInner({ value }: { value: ProfilesCase }) {
  const frameOf = FRAME_OF[value.role]
  const frame = useDemoFrame('profiles', value.active ?? null, DEMO_TILE_COUNTS, frameOf.depth, frameOf.lots)
  const [selected, setSelected] = useSelection(value.model.selected)
  return createElement(ProfilesView, { model: { ...value.model, frame, selected }, actions: { onSelect: (ids: readonly string[]) => setSelected([...ids]) } })
}

export function ProfilesDesign({ model }: { model: ProfilesCase }) {
  return inShell('/compliance/tests', createElement(DepthMessages, null, createElement(ProfilesInner, { value: model })), model.role)
}

export interface SubstancesCase {
  readonly model: Omit<SubstancesViewModel, 'frame'>
  readonly role: RoleCase
}

function SubstancesInner({ value }: { value: SubstancesCase }) {
  const frameOf = FRAME_OF[value.role]
  const frame = useDemoFrame('substances', null, DEMO_TILE_COUNTS, frameOf.depth, frameOf.lots)
  const [selected, setSelected] = useSelection(value.model.selected)
  return createElement(SubstancesView, { model: { ...value.model, frame, selected }, actions: { onSelect: (ids: readonly string[]) => setSelected([...ids]) } })
}

export function SubstancesDesign({ model }: { model: SubstancesCase }) {
  return inShell('/compliance/tests', createElement(DepthMessages, null, createElement(SubstancesInner, { value: model })), model.role)
}

export interface ProfileCardCase {
  readonly model: ProfileCardModel
}

/** The card alone, as the material record's Compliance tab draws it (the record's own cases are SCR-048). */
export function ProfileCardDesign({ model }: { model: ProfileCardCase }) {
  return createElement('div', { className: 'fw-q' }, createElement(ProfileCardView, { model: model.model }))
}
