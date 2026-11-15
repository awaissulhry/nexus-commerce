'use client'

import { TodayView, type TodayViewModel } from '../../../../areas/home/today/view/TodayView'

/**
 * A design-review case of SCR-548: Today with a reminder that came back among my rows, and Coming up's "Remind me the day before"
 * per item (the design index's own action: it only marks the item set).
 */
export function TodayRemindCase({ model }: { model: TodayViewModel }) {
  return <TodayView model={model} actions={{ onRemindDayBefore: async () => true }} />
}
