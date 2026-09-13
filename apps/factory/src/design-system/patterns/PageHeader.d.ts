import type { ReactNode } from 'react';
export interface PageHeaderProps {
    eyebrow?: ReactNode;
    title: ReactNode;
    subtitle?: ReactNode;
    /** right-aligned actions slot (buttons, selects, date range…) */
    actions?: ReactNode;
}
/** List-page header (H10 `.h10-hdr`): eyebrow + title + subtitle, actions right. */
export declare function PageHeader({ eyebrow, title, subtitle, actions }: PageHeaderProps): import("react/jsx-runtime").JSX.Element;
