/** offerActive is consumed by Amazon's next flat-file submit only. */
export function offerActiveHonoured(channel: string): boolean {
  return channel.toUpperCase() === 'AMAZON'
}
