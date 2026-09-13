import type { ReactNode } from 'react';
/** Ad program (Sponsored Products/Display/Brands) + targeting (Auto/Manual). */
export type AdProgram = 'sp' | 'sd' | 'sb' | 'auto' | 'manual';
export interface BadgeProps {
    program: AdProgram;
    className?: string;
    children: ReactNode;
}
export declare function Badge({ program, className, children }: BadgeProps): import("react/jsx-runtime").JSX.Element;
