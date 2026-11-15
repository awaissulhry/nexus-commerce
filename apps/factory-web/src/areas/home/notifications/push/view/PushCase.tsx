'use client'

import type { PushModel } from '../model'
import { PushDialog } from './PushDialog'

/** A design-review case of SCR-547: the push pop-up on its made-up model. */
export function PushCase({ model }: { model: PushModel }) {
  return <PushDialog model={model} actions={{ onClose: () => undefined, onPreferences: () => undefined }} />
}
