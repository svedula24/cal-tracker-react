import { Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { tokens } from '@/lib/tokens';

// Kalo mark: a "K" whose upper arm is a flame (with a cut-out inner tongue).
// Same paths as scripts/render-icons.mjs, which renders the app icons.
export const MARK_PATHS = {
  leg: 'M28 57 L49 44 L85 84.5 Q88 90 81.5 90 L67 90 Q63 90 61 87.5 L28 62 Z',
  flame:
    'M28 62 C30 48 42 42 51 36 C59 30.5 64 23 62 8 C76 16 86 30 85 45 C84.5 56 77 63 66 64.5 C51 66.5 40 65 28 62 Z ' +
    'M58 58.5 C66 58 72 53 72 46 C72 40.5 69 36 64.5 33 C64.5 41 60 45 55 49 C52 51.5 52 56 58 58.5 Z',
};

export function KaloMark({ size = 40, color = tokens.colors.foreground }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessibilityLabel="Kalo logo">
      <Rect x={14} y={10} width={20} height={80} rx={5} fill={color} />
      <Path d={MARK_PATHS.leg} fill={color} />
      <Path d={MARK_PATHS.flame} fill={color} fillRule="evenodd" />
    </Svg>
  );
}

export function KaloLogo() {
  return (
    <View className="flex-row items-center" accessibilityRole="header">
      <KaloMark size={42} />
      <Text className="ml-1 text-[34px] font-bold tracking-tight text-foreground">Kalo</Text>
    </View>
  );
}
