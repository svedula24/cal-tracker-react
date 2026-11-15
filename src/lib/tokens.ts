// Runtime design tokens for Kalo (values estimated from the reference
// screenshots; refined in the diff loop). Use NativeWind classes for styling;
// use these where a className can't reach (SVG strokes, StatusBar, icons).
// Keep in sync with tailwind.config.js.
export const tokens = {
  colors: {
    background: '#FBF7F2',
    card: '#FFFFFF',
    foreground: '#2B1D14',
    muted: '#857668',
    faint: '#CDBFB2',
    track: '#EFE6DC',
    border: '#EADFD3',
    protein: '#DF6767',
    carbs: '#DC9A69',
    fat: '#6A98DC',
    fiber: '#A089CD',
    sugar: '#E890AE',
    sodium: '#EAB771',
    good: '#28A96C',
    bad: '#E14945',
    entry: '#F6EEE5',
    chip: '#F1E8DE',
    health: '#82DE7A',
    tabActive: '#EADFD3',
    fab: '#6B4430',
    // The brand brown, for progress rings and other accents (the + button and main buttons use `fab`).
    accent: '#6B4430',
  },
  fonts: { sans: 'System' },
  radii: { card: 18, tile: 16, pill: 999 },
  spacing: { screenX: 22, gap: 10 },
} as const;

export type Tokens = typeof tokens;
