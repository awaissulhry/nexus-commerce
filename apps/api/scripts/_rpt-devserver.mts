/**
 * Local RPT preview server. Imports ONLY the two reporting services — no Fastify
 * app, no job registry — so it cannot boot the cron fleet against prod Neon.
 * Read-only. Throwaway; not part of the app.
 */
import { resolve } from 'path'
import { createServer } from 'http'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { getReportingCoverage } = await import('../src/services/advertising/ads-reporting-coverage.service.js')
const { runReport, ReportError } = await import('../src/services/advertising/ads-report-runner.service.js')

const json = (res: any, code: number, body: unknown) => {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || 'http://localhost:3000')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }
  const url = new URL(req.url!, 'http://localhost:8080')
  try {
    if (url.pathname === '/api/advertising/reporting/coverage') {
      return json(res, 200, await getReportingCoverage())
    }
    if (url.pathname === '/api/advertising/reporting/run') {
      const g = (k: string) => url.searchParams.get(k) ?? undefined
      const list = (k: string) => (g(k) ? g(k)!.split(',').map(s => s.trim()).filter(Boolean) : [])
      return json(res, 200, await runReport({
        reportId: g('reportId') ?? '', from: g('from') ?? null, to: g('to') ?? null,
        marketplaces: list('marketplaces'), adProducts: list('adProducts'),
        search: g('search') ?? null, groupBy: list('groupBy'), columns: list('columns'),
        sort: g('sortCol') ? { col: g('sortCol')!, dir: g('sortDir') === 'asc' ? 'asc' : 'desc' } : null,
        page: g('page') ? Number(g('page')) : 1, pageSize: g('pageSize') ? Number(g('pageSize')) : 50,
      }))
    }
    if (url.pathname.startsWith('/api/advertising/reporting/schedules')) {
      const crud = await import('../src/services/advertising/ads-report-schedules-crud.service.js')
      const runner = await import('../src/services/advertising/ads-report-schedules.service.js')
      const rest = url.pathname.replace('/api/advertising/reporting/schedules', '')
      const body = await new Promise<string>((ok) => { let b = ''; req.on('data', c => b += c); req.on('end', () => ok(b)) })
      const parsed = body ? JSON.parse(body) : {}
      try {
        const m = rest.match(/^\/([^/]+)(\/(deliveries|run))?$/)
        const id = m?.[1]
        if (req.method === 'GET' && rest === '') return json(res, 200, { items: await crud.listSchedules() })
        if (req.method === 'GET' && id && m?.[3] === 'deliveries') return json(res, 200, { items: await crud.listDeliveries(id) })
        if (req.method === 'POST' && rest === '') return json(res, 201, await crud.createSchedule(parsed))
        if (req.method === 'POST' && id && m?.[3] === 'run') return json(res, 200, await runner.runSchedule(id))
        if (req.method === 'PATCH' && id) return json(res, 200, await crud.updateSchedule(id, parsed))
        if (req.method === 'DELETE' && id) { await crud.deleteSchedule(id); return json(res, 200, { ok: true }) }
        return json(res, 404, { error: 'not found' })
      } catch (e) { return json(res, 400, { error: (e as Error).message }) }
    }
    if (url.pathname.startsWith('/api/advertising/reporting/saved')) {
      const svc = await import('../src/services/advertising/ads-saved-reports.service.js')
      const rest = url.pathname.replace('/api/advertising/reporting/saved', '')
      const body = await new Promise<string>((ok) => { let b = ''; req.on('data', c => b += c); req.on('end', () => ok(b)) })
      const parsed = body ? JSON.parse(body) : {}
      try {
        if (req.method === 'GET' && rest === '') return json(res, 200, { items: await svc.listSavedReports(url.searchParams.get('reportId') ?? undefined) })
        const m = rest.match(/^\/([^/]+)(\/(versions|restore))?$/)
        const id = m?.[1]
        if (req.method === 'GET' && id && m?.[3] === 'versions') return json(res, 200, { items: await svc.listVersions(id) })
        if (req.method === 'GET' && id) return json(res, 200, await svc.getSavedReport(id))
        if (req.method === 'POST' && rest === '') return json(res, 201, await svc.createSavedReport(parsed))
        if (req.method === 'POST' && id && m?.[3] === 'restore') return json(res, 200, await svc.restoreVersion(id, Number(parsed.version)))
        if (req.method === 'PATCH' && id) return json(res, 200, await svc.updateSavedReport(id, parsed))
        if (req.method === 'DELETE' && id) { await svc.archiveSavedReport(id); return json(res, 200, { ok: true }) }
        return json(res, 404, { error: 'not found' })
      } catch (e) {
        return json(res, (e as { status?: number }).status ?? 500, { error: (e as Error).message })
      }
    }
    if (url.pathname === '/api/advertising/reporting/business-context') {
      const { businessContext } = await import('../src/services/advertising/ads-business-context.service.js')
      const to = url.searchParams.get('to') ?? new Date().toISOString().slice(0,10)
      const from = url.searchParams.get('from') ?? (() => { const d=new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate()-29); return d.toISOString().slice(0,10) })()
      const mc = url.searchParams.get('minClicks')
      return json(res, 200, await businessContext({ from, to, minClicks: mc ? Number(mc) : undefined }))
    }
    if (url.pathname.startsWith('/api/advertising/reporting/custom-metrics')) {
      const svc = await import('../src/services/advertising/ads-custom-metrics.service.js')
      const rest = url.pathname.replace('/api/advertising/reporting/custom-metrics', '')
      const body = await new Promise<string>((ok) => { let b=''; req.on('data',c=>b+=c); req.on('end',()=>ok(b)) })
      const parsed = body ? JSON.parse(body) : {}
      try {
        if (rest === '/preview') return json(res, 200, svc.previewFormula(url.searchParams.get('reportId') ?? '', url.searchParams.get('formula') ?? ''))
        if (req.method === 'GET') return json(res, 200, { items: await svc.listCustomMetrics(url.searchParams.get('reportId') ?? undefined) })
        if (req.method === 'POST') return json(res, 201, await svc.createCustomMetric(parsed))
        const id = rest.replace('/', '')
        if (req.method === 'PATCH' && id) return json(res, 200, await svc.updateCustomMetric(id, parsed))
        if (req.method === 'DELETE' && id) { await svc.deleteCustomMetric(id); return json(res, 200, { ok: true }) }
        return json(res, 404, { error: 'not found' })
      } catch (e) { return json(res, (e as {status?:number}).status ?? 400, { error: (e as Error).message }) }
    }
    if (url.pathname === '/api/advertising/reporting/pipeline') {
      const { pipelineHealth } = await import('../src/services/advertising/ads-pipeline-health.service.js')
      return json(res, 200, await pipelineHealth())
    }
    if (url.pathname === '/api/advertising/reporting/summary') {
      const { reportSummary } = await import('../src/services/advertising/ads-report-summary.service.js')
      const g = (k: string) => url.searchParams.get(k) ?? undefined
      const list = (k: string) => (g(k) ? g(k)!.split(',').map(s => s.trim()).filter(Boolean) : [])
      return json(res, 200, await reportSummary({
        reportId: g('reportId') ?? '', from: g('from') ?? null, to: g('to') ?? null,
        marketplaces: list('marketplaces'), adProducts: list('adProducts'),
        search: g('search') ?? null, groupBy: list('groupBy'), columns: list('columns'),
        sort: null, page: 1,
        compare: (g('compare') === 'none' || g('compare') === 'yoy' ? g('compare') : 'previous') as never,
        metrics: list('metrics'),
      }))
    }
    if (url.pathname === '/api/advertising/reporting/export') {
      const g = (k: string) => url.searchParams.get(k) ?? undefined
      const list = (k: string) => (g(k) ? g(k)!.split(',').map(s => s.trim()).filter(Boolean) : [])
      const { exportReport } = await import('../src/services/advertising/ads-report-export.service.js')
      const out = await exportReport({
        reportId: g('reportId') ?? '', from: g('from') ?? null, to: g('to') ?? null,
        marketplaces: list('marketplaces'), adProducts: list('adProducts'),
        search: g('search') ?? null, groupBy: list('groupBy'), columns: list('columns'),
        sort: g('sortCol') ? { col: g('sortCol')!, dir: g('sortDir') === 'asc' ? 'asc' : 'desc' } : null,
      }, g('format') === 'xlsx' ? 'xlsx' : 'csv')
      res.setHeader('Content-Type', out.contentType)
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`)
      res.setHeader('X-Nexus-Report-Rows', String(out.manifest.rows))
      res.setHeader('X-Nexus-Report-From', out.manifest.dataFirstDay ?? '')
      res.setHeader('X-Nexus-Report-To', out.manifest.dataLastDay ?? '')
      res.statusCode = 200
      return res.end(out.body)
    }
    return json(res, 404, { error: 'not found' })
  } catch (e) {
    const status = e instanceof ReportError ? e.status : 500
    return json(res, status, { error: (e as Error).message })
  }
}).listen(8080, () => console.log('RPT preview server on :8080 (read-only)'))
