/**
 * AccountsPanel row model (CX.2 §2) — every decision the honest row makes, as pure functions.
 *
 * The component (`components/AccountsPanel.tsx`) is thin over these: it places what they return.
 * They live here, not in the .tsx, so the behaviour is testable in apps/web's node-only vitest
 * (no jsdom, no React plugin — vitest.config.ts says why) and so the wording of a status, a
 * timestamp or a permissions line has exactly one home.
 *
 * Input types are STRUCTURAL and minimal on purpose: `AccountRow` satisfies them, and the model
 * never imports a component.
 */
import type { Tone } from '../primitives/tone';
export interface StatusPill {
    tone: Tone;
    label: string;
}
/**
 * The status pill for an `authStatus` — the §2 table. Any other string the API may grow into
 * renders neutral with the raw value: an unknown status is still a fact, and inventing a
 * friendlier word for it would not be.
 */
export declare function authStatusPill(authStatus: string, consecutiveFailures?: number, isActive?: boolean): StatusPill;
/** The Reconnect label — names the shortfall when the grant is behind the catalogue. */
export declare function reconnectLabel(scopeDrift: string[] | undefined, grantedScopes?: string[]): string;
export interface PermissionsLine {
    /** `warning` = a pill; `null` = plain text. */
    tone: 'warning' | null;
    text: string;
}
/**
 * "22 permissions granted", or a warning "N permissions not granted" when the grant is behind
 * the catalogue. `null` when the API sent neither list (pre-CX.1).
 */
export declare function permissionsLine(grantedScopes: string[] | undefined, scopeDrift: string[] | undefined, managedBy?: string, permissionModel?: 'oauth_scopes' | 'application_roles'): PermissionsLine | null;
/**
 * Relative wording for an ISO timestamp. `null` is "never" — the column exists and nothing has
 * written it. A column NOTHING writes yet goes through `timestampText(…, 'untracked')` instead:
 * "never" would be a lie about it.
 */
export declare function relativeTime(iso: string | null | undefined, now?: number): string;
/**
 * `tracked` — a column something writes; `null` reads "never".
 * `untracked` — `lastInboundAt` / `lastOutboundAt`, which have NO writer until CX.4; `null`
 * reads "not tracked yet" because nobody is counting, not because nothing happened.
 */
export type StampKind = 'tracked' | 'untracked' | 'na';
export declare const NOT_TRACKED_TEXT = "not tracked yet";
export declare const NOT_TRACKED_REASON = "Activity tracking is not available for this connection yet.";
export declare function timestampText(iso: string | null | undefined, kind?: StampKind, now?: number): string;
/** The `title` behind a stamp: the absolute instant, or the reason there is none. */
export declare function timestampTitle(label: string, iso: string | null | undefined, kind?: StampKind): string;
/** "Last sync 3 h ago (ok)" — the old health dot encoded `lastSyncStatus`; the text keeps it. */
export declare function lastSyncText(lastSyncAt: string | null | undefined, lastSyncStatus: string | null | undefined, now?: number, lastSyncError?: string | null): string;
export interface ScopeRow {
    kind: string;
    externalId: string;
    label: string | null;
    isActive?: boolean;
}
/** How many scope chips a row shows before folding the rest behind "+N more". */
export declare const SCOPE_CHIP_CAP = 12;
/** Missing provider names are explicit; marketplace/profile IDs are never display labels. */
export declare function scopeChipLabel(s: ScopeRow): string;
export interface VisibleScopes {
    visible: ScopeRow[];
    /** Chips folded away (0 when expanded or under the cap). */
    hidden: number;
    /** Whether the row needs a fold toggle at all. */
    foldable: boolean;
    /** The toggle's text — "+3 more" / "Show fewer". */
    toggleText: string;
}
export declare function visibleScopes(scopes: ScopeRow[], expanded: boolean, cap?: number): VisibleScopes;
/** The stored `lastError` shows only while it explains the status. */
export declare function errorLineVisible(authStatus: string | undefined, lastError: string | null | undefined): boolean;
export interface RowActions {
    makePrimary: boolean;
    /** Offered for active accounts, including env-managed connections. */
    test: boolean;
    /** The button label, or `null` when the row has no grant to re-authorise. */
    reconnect: string | null;
    disconnect: boolean;
    /** The "Set by environment" reason in place of Disconnect. */
    envNote: boolean;
}
/** Which actions a row offers, and what Reconnect says. */
export declare function rowActions(a: {
    isPrimary: boolean;
    isActive?: boolean;
    managedBy: string;
    scopeDrift?: string[];
    grantedScopes?: string[];
}, hasReconnect: boolean, actionLabel?: string | null): RowActions;
export interface HeartbeatOutcome {
    ok: boolean;
    /** The inline text the row prints — "OK · 412 ms" / "Failed · auth_expired · …". */
    text: string;
}
/**
 * The Test action: one real call to the purpose-built heartbeat endpoint. The server writes
 * `lastHeartbeatAt` and a ledger row; this only reports what came back, in the server's words.
 */
export declare function runHeartbeat(apiBase: string, id: string, fetchImpl?: typeof fetch): Promise<HeartbeatOutcome>;
