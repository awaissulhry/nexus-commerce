/**
 * EH.8 — Helper for building Server-Timing headers.
 *
 * Server-Timing is the W3C-standard way to surface internal request
 * timing breakdowns to DevTools. Each metric becomes a row in the
 * browser's Network panel "Timing" tab, so we can see e.g. how much
 * of a /health response was Prisma vs. cache lookup vs. JSON
 * serialization — no log scraping required.
 *
 * Usage:
 *   const tx = new ServerTiming()
 *   tx.start('listEtag')
 *   const etag = await listEtag(...)
 *   tx.stop('listEtag')
 *   tx.flag('cacheHit')
 *   reply.header('Server-Timing', tx.toHeader())
 *
 * Each `start(name)` opens a metric, each `stop(name)` closes it and
 * records the elapsed ms. `flag(name)` records a zero-duration
 * marker — useful for boolean signals like cacheHit/miss that don't
 * have a meaningful duration. Repeated names are allowed; the last
 * stop wins (intentional: per-request, a name describes one phase).
 */

interface Metric {
  name: string
  durationMs?: number
  description?: string
}

export class ServerTiming {
  private readonly metrics = new Map<string, Metric>()
  private readonly openStarts = new Map<string, number>()

  /** Start measuring a named phase. Idempotent — re-starting clears the previous open mark. */
  start(name: string): void {
    this.openStarts.set(name, performance.now())
  }

  /** Stop a previously-started phase and record its elapsed time. No-op if `start(name)` wasn't called. */
  stop(name: string, description?: string): void {
    const t0 = this.openStarts.get(name)
    if (t0 === undefined) return
    this.openStarts.delete(name)
    this.metrics.set(name, {
      name,
      durationMs: performance.now() - t0,
      description,
    })
  }

  /** Convenience: time the awaited result of `fn`. */
  async measure<T>(name: string, fn: () => Promise<T>, description?: string): Promise<T> {
    this.start(name)
    try {
      return await fn()
    } finally {
      this.stop(name, description)
    }
  }

  /** Record a zero-duration marker for a boolean/categorical signal. */
  flag(name: string, description?: string): void {
    this.metrics.set(name, { name, description })
  }

  /** Build the header value. Returns null when no metrics were recorded so callers can skip the header entirely. */
  toHeader(): string | null {
    if (this.metrics.size === 0) return null
    const parts: string[] = []
    for (const m of this.metrics.values()) {
      let s = m.name
      if (m.durationMs !== undefined) {
        // Round to 0.1 ms — sub-tenth-ms precision is noise on Node.
        s += `;dur=${m.durationMs.toFixed(1)}`
      }
      if (m.description) {
        // RFC 7230 token + quoted-string for description.
        s += `;desc="${m.description.replace(/"/g, '\\"')}"`
      }
      parts.push(s)
    }
    return parts.join(', ')
  }
}
