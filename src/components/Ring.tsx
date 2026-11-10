import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { tokens } from '@/lib/tokens';

/**
 * Circular progress ring. `progress` 0..1 is drawn clockwise from 12 o'clock
 * with round caps; values above 1 draw a full ring. Children sit in the centre.
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
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        {p > 0 ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${c * p} ${c}`}
          />
        ) : null}
      </Svg>
      {children}
    </View>
  );
}
