'use client'

import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import { DockedStage } from '../../../lib/record-thread/parts/DockedStage'
import { WithMessages } from '../../i18n'
import { SHARES_NS, type SharesPanelModel } from '../model'
import { SharesWindow } from './SharesWindow'

/** A design-review case of SCR-006-share (B-TH-280): the Partners window over the docked thread it opens from. */
export interface SharesWindowCaseModel {
  /** The record's invitations (made-up data). */
  readonly shares: SharesPanelModel
  /** The record's number, the window's subtitle. */
  readonly record: string
}

export function SharesWindowCase({ model }: { model: SharesWindowCaseModel }) {
  return (
    <WithMessages namespaces={[SHARES_NS]}>
      <Case model={model} />
    </WithMessages>
  )
}

function Case({ model }: { model: SharesWindowCaseModel }) {
  const t = useT(SHARES_NS)
  const [open, setOpen] = useState(true)
  return (
    <DockedStage>
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus size={14} aria-hidden /> {t('tab')}
      </Button>
      {open && <SharesWindow model={model.shares} record={model.record} onClose={() => setOpen(false)} />}
    </DockedStage>
  )
}
