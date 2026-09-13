/**
 * Z-index tokens — the stacking layers H10 actually uses. Kept compatible with
 * the app's lib/theme/index.ts Z_INDEX where the roles line up; the full-screen
 * builder + portal tooltip sit above everything (rendered into <body>).
 */
export declare const zIndex: {
    readonly base: 1;
    readonly dropdown: 40;
    readonly libpop: 45;
    readonly backdropBtn: 49;
    readonly rail: 50;
    readonly modalBackdrop: 60;
    readonly toast: 70;
    readonly builder: 120;
    readonly tooltip: 1000;
};
