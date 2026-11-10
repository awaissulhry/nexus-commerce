'use client'

import { WithMessages } from '../../../../../record-panels/i18n'
import { LibrarySwitch, type LibrarySwitchActions, type LibrarySwitchModel } from './LibrarySwitch'
import { PomsView, type PomsActions, type PomsViewModel } from './PomsView'
import { RulesView, type RulesActions, type RulesViewModel } from './RulesView'

export interface SizesDepthViewModel {
  switch: LibrarySwitchModel
  poms?: PomsViewModel
  rules?: RulesViewModel
}

export interface SizesDepthActions {
  switch?: LibrarySwitchActions
  poms?: PomsActions
  rules?: RulesActions
}

/**
 * SCR-345 — Sizes & measurements in depth (B-W2b-240): the page's view switch with Import, then the library it shows —
 * Points of measure or Grade rules (the size scales stay SCR-049's own view). It draws the view model and fetches nothing.
 */
export function SizesDepthView({ model, actions }: { model: SizesDepthViewModel; actions?: SizesDepthActions }) {
  return (
    <WithMessages namespaces={['products-sizes-depth', 'lists']}>
      <div className="fw-szd-page">
        <LibrarySwitch model={model.switch} actions={actions?.switch} />
        {model.switch.library === 'rules' && model.rules ? <RulesView model={model.rules} actions={actions?.rules} /> : model.poms ? <PomsView model={model.poms} actions={actions?.poms} /> : null}
      </div>
    </WithMessages>
  )
}
