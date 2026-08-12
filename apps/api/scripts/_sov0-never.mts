/**
 * _sov0-never.mts — the two states that only a watchlist can produce (read-only).
 *
 * `_sov0-weeks.mts` showed `never-measured` at 0 in every view, which looks like dead code and is
 * not: the nine IT terms that have never had a Brand Analytics row are all BRAND terms, and
 * `branded=0` is the default. So the state is only reachable at `?branded=1`, and this proves it
 * on named rows rather than leaving it asserted.
 *
 * Also checks that a `?list=` naming another market's watchlist is REFUSED (the same rule the
 * scope spine applies to a campaign id from the wrong market) and that a nonsense id is not.
 *
 * NO WRITES. Run from apps/api.
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { getShareOfVoice } from '../src/services/advertising/share-of-voice.service.js'
const line = (s='') => console.log(s)
async function main() {
  for (const m of ['IT','DE'] as const) {
    const l = await prisma.keywordWatchlist.findFirst({ where: { marketplace: m, isDefault: true }, select: { id: true, name: true } })
    if (!l) continue
    const r = await getShareOfVoice({ market: m, list: l.id, branded: true, limit: 2000 })
    line(`${m} "${l.name}" branded=1 → ${r.total} rows`)
    for (const st of ['measured','not-covered','no-row-this-period','never-measured'] as const) {
      const hit = r.rows.filter(x => x.state === st)
      line(`   ${st.padEnd(19)} ${String(hit.length).padStart(3)}${hit[0] ? `  e.g. "${hit[0].query}" branded=${hit[0].branded} lastSeen=${hit[0].lastSeen ?? '—'}` : ''}`)
    }
  }
  // a list id from ANOTHER market must be refused, not honoured
  const de = await prisma.keywordWatchlist.findFirst({ where: { marketplace: 'DE' }, select: { id: true } })
  const r = await getShareOfVoice({ market: 'IT', list: de!.id })
  line(`IT with a DE list id → listRejected=${r.scope.listRejected} list=${r.scope.list} total=${r.total}`)
  const r2 = await getShareOfVoice({ market: 'IT', list: 'does-not-exist' })
  line(`IT with a nonsense list id → listRejected=${r2.scope.listRejected} total=${r2.total}`)
}
main().then(()=>prisma.$disconnect()).catch(async e=>{console.error(e);await prisma.$disconnect();process.exit(1)})
