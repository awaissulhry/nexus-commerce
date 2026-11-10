'use client'

import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { VERSIONS_NS } from '../../release/model'
import type { VersionsActions, VersionsModel } from '../model'
import { CompareBody } from './CompareBody'
import '../versions.css'

/**
 * Compare revisions (design products.styles pop:styles.compare, opened from the Versions tab and the band's ⋯): the same
 * compare as the tab's, in a wide pop-up over any tab. Esc closes; focus returns to the opener (the DS Modal).
 */
export function CompareDialog({ model, actions }: { model: VersionsModel; actions?: VersionsActions }) {
  const tv = useT(VERSIONS_NS)
  const close = () => actions?.onCompareClose?.()
  return (
    <Modal open onClose={close} size="xl" title={tv('cmp.title')} footer={<Button onClick={close}>{tv('base.close')}</Button>}>
      <div className="fw-st-dialog">
        <CompareBody model={model} actions={actions} />
      </div>
    </Modal>
  )
}
