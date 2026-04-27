/**
 * Navigation type definitions for the Amazon SC-style sidebar.
 */

export interface NavItemConfig {
  /** Display label */
  label: string;
  /** Route path */
  href: string;
  /** Emoji or icon identifier */
  icon?: string;
  /** Optional badge count (e.g., "3 drafts") */
  badge?: number;
  /** Whether this item is disabled / coming soon */
  disabled?: boolean;
}

export interface NavSectionConfig {
  /** Section identifier */
  id: string;
  /** Section header label (e.g., "CATALOG") */
  label: string;
  /** Emoji icon for the section header */
  icon: string;
  /** Navigation items within this section */
  items: NavItemConfig[];
}
