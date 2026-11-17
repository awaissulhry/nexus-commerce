'use client'

import { useState } from 'react'
import { FileCheck2 } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import { DockedStage } from '../../../lib/record-thread/parts/DockedStage'
import type { ApprovalHistoryModel } from '../../../shell/panels/approvals/model'
import { ApprovalHistory } from '../../../shell/panels/approvals/view/ApprovalHistory'
import { WithMessages } from '../../i18n'
import type { ApprovalsPanelModel } from '../model'
import { ApprovalsWindow } from './ApprovalsWindow'

/** A design-review case of SCR-006-approvals (B-TH-280): the Approvals window over the docked thread it opens from. */
export interface ApprovalsWindowCaseModel {
  /** The record's requests to its partner (made-up data). */
  readonly approvals: ApprovalsPanelModel
  /** The record's approval history under them, or null (no approvals.view, or a type without approvals). */
  readonly history: ApprovalHistoryModel | null
  /** The record's number, the window's subtitle. */
  readonly record: string
}

export function ApprovalsWindowCase({ model }: { model: ApprovalsWindowCaseModel }) {
  return (
    <WithMessages namespaces={['record-approvals']}>
      <Case model={model} />
    </WithMessages>
  )
}

function Case({ model }: { model: ApprovalsWindowCaseModel }) {
  const t = useT('record-approvals')
  const [open, setOpen] = useState(true)
  return (
    <DockedStage>
      <Button size="sm" onClick={() => setOpen(true)}>
        <FileCheck2 size={14} aria-hidden /> {t('tab')}
      </Button>
      {open && <ApprovalsWindow model={model.approvals} record={model.record} history={model.history ? <ApprovalHistory model={model.history} /> : null} onClose={() => setOpen(false)} />}
    </DockedStage>
  )
}
