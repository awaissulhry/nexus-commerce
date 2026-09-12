import type { ChannelKey } from './catalog.js'

/** A missing app registration is a setup issue, not a failed provider sign-in. */
export class ChannelAppConfigurationError extends Error {
  constructor(readonly channelKey: ChannelKey, readonly environment: string) {
    super(`${channelKey} app credentials are not configured for ${environment}.`)
    this.name = 'ChannelAppConfigurationError'
  }
}
