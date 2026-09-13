import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
// Run FROM apps/api to prove the application's actual package resolution.
const require = createRequire(path.resolve('package.json'))
const modules = {}
for (const name of ['push-lock','listing-risk','publish-gate','listing-capabilities']) {
  const resolved = require.resolve(`@nexus/shared/${name}`)
  assert.match(resolved, /packages\/shared\/dist\/.*\.js$/)
  modules[name] = await import(pathToFileURL(resolved).href)
  console.log(`PASS @nexus/shared/${name} -> ${resolved}`)
}
assert.equal(modules['push-lock'].assertPushAllowed({presenceIntent:'HELD'}).code,'PUSH_INTENT_HELD')
assert.equal(modules['push-lock'].assertPushAllowed({presenceIntent:undefined}),null)
assert.equal(modules['listing-risk'].identityHeld({externalListingId:'  id  '}),true)
assert.equal(modules['listing-risk'].sellingRisk({externalListingId:'id',presenceIntent:'ENDED'}),false)
assert.equal(modules['listing-risk'].sellingRisk({presenceIntent:'ENDED',channelFact:'SELLING'}),true)
assert.equal(modules['listing-capabilities'].offerActiveHonoured('SHOPIFY'),false)
assert.equal(modules['listing-capabilities'].offerActiveHonoured('AMAZON'),true)
assert.equal(typeof modules['publish-gate'].gateNote(null,'Amazon'),'string')
console.log('PASS built-module behavior; no TS loader, no DB or network')
