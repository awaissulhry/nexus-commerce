import { defineManifest } from '../../core/manifest'

/**
 * Home › Today (B-W1-52; A2 SCR-029, SCR-031 W1 "Overview"): office only (floor, portal and link sessions are refused by
 * audience). home.view reaches the page; what it shows is filtered row by row by the person's other permissions (each
 * source with scopeWhere, each row with can() in factory-domain insights: `record`). The actions on a row (assign,
 * resolve, acknowledge) need home.view to reach and, row by row, the right to act on the row's record
 * (actingPermission: `record`); a layout is the person's own.
 */
export const manifest = defineManifest({
  'GET /home/today': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/flow': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/waiting-on-others': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/today/handled': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/today/rows/:key/assignees': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /home/today/rows/:key/assign': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /home/today/rows/:key/resolve': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /home/today/rows/:key/acknowledge': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/today/layout': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'PUT /home/today/layout': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  // B-W2a-20: Snooze (an alert row, the record's act right), Nudge (my own waits), Coming up (my next working days).
  'POST /home/today/rows/:key/snooze': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /home/waiting-on-others/:key/nudge': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  // B-W2b-388 (COL-035): Changed since you looked — my own FOLLOWING news (home.view; the handler reads only my rows).
  'GET /home/following': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/coming-up': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  // B-W2a-79 (reports/): My numbers reach with home.view (each number asks its list's permission and grain); the report
  // library and its reports with home.reports.view (each report asks its list's permission, and its grain: `record`).
  'GET /home/numbers': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /reports': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
  'GET /reports/:key': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
  'GET /reports/:key/results': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
  'GET /reports/:key/schedule': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
  // B-W2b-348 (sales-reports/): Sales reports, office only, read only: sales.reports.view over the screen's company, each figure
  // also the records' own view (orders.view, quotes.view, sales.returns.view) and every amount the price grain (`record`).
  // Quote speed is a section of Sales › Quotes: quotes.view.
  'GET /sales/reports/headline': { audiences: ['office'], permission: 'sales.reports.view', scope: 'record' },
  'GET /sales/reports/intake': { audiences: ['office'], permission: 'sales.reports.view', scope: 'record' },
  'GET /sales/reports/backlog': { audiences: ['office'], permission: 'sales.reports.view', scope: 'record' },
  'GET /sales/reports/returns': { audiences: ['office'], permission: 'sales.reports.view', scope: 'record' },
  'GET /sales/reports/quote-speed': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
  // ---- B-TH-052 (threads plan L2-G10): the request-to-order figure — sales.reports.view over the screen's company; it counts only
  // the requests the reader reaches with sales.inquiries.view (`record`).
  'GET /sales/reports/requests': { audiences: ['office'], permission: 'sales.reports.view', scope: 'record' },
  // ---- end B-TH-052
  // B-W2b-428 (kpis/, facts/): the metric layer, office only. The KPI library with home.kpis.view, its versions, the standard
  // KPIs, their uses and a rebuild of the facts with home.kpis.manage; every value also asks its measures' list permissions and
  // grains, a rebuild the companies of the person's grant (`record`).
  'GET /insights/kpis': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'POST /insights/kpis/sync': { audiences: ['office'], permission: 'home.kpis.manage', scope: 'record' },
  'GET /insights/kpis/:key': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/kpis/:key/value': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'POST /insights/kpis/:key/versions': { audiences: ['office'], permission: 'home.kpis.manage', scope: 'record' },
  'POST /insights/kpis/:key/retire': { audiences: ['office'], permission: 'home.kpis.manage', scope: 'record' },
  'PATCH /insights/kpis/versions/:id': { audiences: ['office'], permission: 'home.kpis.manage', scope: 'record' },
  'POST /insights/kpis/versions/:id/activate': { audiences: ['office'], permission: 'home.kpis.manage', scope: 'record' },
  'DELETE /insights/kpis/versions/:id': { audiences: ['office'], permission: 'home.kpis.manage', scope: 'record' },
  'GET /insights/measures': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/facts': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'POST /insights/facts/rebuild': { audiences: ['office'], permission: 'home.kpis.manage', scope: 'record' },
  // B-W2b-429 (kpis/drills/): the ready KPIs' records, office only, read only: home.kpis.view, and each drill its KPI's measures'
  // list permissions and grains over the records' company, site and customer or supplier (`record`).
  'GET /insights/kpis/drills/otif': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/kpis/drills/lead-times': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/kpis/drills/wip': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/kpis/drills/leather-yield': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/kpis/drills/margin': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/kpis/drills/supply': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  // B-W2b-434 (dashboards/): the dashboards, office only, home.kpis.view; each number its KPI's measures' list permissions and
  // grains over the scope asked (`record`); Needs action the person's own Today; a layout is the person's own.
  'GET /insights/dashboards': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/dashboards/needs-action': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/dashboards/trends': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/dashboards/wip': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/dashboards/:board/numbers': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/dashboards/:board/by-company': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'GET /insights/dashboards/:board/layout': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'PUT /insights/dashboards/:board/layout': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  'DELETE /insights/dashboards/:board/layout': { audiences: ['office'], permission: 'home.kpis.view', scope: 'record' },
  // B-W2b-435 (digest/, reports/subscriptions.ts): office only. My morning e-mail, its preview and a test are my own (home.view;
  // each section asks its own list's permission and grains as me); the switch per company is the owner's (home.digest.switch
  // over that company: the handler checks it); Today's value per stage needs the cost grain and costing.view (else counts only);
  // "E-mail me this" is the person's own, for a report they may run.
  'GET /insights/digest': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'PUT /insights/digest': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'PUT /insights/digest/switch': { audiences: ['office'], permission: 'home.digest.switch', scope: 'record' },
  'GET /insights/digest/preview': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /insights/digest/test': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /home/flow/value': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'GET /reports/subscriptions': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
  'PUT /reports/:key/subscription': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
  'DELETE /reports/:key/subscription': { audiences: ['office'], permission: 'home.reports.view', scope: 'record' },
})
