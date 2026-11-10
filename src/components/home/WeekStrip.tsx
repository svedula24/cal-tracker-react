import { Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { Press } from '@/components/Press';
import { cardShadow } from '@/components/Screen';
import { Ring } from '@/components/Ring';
import { dayBudget, useDayLogs, useEntries, useGoals } from '@/lib/data';
import { dayStatus, sum, weekStrip } from '@/lib/nutrition';
import { tokens } from '@/lib/tokens';

const SIZE = 35;

/** Five past days, today, tomorrow. Past rings: green on goal, red off goal. */
export function WeekStrip({ selected, onSelect, todayProgress }: { selected: string; onSelect: (key: string) => void; todayProgress: number }) {
  const entries = useEntries().items;
  const { goals } = useGoals();
  const logs = useDayLogs().items;
  const days = weekStrip();
  return (
    <View className="flex-row justify-between px-[8px]">
      {days.map((d) => {
        const active = d.key === selected;
        const eaten = sum(entries.filter((e) => e.date === d.key)).calories;
        const status = dayStatus(eaten, dayBudget(goals.calories, logs.find((l) => l.id === d.key)));
        return (
          <Press
            key={d.key}
            disabled={d.isFuture}
            accessibilityRole="button"
            accessibilityLabel={`${d.label} ${d.day}`}
            accessibilityState={{ selected: active, disabled: d.isFuture }}
            onPress={() => onSelect(d.key)}
            className={`w-[49px] items-center rounded-[15px] pb-[7px] pt-[9px] ${active ? 'bg-card' : ''}`}
            style={active ? cardShadow : undefined}
          >
            <Text className={`mb-[6px] text-[12.5px] ${d.isFuture ? 'text-faint' : active ? 'font-medium text-foreground' : 'text-muted'}`}>
              {d.label}
            </Text>
            {d.isToday ? (
              <Ring size={SIZE} stroke={1.8} progress={todayProgress} color={tokens.colors.foreground}>
                <Text className="text-[15px] text-foreground">{d.day}</Text>
              </Ring>
            ) : (
              <View style={{ width: SIZE, height: SIZE }} className="items-center justify-center">
                <Svg width={SIZE} height={SIZE} style={{ position: 'absolute' }}>
                  <Circle
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={SIZE / 2 - 1}
                    fill="none"
                    strokeWidth={1.8}
                    stroke={d.isFuture || status === 'none' ? tokens.colors.track : status === 'good' ? tokens.colors.good : tokens.colors.bad}
                    strokeDasharray={!d.isFuture && status === 'none' ? '3 3' : undefined}
                  />
                </Svg>
                <Text className={`text-[15px] ${d.isFuture ? 'text-faint' : 'text-foreground'}`}>{d.day}</Text>
              </View>
            )}
          </Press>
        );
      })}
    </View>
  );
}
