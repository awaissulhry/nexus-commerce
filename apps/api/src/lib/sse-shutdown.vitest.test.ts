import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { request } from 'node:http'
import { endEventStreamsOnClose, sseResponseHeaders } from './sse.js'

/** Real sockets: an SSE handler that never returns, as the event routes are written. */
describe('event streams at shutdown', () => {
  const apps: FastifyInstance[] = []
  afterEach(async () => { for (const app of apps.splice(0)) app.server.closeAllConnections() })

  async function serve(withShutdownHook: boolean) {
    const app = Fastify()
    apps.push(app)
    if (withShutdownHook) endEventStreamsOnClose(app)
    app.get('/events', async (req, reply) => {
      reply.raw.writeHead(200, sseResponseHeaders(req.headers.origin))
      reply.raw.write(': connected\n\n')
      await new Promise(() => {})
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    let opened!: () => void
    const open = new Promise<void>(resolve => { opened = resolve })
    const ended = new Promise<void>((resolve, reject) => {
      const client = request({ port, host: '127.0.0.1', path: '/events', headers: { accept: 'text/event-stream' } }, response => {
        response.once('data', () => opened())
        response.once('end', () => resolve())
        response.resume()
      })
      client.once('error', reject)
      client.end()
    })
    await open
    return { app, ended }
  }

  const within = <T>(promise: Promise<T>, ms: number) => Promise.race([
    promise.then(() => 'done' as const),
    new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms)),
  ])

  it('ends open streams so the server closes at once', async () => {
    const { app, ended } = await serve(true)
    expect(await within(app.close(), 2_000)).toBe('done')
    expect(await within(ended, 1_000)).toBe('done')
  })

  it('control: without it, an open stream holds the server open', async () => {
    const { app } = await serve(false)
    expect(await within(app.close(), 1_000)).toBe('timeout')
  })
})
