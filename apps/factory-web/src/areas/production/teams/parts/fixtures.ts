import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BY_RULE_SALES, NO_TEAM, SPLIT_PRINTED, TOGETHER } from '../fixtures'
import { partModelOf } from '../model'
import { OrderTeamPartView, type OrderTeamPartViewModel } from '../view/OrderTeamPartView'

/**
 * owb-ss7 7.3 — the order's Team part with made-up data (design index `/design/SCR-owb-order-team`): each right (the production
 * manager gives or changes; sales asks, then reads "Asked"), together, split after the print, given by a rule, empty, failed.
 */
const ready = (part: OrderTeamPartViewModel['part']): OrderTeamPartViewModel => ({ state: 'ready', problem: null, part })

export const designScreen = defineDesignScreen<OrderTeamPartViewModel>({
  screen: 'SCR-owb-order-team',
  title: 'The order’s Team part — teams, in charge, split, Give to a team…, Ask for another team (owb-ss7)',
  view: OrderTeamPartView,
  cases: [
    { id: 'manager-none', label: 'Production manager: no team yet → Give to a team…', model: ready(partModelOf(NO_TEAM, false)) },
    { id: 'manager-together', label: 'Production manager: two teams work together, one in charge → Change…', model: ready(partModelOf(TOGETHER, false)) },
    { id: 'manager-split-printed', label: 'Production manager: split 7 / 5 after the print', model: ready(partModelOf(SPLIT_PRINTED, false)) },
    { id: 'sales-ask', label: 'Sales: given by its order structure → Ask for another team', model: ready(partModelOf(BY_RULE_SALES, false)) },
    { id: 'sales-asked', label: 'Sales: asked — the production manager answers', model: ready(partModelOf(BY_RULE_SALES, true)) },
    { id: 'reading', label: 'Reading', model: { state: 'reading', problem: null, part: null } },
    { id: 'failed', label: 'The team could not be read', model: { state: 'failed', problem: 'error.offline', part: null } },
  ],
})
