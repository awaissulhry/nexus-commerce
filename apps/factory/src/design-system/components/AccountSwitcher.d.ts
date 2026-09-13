export { channelDisplayName } from '../lib/account-identity';
import '../styles/tokens.css';
import '../styles/components.css';
export type AccountHealth = 'ok' | 'warn' | 'error' | 'unknown';
/**
 * The account-identity palette.
 *
 * A FIXED set, not a free colour picker. The plan's §3.2 asks for account colour
 * to be a token so "the switcher, the flat-file header, the orders inbox and the
 * cross-account console all read the same identity" — a hex an operator can type
 * would drift between surfaces and could land unreadable against either theme.
 * These eight are drawn from the DS palette and checked against both grounds.
 *
 * Stored as hex because that is what `ChannelConnection.accountColor` holds and
 * what the API validates; the UI never offers anything outside this list.
 *
 * The values themselves live in `tokens/colors.ts` (`accountIdentity`) — this is
 * the DS's public alias for them, kept so the existing import path still works.
 */
export declare const ACCOUNT_COLORS: ReadonlyArray<{
    name: string;
    hex: string;
}>;
export interface AccountRow {
    id: string;
    channel: string;
    managedBy: string;
    label: string;
    labelSource: 'accountLabel' | 'storeName' | 'displayName' | 'signInName' | 'sellerId' | 'channel';
    labelIsPlaceholder: boolean;
    markets: string[];
    health: AccountHealth;
    healthReason: string | null;
    isPrimary: boolean;
    isActive?: boolean;
    /** MAP.2a additions. Optional so an older API response still types. */
    sortOrder?: number;
    externalAccountId?: string | null;
    accountColor?: string | null;
    tokenExpiresAt: string | null;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    lastSyncError: string | null;
    /**
     * CX.1 additions (`61774d222`). All optional so an older API response still types.
     * `authStatus` is the measured sign-in state — NOT derived from `isActive` or
     * `managedBy`; a row without it came from an API that predates CX.1.
     */
    authStatus?: 'connected' | 'degraded' | 'needs_reauth' | 'revoked' | 'disconnected' | 'unknown' | string;
    region?: string | null;
    /** Permissions recorded at consent. */
    grantedScopes?: string[];
    /** Amazon SP-API grants approved app roles; most channels grant OAuth scopes. */
    permissionModel?: 'oauth_scopes' | 'application_roles';
    /** Permissions the catalogue requires that the grant does not carry. */
    scopeDrift?: string[];
    /** Measured facts from `ConnectionScope` — the marketplaces / sites this grant reaches. */
    scopes?: {
        kind: string;
        externalId: string;
        label: string | null;
        isActive?: boolean;
    }[];
    accessTokenExpiresAt?: string | null;
    refreshTokenExpiresAt?: string | null;
    lastRefreshAt?: string | null;
    lastHeartbeatAt?: string | null;
    /** `null` until CX.4 gives these a writer — render "not tracked yet", never "never". */
    lastInboundAt?: string | null;
    lastOutboundAt?: string | null;
    lastErrorAt?: string | null;
    /** Already redacted server-side. */
    lastError?: string | null;
    consecutiveFailures?: number;
    identity?: Record<string, unknown> | null;
}
export interface AccountsPayload {
    success: boolean;
    accounts: AccountRow[];
    notConnected: string[];
    canSwitch: boolean;
}
export interface AccountSwitcherProps {
    /** Absolute URL of `GET /api/accounts`. */
    endpoint: string;
    /** Where "Manage channels" goes. */
    manageHref?: string;
    className?: string;
    /** Test seam — when provided, no fetch is performed. */
    initialData?: AccountsPayload;
}
export declare function AccountSwitcher({ endpoint, manageHref, className, initialData, }: AccountSwitcherProps): import("react/jsx-runtime").JSX.Element;
