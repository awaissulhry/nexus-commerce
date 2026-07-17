/**
 * FC4 — GET: the online snapshot — distinct userIds currently holding an SSE
 * connection on this process's hub (the same hub /api/events serves, so
 * "online" means a tab is actually listening — no heartbeat rows, no DB at
 * all). Bounded by construction (≤ live connections, tiny team). Live deltas
 * ride the ephemeral chat.presence event; this GET is the mount-time seed
 * and the resync fallback.
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { connectedUserIds } from "@/lib/events";

export const permission = PAGES.chat;
export const dynamic = "force-dynamic";

export const GET = guarded(PAGES.chat, async (_req, { resolved }) => {
  return jsonStripped({ online: connectedUserIds() }, resolved);
});
