// Runtime design tokens for Kalo (values estimated from the reference
// screenshots; refined in the diff loop). Use NativeWind classes for styling;
// use these where a className can't reach (SVG strokes, StatusBar, icons).
// Keep in sync with tailwind.config.js.
export const tokens = {
  colors: {
    background: '#FFFFFF',
    card: '#FFFFFF',
    foreground: '#111111',
    muted: '#8E8E93',
    faint: '#C7C7CC',
    track: '#EFEFF5',
    border: '#EEEEF3',
    protein: '#DF6767',
    carbs: '#DC9A69',
    fat: '#6A98DC',
    fiber: '#A089CD',
    sugar: '#E890AE',
    sodium: '#EAB771',
    good: '#28A96C',
    bad: '#E14945',
    water: '#5AA9E6',
    entry: '#F8F7FC',
    chip: '#F6F5FA',
    health: '#82DE7A',
    tabActive: '#E8E8EA',
    fab: '#1E1A24',
  },
  fonts: { sans: 'System' },
  radii: { card: 18, tile: 16, pill: 999 },
  spacing: { screenX: 22, gap: 10 },
} as const;

export type Tokens = typeof tokens;
