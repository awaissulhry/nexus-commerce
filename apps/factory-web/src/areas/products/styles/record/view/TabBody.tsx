'use client'

import type { StyleView } from '../../api'
import { BomTab } from '../../bom/view/BomTab'
import { ComplianceTab } from '../../compliance/view/ComplianceTab'
import { CostTab } from '../../cost/view/CostTab'
import type { StyleTab } from '../../model'
import { RoutingTab } from '../../routing/view/RoutingTab'
import type { StyleRecordActions, StyleRecordViewModel } from '../record-model'

/** The studio's revision tabs: Materials (BOM, SCR-042), Operations (SCR-043), Cost (SCR-044), Compliance (SCR-045). */
export function TabBody({ tab, style, model, actions }: { tab: StyleTab; style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  switch (tab) {
    case 'bom':
      return <BomTab style={style} model={model} actions={actions} />
    case 'routing':
      return <RoutingTab style={style} model={model} actions={actions} />
    case 'cost':
      return <CostTab style={style} model={model} actions={actions} />
    case 'compliance':
      return <ComplianceTab style={style} model={model} actions={actions} />
    default:
      return null
  }
}
