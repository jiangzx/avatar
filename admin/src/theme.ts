import type { ThemeConfig } from 'antd';

/** spec「界面设计 / 色彩」. amberText is derived: amber itself fails AA as text. */
export const palette = {
  ink: '#24343B',
  celadon: '#2F6F68',
  paper: '#F6F8F7',
  mist: '#DCE3E1',
  amber: '#B7791F',
  amberText: '#8A5A12',
  cinnabar: '#B42318',
  white: '#FFFFFF',
  celadonTint: '#E6EFED',
} as const;

// Branch B (A2): HarmonyOS Sans cannot be bundled unmodified as WOFF2, so use the system stack.
export const FONT_STACK = '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';

export const typeScale = { caption: 13, body: 15, rowTitle: 17, pageTitle: 22, brief: 30 } as const;

/**
 * Bar colours per character, chosen and checked with the dataviz method (P2-T7 Step 4).
 * validate_palette.js --mode light --pairs all --surface "#F6F8F7" and "#FFFFFF":
 * all checks pass; worst all-pairs CVD dE 13.1 (protan), normal-vision dE 21.7.
 */
export const CHARACTER_COLORS: Record<string, string> = {
  xiaonuan: '#0E8F7D',
  xiaokai: '#6A4C93',
  xiaoxin: '#C25E00',
};

export const adminTheme: ThemeConfig = {
  token: {
    colorPrimary: palette.celadon,
    colorText: palette.ink,
    colorBgLayout: palette.paper,
    colorBorder: palette.mist,
    colorWarning: palette.amber,
    colorError: palette.cinnabar,
    colorLink: palette.celadon,
    borderRadius: 6,
    fontFamily: FONT_STACK,
    fontSize: typeScale.body,
    lineHeight: 1.7,
  },
  components: {
    Layout: { siderBg: palette.white, bodyBg: palette.paper, headerBg: palette.paper },
    Menu: { itemSelectedBg: palette.celadonTint, itemSelectedColor: palette.celadon, groupTitleColor: palette.ink },
    Table: { headerBg: palette.paper },
  },
};
