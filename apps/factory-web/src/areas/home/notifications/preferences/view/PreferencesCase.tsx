'use client'

import type { PreferencesModel } from '../model'
import { PreferencesDialog } from './PreferencesDialog'

/** A design-review case of SCR-546: the preferences pop-up on its made-up model (the admin's case opens on Role defaults). */
export function PreferencesCase({ model }: { model: PreferencesModel & { tab?: 'roles' } }) {
  return <PreferencesDialog model={model} actions={{ onClose: () => undefined }} initialTab={model.tab ?? 'mine'} />
}
