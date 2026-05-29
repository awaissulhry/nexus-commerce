/**
 * Deprecated: the horizontal Advertising tab strip is replaced by the
 * collapsible grouped left sidebar in layout.tsx (AdvertisingSidebar).
 * Kept as a no-op so existing `<AdvertisingNav />` mounts across ~28 pages
 * keep compiling without a 28-file edit; renders nothing.
 */
export function AdvertisingNav() {
  return null
}
