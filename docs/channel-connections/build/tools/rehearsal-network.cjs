// Local rehearsal only. Preloaded before API imports (and inherited by Node children).
// Enforce the no-vendor/no-cloud boundary even if a background job gains a default.
const net = require('node:net')
const tls = require('node:tls')
const { syncBuiltinESMExports } = require('node:module')
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
function check(args) {
  const first = args[0]
  const options = Array.isArray(first) ? first[0] : first
  const host = typeof options === 'object' && options !== null ? options.host ?? options.hostname ?? 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost'
  if ((typeof options === 'object' && options?.path) || typeof options === 'string' || !loopback.has(host)) {
    // Do not print a URL, headers, or credentials, even if a caller supplied them.
    process.stderr.write('CX_REHEARSAL_NETWORK_BLOCKED\n')
    throw new Error('CX_REHEARSAL_NETWORK_BLOCKED')
  }
}
for (const [target, name] of [[net.Socket.prototype, 'connect'], [tls, 'connect']]) {
  const original = target[name]
  target[name] = function (...args) { check(args); return original.apply(this, args) }
}
syncBuiltinESMExports()
