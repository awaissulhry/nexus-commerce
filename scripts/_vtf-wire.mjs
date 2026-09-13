/**
 * VT.F — the wire readings every number in the final report is taken from: the served column (width,
 * position, kind), the `VariationThemeCell` per scope, and the timings against VT.1's baseline.
 * READ-ONLY: GET only, no PATCH anywhere in this file.
 */
const API = 'http://127.0.0.1:8091'
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const FIXTURE = 'cmtzci5kf0000njr9f8yhrsxm'

export const SCOPES = [
  { key: 'master',        q: 'market=IT' },
  { key: 'amazon·IT',     q: 'scope=channel&channel=AMAZON&market=IT' },
  { key: 'amazon·DE',     q: 'scope=channel&channel=AMAZON&market=DE' },
  { key: 'ebay·IT',       q: 'scope=channel&channel=EBAY&market=IT' },
  { key: 'shopify',       q: 'scope=channel&channel=SHOPIFY&market=GLOBAL' },
]

/**
 * 🔴 A transport failure is an UNKNOWN outcome, not a slow read — and on this tree it has a known cause: a
 * concurrent lane saving an `apps/api` file restarts `tsx watch` mid-request and the socket closes
 * (`UND_ERR_SOCKET`). A timing taken across a restart is not a timing, so the attempt is RETRIED and the
 * retry is DISCLOSED rather than folded into the median (`reference_duration_needs_its_load`,
 * `reference_transport_failure_write_is_unknown_outcome`). GET only, so a retry is safe by construction.
 */
export const get = async (path, attempt = 1) => {
  const t0 = performance.now()
  try {
    const res = await fetch(`${API}${path}`)
    const body = await res.json().catch(() => null)
    return { status: res.status, ms: Math.round(performance.now() - t0), body, serverTiming: res.headers.get('server-timing'), retries: attempt - 1 }
  } catch (error) {
    if (attempt >= 4) return { status: 0, ms: null, body: null, transport: String(error?.cause?.code ?? error?.message), retries: attempt - 1 }
    console.log(`   (transport ${error?.cause?.code ?? error?.message} on ${path} — attempt ${attempt}, the API restarted; retrying)`)
    await new Promise((r) => setTimeout(r, 6000))
    return get(path, attempt + 1)
  }
}

export const themeColumnOf = (columns) => {
  const i = (columns ?? []).findIndex((c) => c.key === 'variation_theme')
  if (i === -1) return null
  const c = columns[i]
  return { index: i, width: c.width, label: c.label, kind: c.kind, shape: c.shape, editable: c.editable, storage: c.storage, group: c.group }
}

export const themeCellOf = (sheet, productId) => {
  const rows = sheet?.rows ?? []
  const row = rows.find((r) => r.productId === productId || r.id === productId) ?? rows[0]
  const v = row?.values?.variation_theme?.value ?? row?.values?.variation_theme ?? null
  return { rowId: row?.productId ?? row?.id ?? null, cell: v }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const which = process.argv[2] ?? 'columns'
  if (which === 'columns') {
    for (const s of SCOPES) {
      const r = await get(`/api/products/${GALE}/studio/columns?${s.q}`)
      console.log(`${s.key.padEnd(11)} ${r.status} ${String(r.ms).padStart(5)}ms  nCols=${String(r.body?.columns?.length ?? '—').padStart(4)}  ${JSON.stringify(themeColumnOf(r.body?.columns))}`)
    }
  } else if (which === 'timings') {
    /* THREE WARM runs per scope, as VT.1's baseline was taken. The first run of each is discarded as the
       cache-warm; the reported number is the median of the three that follow. */
    const table = []
    for (const s of SCOPES) {
      for (const ep of ['sheet', 'columns']) {
        if (ep === 'columns' && s.key !== 'amazon·IT') continue
        await get(`/api/products/${GALE}/studio/${ep}?${s.q}`)
        const runs = []
        for (let i = 0; i < 3; i++) runs.push((await get(`/api/products/${GALE}/studio/${ep}?${s.q}`)).ms)
        runs.sort((a, b) => a - b)
        table.push({ scope: s.key, endpoint: ep, runs, median: runs[1] })
      }
    }
    console.log(JSON.stringify(table, null, 1))
  } else if (which === 'cells') {
    for (const [label, id] of [['GALE', GALE], ['VX-TEST-3AX', FIXTURE]]) {
      for (const s of SCOPES) {
        const r = await get(`/api/products/${id}/studio/sheet?${s.q}`)
        const { rowId, cell } = themeCellOf(r.body, id)
        console.log(`\n── ${label} · ${s.key} (${r.status}, ${r.ms}ms, row ${rowId})\n${JSON.stringify(cell)}`)
      }
    }
  }
}
