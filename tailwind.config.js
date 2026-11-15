/** @type {import('tailwindcss').Config} */
// Kalo design tokens. Keep in sync with src/lib/tokens.ts (runtime values).
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  // NativeWind's web runtime manages color scheme via a class observer; without
  // this it throws "Cannot manually set color scheme, as dark mode is type 'media'".
  darkMode: 'class',
  theme: {
    extend: {
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
        'entry': '#F6EEE5',
        'chip': '#F1E8DE',
        health: '#82DE7A',
        'tab-active': '#EADFD3',
        fab: '#6B4430',
        accent: '#6B4430',
      },
      borderRadius: {
        card: '18px',
        tile: '16px',
      },
      fontFamily: {
        sans: ['System'],
      },
    },
  },
  plugins: [],
};
