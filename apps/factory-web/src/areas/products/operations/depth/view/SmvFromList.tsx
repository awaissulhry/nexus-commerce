'use client'

import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { Notice } from '../../../library/model'
import type { MinutesActions, MinutesModel } from '../model'
import { ProposeDialog } from './ProposeDialog'
import '../depth.css'

/**
 * Propose SMV change opened from the list's SMV cell or a row's ⋯ (B-W2b-235; design operations.grid "from W2b an SMV change
 * that feeds piece rates opens 'Propose SMV change' instead"): while the operation's minutes are read, the dialog says so;
 * a failed read says why with Try again; then the same dialog as the record's. After Send, the list says what was sent.
 * It fetches nothing.
 */
export function SmvFromList({ model, notice, actions, onClose, onDismissNotice }: { model: MinutesModel | null; notice?: Notice | null; actions?: MinutesActions; onClose?: () => void; onDismissNotice?: () => void }) {
  const t = useT('products-operations-depth')
  const tl = useT('library')
  return (
    <>
      {notice && (
        <Banner
          tone={notice.tone}
          title={notice.key.startsWith('problem.') ? tl(notice.key, notice.params) : t(notice.key, notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={onDismissNotice}>
              {tl('common.dismiss')}
            </Button>
          }
        />
      )}
      {model && model.part.status === 'ready' && <ProposeDialog view={model.part.value} model={{ ...model, dialog: { kind: 'propose' } }} actions={{ ...actions, onDialog: (next) => (next ? actions?.onDialog?.(next) : onClose?.()) }} />}
      {model && model.part.status !== 'ready' && (
        <Modal open onClose={() => onClose?.()} size="sm" title={t('propose.titleLoading')} footer={<Button onClick={() => onClose?.()}>{tl('common.back')}</Button>}>
          {model.part.status === 'error' ? (
            <Banner tone="danger" title={t('minutes.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{tl('common.retry')}</Button>}>
              {tl(model.part.problem)}
            </Banner>
          ) : (
            <p className="fw-opd-hint" role="status">
              <Spinner size={14} /> {t('minutes.loading')}
            </p>
          )}
        </Modal>
      )}
    </>
  )
}
