import '../styles/tokens.css';
import '../styles/components.css';
import { type AccountRow, type AccountsPayload } from './AccountSwitcher';
export interface AccountsPanelProps {
    /** Absolute base URL of the API, e.g. `getBackendUrl()`. */
    apiBase: string;
    /** Channels the page can start an OAuth flow for. Absent = no connect button. */
    onConnect?: Partial<Record<string, () => void | Promise<void>>>;
    /**
     * Re-authorise ONE named account. Distinct from `onConnect`: it tells the
     * server which connection the incoming grant belongs to, which is what lets a
     * connection that predates the identity permission adopt one instead of being
     * refused as an unmatched identity.
     */
    onReconnect?: (account: AccountRow) => void | Promise<void>;
    /** Host-owned review flow; the panel does not decide business ownership. */
    onAssignProfile?: (account: AccountRow) => void;
    /** Include inactive sign-ins in an account administration surface. */
    includeDisconnected?: boolean;
    /** Refresh host counts after a successful account mutation. */
    onChanged?: () => void;
    /** Host-supplied action wording; null holds unavailable connectors without a dead button. */
    reconnectLabelForAccount?: (account: AccountRow) => string | null;
    /**
     * Change this to force a refetch. The host owns the events that mean "an
     * account changed outside this panel" — an OAuth popup reporting back, say —
     * and a DS component should not be listening for app-specific window messages
     * to find that out.
     */
    reloadSignal?: unknown;
    /** The host app's confirm dialog. Falls back to a plain one when absent. */
    confirm?: (opts: {
        title: string;
        description: string;
        confirmLabel: string;
        tone?: 'danger' | 'warning' | 'info';
    }) => Promise<boolean>;
    className?: string;
    /**
     * Test seam — when provided, the initial fetch is skipped and the panel renders
     * this payload. Mutations and Test still refetch. Same seam as `AccountSwitcher`.
     */
    initialData?: AccountsPayload;
}
export declare function AccountsPanel({ apiBase, onConnect, onReconnect, onAssignProfile, includeDisconnected, onChanged, reconnectLabelForAccount, confirm, className, reloadSignal, initialData, }: AccountsPanelProps): import("react/jsx-runtime").JSX.Element;
