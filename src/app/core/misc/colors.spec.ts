import { getDefaultColor } from './colors';

describe('getDefaultColor', () => {
  it('cycles through the palette instead of falling back to white', () => {
    const colors = Array.from({ length: 32 }, (_, i) => getDefaultColor(i));
    expect(colors).not.toContain('#ffffff');
    expect(getDefaultColor(26)).toBe(getDefaultColor(0));
    expect(new Set(colors.slice(0, 26)).size).toBe(26);
  });
});
