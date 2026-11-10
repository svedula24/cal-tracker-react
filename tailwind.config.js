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
        'entry': '#F8F7FC',
        'chip': '#F6F5FA',
        health: '#82DE7A',
        'tab-active': '#E8E8EA',
        fab: '#1E1A24',
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
