/** VT.F2 — the variation_theme CELL on every fixture coordinate, from the wire (before the screen readings). */
const API = 'http://127.0.0.1:8091'
const F3 = 'cmtzoenko0000nju8dbbrx22h'   // VTF2-TEST-3AX
const FN = 'cmtzoenm10013nju88dyn57yq'   // VTF2-TEST-NOAX
const show = (label, cell) => {
  if (!cell) { console.log(label, 'NO CELL'); return }
  console.log(label, JSON.stringify({
    axes: (cell.axes ?? []).map(a => [a.channelName ?? a.label, a.included]),
    theme: cell.theme ? [cell.theme.code, cell.theme.label, cell.theme.deprecated] : null,
    source: [cell.source?.kind, cell.source?.label],
    dropped: cell.dropped, collisions: cell.collisions,
    candidates: cell.candidates ? { kind: cell.candidates.kind, items: cell.candidates.items?.length, state: cell.candidates.state, limit: cell.candidates.limit } : null,
    locked: cell.locked ? { reason: cell.locked.reason.slice(0, 60), orderChangeAllowed: cell.locked.orderChangeAllowed } : null,
    writable: cell.writable, blocked: cell.writeBlockedReason, separator: cell.separator,
    order: cell.order ?? null,
  }))
}
const sheet = async (id, q) => {
  const r = await fetch(`${API}/api/products/${id}/studio/sheet?${q}`)
  const j = await r.json()
  const parentRow = (j.rows ?? []).find(row => row.productId === id || row.id === id) ?? (j.rows ?? [])[0]
  const childRow = (j.rows ?? []).find(row => row.productId !== id && row.id !== id)
  return { status: r.status, cols: (j.columns ?? []).length, parent: parentRow?.values?.variation_theme?.value, child: childRow?.values?.variation_theme, childBlocked: childRow?.values?.variation_theme?.writeBlockedReason }
}
for (const [label, id, q] of [
  ['3AX master      ', F3, 'scope=master&market=IT&locale=it'],
  ['3AX AMAZON·IT   ', F3, 'scope=channel&channel=AMAZON&market=IT&locale=it&accountId=cmothu9bo0000nz01asw6wx8j'],
  ['3AX AMAZON·DE   ', F3, 'scope=channel&channel=AMAZON&market=DE&locale=de&accountId=cmothu9bo0000nz01asw6wx8j'],
  ['3AX EBAY·IT     ', F3, 'scope=channel&channel=EBAY&market=IT&locale=it&accountId=cmr4aaqb00025nz016k18rup9'],
  ['NOAX master     ', FN, 'scope=master&market=IT&locale=it'],
]) {
  const out = await sheet(id, q)
  console.log(`\n${label} status=${out.status} columns=${out.cols}`)
  show('   parent cell:', out.parent)
  console.log('   child cell :', JSON.stringify(out.child?.value ?? null), 'blocked=', JSON.stringify(out.childBlocked ?? null))
}
