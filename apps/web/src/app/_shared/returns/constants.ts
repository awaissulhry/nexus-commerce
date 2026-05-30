// RX.0 — Returns shared constants.
//
// The status/channel tone maps and the action-label dictionary were
// previously inlined in ReturnsWorkspace.tsx. The command center (RX.1)
// and policies page (RX.2) need the same tones; sharing them keeps the
// colour language identical across every returns surface.

export const STATUS_TONE: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  REQUESTED: 'default',
  AUTHORIZED: 'info',
  IN_TRANSIT: 'info',
  RECEIVED: 'warning',
  INSPECTING: 'warning',
  RESTOCKED: 'success',
  REFUNDED: 'success',
  REJECTED: 'danger',
  SCRAPPED: 'danger',
}

export const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900',
  SHOPIFY: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900',
  WOOCOMMERCE: 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-900',
  ETSY: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900',
}

export const STATUSES = ['ALL', 'REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTING', 'RESTOCKED', 'REFUNDED', 'REJECTED', 'SCRAPPED'] as const

export const ACTION_LABEL: Record<string, { label: string; tone: 'info' | 'success' | 'warning' | 'danger' }> = {
  'create':                { label: 'Created',                  tone: 'info' },
  'receive':               { label: 'Marked received',          tone: 'info' },
  'inspect':               { label: 'Inspection saved',         tone: 'warning' },
  'restock':               { label: 'Restocked',                tone: 'success' },
  'refund':                { label: 'Refund issued',            tone: 'success' },
  'refund-failed':         { label: 'Refund failed',            tone: 'danger' },
  'refund-retry-manual':   { label: 'Refund retry (manual)',    tone: 'warning' },
  'refund-retry-auto':     { label: 'Refund retry (auto)',      tone: 'info' },
  'scrap':                 { label: 'Scrapped',                 tone: 'danger' },
  'attach-label':          { label: 'Label attached',           tone: 'info' },
  'mark-label-emailed':    { label: 'Label emailed to customer', tone: 'info' },
  'remove-label':          { label: 'Label removed',            tone: 'warning' },
  'generate-return-label': { label: 'Sendcloud return label generated', tone: 'info' },
  'carrier-scan':          { label: 'Carrier scan',             tone: 'info' },
  'edit-notes':            { label: 'Notes edited',             tone: 'info' },
  'edit-item':             { label: 'Item updated',             tone: 'info' },
  'upload-item-photo':     { label: 'Photo uploaded',           tone: 'info' },
  'remove-item-photo':     { label: 'Photo removed',            tone: 'warning' },
  'auto-approve':          { label: 'Auto-approved',            tone: 'info' },
  'warranty-update':       { label: 'Warranty updated',         tone: 'info' },
  'bulk-approve':          { label: 'Approved (bulk)',          tone: 'info' },
  'bulk-deny':             { label: 'Denied (bulk)',            tone: 'danger' },
  'bulk-receive':          { label: 'Marked received (bulk)',   tone: 'info' },
  'email-received':        { label: 'Email: received',          tone: 'info' },
  'email-refunded':        { label: 'Email: refunded',          tone: 'info' },
  'email-rejected':        { label: 'Email: rejected',          tone: 'warning' },
  'email-authorized':      { label: 'Email: approved',          tone: 'info' },
  'email-label_ready':     { label: 'Email: label ready',       tone: 'info' },
}
