'use client'

import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { DigestSection } from './DigestSection'
import { NAMESPACE } from './model'

/**
 * Today ⋯ "Daily digest by e-mail" (B-W2b-435; design home.today page.h "Daily digest by e-mail (W2b)"): the owner digest panel in
 * a dialog — my morning e-mail, its preview, Edit and Send me a test — the same container as Home › Reports' section. Esc closes;
 * focus returns to the opener (DS Modal).
 */
export function DigestDialog({ onClose }: { readonly onClose: () => void }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Dialog onClose={onClose} />
    </WithMessages>
  )
}

function Dialog({ onClose }: { readonly onClose: () => void }) {
  const t = useT(NAMESPACE)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('digest.dialog.title')}
      subtitle={t('digest.intro')}
      size="lg"
      footer={
        <Button size="sm" onClick={onClose}>
          {t('digest.dialog.close')}
        </Button>
      }
    >
      <DigestSection frame="plain" />
    </Modal>
  )
}
