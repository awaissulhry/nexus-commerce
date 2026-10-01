import { expect, type Page, type Request } from '@playwright/test'

/** Include body completion, failures and duplicate calls. Response headers alone are not a settled request. */
/** Lookups that cannot answer on an offline stack (no channel credentials, no network): their wait and their 503 are not
 *  the sheet's. One list for the speed and latency specs. */
export const OFFLINE_LATENCY = ['/api/ebay/flat-file/category-breadcrumbs']

export class NetworkMetrics {
  readonly requests: Request[] = []
  private readonly pending = new Set<Request>()
  private changedAt = Date.now()

  constructor(page: Page, private readonly pendingLatencyExclusions: string[] = [], resetOnNavigation = false) {
    page.on('request', (request) => {
      if (resetOnNavigation && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        this.requests.length = 0
        this.pending.clear()
        this.changedAt = Date.now()
      }
      if (!new URL(request.url()).pathname.includes('/api/') || request.resourceType() === 'eventsource') return
      this.requests.push(request)
      this.pending.add(request)
      this.changedAt = Date.now()
    })
    const done = (request: Request) => {
      if (!this.pending.delete(request)) return
      this.changedAt = Date.now()
    }
    page.on('requestfinished', done)
    page.on('requestfailed', done)
  }

  private excludesLatency(request: Request) {
    return this.pendingLatencyExclusions.some(path => new URL(request.url()).pathname.endsWith(path))
  }

  async settle() {
    await expect.poll(() => [...this.pending].every(request => this.excludesLatency(request)) && Date.now() - this.changedAt >= 1_500,
      { timeout: 30_000, message: 'API requests did not finish and remain quiet for 1.5 seconds' }).toBe(true)
  }

  async collect() {
    return Promise.all(this.requests.map(async (request) => {
      // Offline category breadcrumbs may never finish. Keep them in the count and identify missing byte/latency data.
      if (this.pending.has(request) && this.excludesLatency(request)) return {
        method: request.method(), url: new URL(request.url()).pathname + new URL(request.url()).search,
        status: 0, unfinished: true, rawBytes: 0, encodedBytes: 0,
      }
      const response = await request.response()
      const body = await response?.body().catch(() => null)
      const size = await request.sizes().catch(() => null)
      return { method: request.method(), url: new URL(request.url()).pathname + new URL(request.url()).search,
        status: response?.status() ?? 0, failed: request.failure()?.errorText,
        rawBytes: body?.length ?? 0, encodedBodyBytes: size?.responseBodySize ?? 0,
        encodedBytes: (size?.responseBodySize ?? 0) + (size?.responseHeadersSize ?? 0) }
    }))
  }
}

// Same committed-fiber counter used in the P2 measurements. This counts committed component work, not aborted renders.
export const renderHook = `(() => {
  let total = 0, commits = 0
  const component = f => [0, 1, 11, 14, 15].includes(f.tag)
  const mounted = f => { if (component(f)) total++; for (let c = f.child; c; c = c.sibling) mounted(c) }
  const updated = (f, old) => {
    if (component(f) && (f.flags & 1)) total++
    if (f.child !== old.child) for (let c = f.child; c; c = c.sibling) c.alternate ? updated(c, c.alternate) : mounted(c)
  }
  let id = 0
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject(r) { this.renderers.set(++id, r); return id }, checkDCE() {}, onScheduleFiberRoot() {},
    onPostCommitFiberRoot() {}, onCommitFiberUnmount() {}, setStrictMode() {},
    onCommitFiberRoot(_id, root) { commits++; const f = root.current, old = f.alternate;
      if (!old || old.memoizedState?.element == null) mounted(f); else updated(f, old) }
  }
  window.__sheetRenders = { snapshot: () => ({ total, commits,
    production: [...window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers.values()].every(renderer => renderer.bundleType === 0) }),
    reset: () => { total = 0; commits = 0 } }
})()`
