// MC.1.1 — DAM hub shared types. Mirrors the GET /api/assets/overview
// response so the server fetch and the client render agree on shape
// without exporting Prisma types into the web bundle.

export interface OverviewPayload {
  totalAssets: number
  productImageCount: number
  videoCount: number
  byType: Record<string, number>
  storageBytes: number
  inUseCount: number
  orphanedCount: number
  needsAttention: {
    missingAltImages: number
  }
}
