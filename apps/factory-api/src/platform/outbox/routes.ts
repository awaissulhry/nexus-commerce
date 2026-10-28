import { defineRoutes } from '../../core/manifest'
import { closeProcessLiveFeed, processLiveFeed, serveLiveStream } from '../../core/sse'
import { manifest } from './manifest'

/**
 * The outbox (platform part): the live-screen stream. Events are written by command() (writer.ts) and published by the
 * worker (relay.ts, dispatch.ts); here a screen only listens. Open streams end when the app closes, so a shutdown does
 * not wait on them (the screen reconnects to a replica that is still serving).
 */
export default defineRoutes('outbox', manifest, async (app) => {
  const open = new Set<() => void>()
  app.addHook('preClose', async () => {
    for (const close of [...open]) close()
  })
  app.addHook('onClose', async () => {
    await closeProcessLiveFeed()
  })

  app.get('/live', async (request, reply) =>
    serveLiveStream(request, reply, {
      feed: processLiveFeed(),
      track: (close) => {
        open.add(close)
        return () => open.delete(close)
      },
    }),
  )
})
