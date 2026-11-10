import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';

import { tokens } from '@/lib/tokens';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const TIMING = { duration: 650, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System };

/**
 * Circular progress ring. `progress` 0..1 is drawn clockwise from 12 o'clock
 * with round caps; values above 1 draw a full ring. Children sit in the centre.
 * The arc fills in on mount and eases to each new value.
 */
export function Ring({
  size,
  stroke,
  progress,
  color,
  track = tokens.colors.track,
  children,
}: {
  size: number;
  stroke: number;
  progress: number;
  color: string;
  track?: string;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  const shown = useSharedValue(0);
  useEffect(() => {
    shown.value = withTiming(p, TIMING);
  }, [p, shown]);
  const arc = useAnimatedProps(() => ({
    strokeDasharray: `${c * shown.value} ${c}`,
    // A zero-length dash with round caps still draws a dot: hide it.
    opacity: shown.value > 0.001 ? 1 : 0,
  }));
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <AnimatedCircle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" animatedProps={arc} />
      </Svg>
      {children}
    </View>
  );
}
