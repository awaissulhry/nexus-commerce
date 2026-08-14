import { SQP_REPORT_TYPE } from '../src/services/advertising/sqp.service.js'
import { getSpApiClient } from '../src/services/sp-api-reports.service.js'
const sp = getSpApiClient()
const list: any = await (sp as any).callAPI({
  operation: 'getReports', endpoint: 'reports',
  query: { reportTypes: [SQP_REPORT_TYPE], createdSince: new Date(Date.now() - 3 * 3600_000).toISOString(), pageSize: 100 },
})
for (const r of (list?.reports ?? [])) console.log(JSON.stringify(r))
