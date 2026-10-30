import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Found by the browser golden flow (B-W1-06): three bundles made with the network off showed "2 tickets made here" and
// proposed the third again ("Make 1 bundle"), inviting a second bundle of the same garments. The container pushes each
// make to MADE after its enqueue resolved, so the last push comes after the last queue snapshot: a list of the tickets
// made here that follows only the snapshot misses it. A source check, as the screen runs only in a browser (no DOM in
// this app's vitest): the list follows the make's own re-render (the version bump) too.

describe('Bundles: the tickets made here', () => {
  it('re-read after every make, not only when the queue changes', () => {
    const source = readFileSync(new URL('./Bundles.tsx', import.meta.url), 'utf8')
    const deps = /const made = useMemo\([\s\S]*?\), \[([^\]]*)\]\)/.exec(source)?.[1] ?? ''
    expect(deps.split(',').map((dep) => dep.trim())).toEqual(expect.arrayContaining(['queueSnapshot.items', 'version']))
    expect(source).toMatch(/const \[version, setVersion\] = useState\(0\)/)
    expect(source).toMatch(/MADE\.push\([\s\S]*?\)\n\s*}\n[\s\S]*?bump\(\)/)
  })
})
