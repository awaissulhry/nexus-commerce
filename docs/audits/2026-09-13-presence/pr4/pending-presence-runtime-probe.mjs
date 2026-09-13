import fs from 'node:fs'
import assert from 'node:assert/strict'
import ts from '/Users/awais/nexus-commerce/node_modules/typescript/lib/typescript.js'
const root = '/Users/awais/nexus-commerce'
const original = fs.readFileSync(`${root}/apps/web/src/design-system/grid/renderers/presence.ts`, 'utf8')
const source = ts.transpileModule(original, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const before = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const builtSource = fs.readFileSync('/private/tmp/nexus-pr4-presence/presence-runtime/dist/presence.js', 'utf8')
assert(!/^import .*@nexus\/web/m.test(builtSource), 'runtime must not import web source')
const after = await import(`data:text/javascript;base64,${Buffer.from(builtSource).toString('base64')}`)
for (const key of ['PRESENCE_INTENTS', 'CHANNEL_FACTS', 'PRESENCE_VERDICTS']) assert.deepEqual(after[key], before[key])
let cases = 0
const now = Date.parse('2026-09-13T12:00:00Z')
for (const intent of [...before.PRESENCE_INTENTS, 'INVALID', 'toString']) {
  assert.deepEqual(after.intentMeta(intent), before.intentMeta(intent))
  for (const fact of [...before.CHANNEL_FACTS, 'INVALID', 'toString']) {
    assert.deepEqual(after.factMeta(fact), before.factMeta(fact))
    for (const inFlight of [true, false]) for (const observedAt of [null, 'bad', '2026-09-12', '2026-09-13T12:00:00Z', '2026-09-14']) {
      for (const patch of [{}, { intentAt: 'bad' }, { intentAt: '2026-09-14' }, { freshnessMs: -1 }, { now: NaN }]) {
        const input = { intent, fact, intentAt: null, observedAt, inFlight, now, freshnessMs: 60000, ...patch }
        assert.deepEqual(after.presenceVerdict(input), before.presenceVerdict(input))
        assert.deepEqual(after.presenceLine(input), before.presenceLine(input))
        cases++
      }
    }
  }
}
console.log(`Staged built module matches current DS: ${cases} verdict/line cases; canonical arrays/meta preserved; runtime web imports=0.`)
