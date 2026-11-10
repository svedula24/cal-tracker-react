import { useState } from 'react';
import { Platform, View } from 'react-native';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';

import { tokens } from '@/lib/tokens';

export type BarDay = { key: string; letter: string; value: number; isToday: boolean };

const CHART_H = 150;
const LABEL_H = 22;
const TOP_PAD = 18;
// SVG text falls back to a serif face on web; match the app's system font.
const FONT = Platform.OS === 'web' ? '-apple-system, system-ui, Helvetica, Arial, sans-serif' : undefined;

/** 7-day calorie bars with a dashed goal line. Today's bar is black. */
export function WeekBars({ days, goal }: { days: BarDay[]; goal: number }) {
  const [width, setWidth] = useState(0);
  const max = Math.max(goal, ...days.map((d) => d.value), 1) * 1.08;
  const plotH = CHART_H - TOP_PAD;
  const y = (v: number) => TOP_PAD + plotH - (v / max) * plotH;
  const slot = width / Math.max(days.length, 1);
  const barW = Math.min(28, slot * 0.55);
  const goalY = y(goal);

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height: CHART_H + LABEL_H }}
      accessibilityLabel={`Calories chart: ${days.map((d) => `${d.letter} ${d.value}`).join(', ')}; goal ${goal}`}
    >
      {width > 0 ? (
        <Svg width={width} height={CHART_H + LABEL_H}>
          {days.map((d, i) => {
            const h = Math.max(d.value > 0 ? 4 : 0, CHART_H - y(d.value));
            const x = i * slot + (slot - barW) / 2;
            return (
              <Rect
                key={d.key}
                x={x}
                y={CHART_H - h}
                width={barW}
                height={h}
                rx={Math.min(8, barW / 2)}
                fill={d.isToday ? tokens.colors.foreground : tokens.colors.faint}
              />
            );
          })}
          <Line
            x1={0}
            x2={width}
            y1={goalY}
            y2={goalY}
            stroke={tokens.colors.muted}
            strokeWidth={1.5}
            strokeDasharray="5 5"
          />
          <SvgText x={width} y={goalY - 5} fontSize={11} fontFamily={FONT} fill={tokens.colors.muted} textAnchor="end">
            {`Goal ${goal}`}
          </SvgText>
          {days.map((d, i) => (
            <SvgText
              key={`l-${d.key}`}
              x={i * slot + slot / 2}
              y={CHART_H + 16}
              fontSize={13}
              fontFamily={FONT}
              fontWeight={d.isToday ? '700' : '400'}
              fill={d.isToday ? tokens.colors.foreground : tokens.colors.muted}
              textAnchor="middle"
            >
              {d.letter}
            </SvgText>
          ))}
        </Svg>
      ) : null}
    </View>
  );
}
