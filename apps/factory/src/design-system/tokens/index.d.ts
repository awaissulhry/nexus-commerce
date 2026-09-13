/**
 * Token barrel — the single import surface for JS/TS consumers.
 *
 *   import { color, space, radius, shadow } from '@/design-system/tokens'
 *
 * CSS consumers use the matching `var(--nds-*)` from ../styles/tokens.css.
 */
export * from './colors';
export * from './typography';
export * from './spacing';
export * from './radius';
export * from './shadow';
export * from './motion';
export * from './zindex';
export * from './breakpoints';
export * from './grid';
/** Aggregate accessor for ergonomic destructuring: `const { color } = tokens`. */
export declare const tokens: {
    readonly palette: {
        readonly white: "#ffffff";
        readonly blue: {
            readonly 50: "#eef5ff";
            readonly 100: "#e7f0fd";
            readonly 200: "#cfe0fb";
            readonly 600: "#1f6fde";
            readonly 700: "#1a60c4";
            readonly 800: "#134da3";
            readonly 900: "#0a4ba8";
        };
        readonly grey: {
            readonly 25: "#f7f9fb";
            readonly 50: "#f4f6f9";
            readonly 75: "#f1f4f8";
            readonly 100: "#eef1f5";
            readonly 150: "#e6e9ee";
            readonly 200: "#d8dde4";
            readonly 300: "#c2c9d3";
            readonly 400: "#aeb6c2";
            readonly 450: "#98a2b3";
            readonly 500: "#8a93a1";
            readonly 600: "#5b6573";
            readonly 700: "#3a4452";
            readonly 800: "#2b3440";
            readonly 900: "#1c2530";
        };
        readonly railBg: "#f1f3f5";
        readonly railBorder: "#e3e7ec";
        readonly green: {
            readonly soft: "#dcfce7";
            readonly 500: "#1e9e62";
            readonly 600: "#15a34a";
            readonly 700: "#15803d";
        };
        readonly red: {
            readonly soft: "#fde8e8";
            readonly 500: "#e5484d";
            readonly 600: "#d4493f";
            readonly 700: "#c0392b";
        };
        readonly amber: {
            readonly soft: "#fdf3d3";
            readonly 600: "#b87503";
            readonly 700: "#c2410c";
            readonly text: "#9a6700";
        };
        readonly purple: {
            readonly bg: "#f3e8ff";
            readonly 600: "#7400bc";
            readonly 700: "#6d28d9";
        };
        readonly cyan: {
            readonly bg: "#e0f2fe";
            readonly 700: "#0e7490";
        };
        readonly amazon: "#232f3e";
    };
    readonly color: {
        readonly text: "#1c2530";
        readonly text2: "#5b6573";
        readonly text3: "#8a93a1";
        readonly textStrong: "#3a4452";
        readonly textDisabled: "#aeb6c2";
        readonly textInverse: "#ffffff";
        readonly textLink: "#1f6fde";
        readonly bg: "#f4f6f9";
        readonly surface: "#ffffff";
        readonly surfaceRaised: "#f7f9fb";
        readonly surfaceSunken: "#eef1f5";
        readonly surfaceHover: "#f1f4f8";
        readonly washPrimary: "#eef5ff";
        readonly railBg: "#f1f3f5";
        readonly border: "#d8dde4";
        readonly borderSubtle: "#e6e9ee";
        readonly borderStrong: "#c2c9d3";
        readonly railBorder: "#e3e7ec";
        readonly primary: "#1f6fde";
        readonly primaryHover: "#1a60c4";
        readonly primaryDark: "#134da3";
        readonly primarySoft: "#e7f0fd";
        readonly primaryGhostBorder: "#cfe0fb";
        readonly successSoft: "#dcfce7";
        readonly success: "#15a34a";
        readonly successStrong: "#15803d";
        readonly live: "#1e9e62";
        readonly dangerSoft: "#fde8e8";
        readonly danger: "#e5484d";
        readonly dangerStrong: "#c0392b";
        readonly warningSoft: "#fdf3d3";
        readonly warning: "#b87503";
        readonly warningStrong: "#c2410c";
        readonly infoSoft: "#e7f0fd";
        readonly info: "#1f6fde";
        readonly amazon: "#232f3e";
    };
    readonly pill: {
        readonly ok: {
            readonly fg: "#0a4ba8";
            readonly bg: "#d2e6fc";
        };
        readonly warn: {
            readonly fg: "#9a6700";
            readonly bg: "#fdf3d3";
        };
        readonly arch: {
            readonly fg: "#6b7480";
            readonly bg: "#eef1f5";
        };
    };
    readonly badge: {
        readonly sp: {
            readonly fg: "#6d28d9";
            readonly bg: "#f3e8ff";
        };
        readonly sd: {
            readonly fg: "#0e7490";
            readonly bg: "#e0f2fe";
        };
        readonly sb: {
            readonly fg: "#c2410c";
            readonly bg: "#fef3c7";
        };
        readonly targetingAuto: "#134da3";
        readonly targetingManual: "#7400bc";
    };
    readonly fontFamily: {
        readonly sans: "var(--font-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    };
    readonly fontSize: {
        readonly nano: "9px";
        readonly micro: "10px";
        readonly microPlus: "10.5px";
        readonly xs: "11px";
        readonly xsPlus: "11.5px";
        readonly sm: "12px";
        readonly smPlus: "12.5px";
        readonly base: "13px";
        readonly basePlus: "13.5px";
        readonly mdMinus: "14px";
        readonly md: "15px";
        readonly lg: "18px";
        readonly xl: "22px";
        readonly '2xl': "27px";
    };
    readonly fontWeight: {
        readonly normal: 400;
        readonly medium: 500;
        readonly semibold: 600;
        readonly bold: 700;
        readonly extrabold: 800;
    };
    readonly letterSpacing: {
        readonly tight: "-0.02em";
        readonly snug: "-0.01em";
        readonly wide: "0.03em";
        readonly wider: "0.04em";
    };
    readonly lineHeight: {
        readonly tight: 1.2;
        readonly snug: 1.45;
        readonly normal: 1.5;
    };
    readonly fontSmoothing: "auto";
    readonly space: {
        readonly px1: "1px";
        readonly px2: "2px";
        readonly px3: "3px";
        readonly px4: "4px";
        readonly px5: "5px";
        readonly px6: "6px";
        readonly px7: "7px";
        readonly px8: "8px";
        readonly px9: "9px";
        readonly px10: "10px";
        readonly px11: "11px";
        readonly px12: "12px";
        readonly px14: "14px";
        readonly px16: "16px";
        readonly px18: "18px";
        readonly px20: "20px";
        readonly px22: "22px";
        readonly px24: "24px";
        readonly px26: "26px";
        readonly px30: "30px";
        readonly px32: "32px";
        readonly px40: "40px";
        readonly px48: "48px";
    };
    readonly size: {
        readonly railCollapsed: "66px";
        readonly railExpanded: "344px";
        readonly rowNav: "46px";
        readonly rowGrid: "30px";
        readonly iconZone: "50px";
    };
    readonly radius: {
        readonly xs: "3px";
        readonly pill: "999px";
        readonly sm: "6px";
        readonly md: "7px";
        readonly lg: "8px";
        readonly xl: "10px";
        readonly '2xl': "12px";
        readonly '3xl': "14px";
        readonly full: "999px";
        readonly round: "999px";
    };
    readonly shadow: {
        readonly card: "0 6px 22px rgba(20, 28, 38, 0.16)";
        readonly menu: "0 12px 30px rgba(20, 28, 38, 0.16)";
        readonly pop: "0 16px 40px rgba(20, 28, 38, 0.2)";
        readonly modal: "0 18px 48px rgba(20, 28, 38, 0.28)";
        readonly rail: "8px 0 30px rgba(20, 28, 38, 0.13)";
        readonly tip: "0 10px 26px rgba(20, 28, 38, 0.3)";
    };
    readonly focusRing: "0 0 0 2px rgba(31, 111, 222, 0.12)";
    readonly shadowColor: "20 28 38";
    readonly duration: {
        readonly micro: "120ms";
        readonly label: "140ms";
        readonly control: "150ms";
        readonly panel: "180ms";
    };
    readonly easing: {
        readonly standard: "ease";
        readonly out: "cubic-bezier(0.16, 1, 0.3, 1)";
    };
    readonly durationMs: {
        readonly micro: 120;
        readonly label: 140;
        readonly control: 150;
        readonly panel: 180;
    };
    readonly zIndex: {
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
    readonly breakpoint: {
        readonly md: "1320px";
        readonly sm: "760px";
    };
    readonly mediaQuery: {
        readonly belowMd: "(max-width: 1320px)";
        readonly belowSm: "(max-width: 760px)";
    };
    readonly grid: {
        readonly density: {
            readonly compact: {
                readonly rowText: 28;
                readonly rowMedia: 52;
                readonly rowMediaLine: 36;
                readonly header: 28;
                readonly thumb: 32;
                readonly cellPadX: 10;
            };
            readonly cozy: {
                readonly rowText: 43;
                readonly rowMedia: 68;
                readonly rowMediaLine: 44;
                readonly header: 38;
                readonly thumb: 40;
                readonly cellPadX: 14;
            };
            readonly spacious: {
                readonly rowText: 49;
                readonly rowMedia: 85;
                readonly rowMediaLine: 60;
                readonly header: 46;
                readonly thumb: 56;
                readonly cellPadX: 14;
            };
        };
        readonly geometry: {
            readonly stripH: 30;
            readonly footerRowH: 48;
            readonly selectColW: 43;
            readonly identityW: 320;
            readonly partitionW: 2;
            readonly partitionRatio: 0.3;
            readonly checkboxSize: 16;
        };
        readonly type: {
            readonly headerSize: 11.5;
            readonly headerWeight: 700;
            readonly cellSize: 13;
            readonly cellWeight: 500;
            readonly stripSize: 11;
            readonly stripWeight: 700;
            readonly stripTracking: "0.05em";
        };
    };
};
