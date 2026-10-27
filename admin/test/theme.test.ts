import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/color.ts';
import { adminTheme, FONT_STACK, palette, typeScale } from '../src/theme.ts';

describe('design tokens', () => {
  it('map the spec palette onto Ant Design tokens', () => {
    expect(adminTheme.token).toMatchObject({
      colorPrimary: '#2F6F68',
      colorText: '#24343B',
      colorBgLayout: '#F6F8F7',
      colorBorder: '#DCE3E1',
      colorWarning: '#B7791F',
      colorError: '#B42318',
      borderRadius: 6,
      fontSize: 15,
    });
    expect(typeScale).toEqual({ caption: 13, body: 15, rowTitle: 17, pageTitle: 22, brief: 30 });
  });

  it('keep every text colour at WCAG AA on the page and on white', () => {
    for (const text of [palette.ink, palette.celadon, palette.cinnabar, palette.amberText]) {
      expect(contrastRatio(text, palette.paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(text, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    }
    // Primary buttons: white label on celadon.
    expect(contrastRatio('#FFFFFF', palette.celadon)).toBeGreaterThanOrEqual(4.5);
  });

  it('does not use the bar-only amber as a text colour', () => {
    expect(contrastRatio(palette.amber, palette.paper)).toBeLessThan(4.5);
  });

  it('uses the Branch B system font stack (A2: no bundled HarmonyOS Sans)', () => {
    expect(FONT_STACK).toBe('"PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif');
    expect(FONT_STACK).not.toContain('HarmonyOS');
    expect(adminTheme.token?.fontFamily).toBe(FONT_STACK);
  });
});
