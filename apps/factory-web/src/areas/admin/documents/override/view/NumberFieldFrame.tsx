'use client'

import { Card } from '@nexus/ui/components'
import type { NumberFieldModel } from '../model'
import { DocumentNumberLine } from './DocumentNumberLine'

/**
 * The number line as a create dialog shows it, alone in a card (the design cases of SCR-014-override; in the Office it sits
 * in a document's create dialog: New purchase order, SCR-058). The popup opens over it.
 */
export function NumberFieldFrame({ model }: { model: NumberFieldModel }) {
  return (
    <Card padded>
      <DocumentNumberLine model={model} />
    </Card>
  )
}
