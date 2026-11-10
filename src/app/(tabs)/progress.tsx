import { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { Card, TabScreen } from '@/components/Screen';
import { TAB_BAR_SPACE } from '@/components/TabBar';
import { WeekBars, type BarDay } from '@/components/secondary/WeekBars';
import { useEntries, useGoals } from '@/lib/data';
import { addDays, dayKey, sum, type Nutrients } from '@/lib/nutrition';

const MACROS = [
  { key: 'protein', label: 'Protein', bar: 'bg-protein' },
  { key: 'carbs', label: 'Carbs', bar: 'bg-carbs' },
  { key: 'fat', label: 'Fat', bar: 'bg-fat' },
] as const;

export default function Progress() {
  const { items } = useEntries();
  const { goals } = useGoals();

  const week = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const date = addDays(now, i - 6);
      const key = dayKey(date);
      const totals = sum(items.filter((e) => e.date === key));
      return {
        key,
        letter: date.toLocaleDateString('en-US', { weekday: 'short' }).charAt(0),
        isToday: i === 6,
        totals,
        logged: items.some((e) => e.date === key),
      };
    });
  }, [items]);

  const bars: BarDay[] = week.map((d) => ({ key: d.key, letter: d.letter, value: d.totals.calories, isToday: d.isToday }));
  const loggedDays = week.filter((d) => d.logged);
  const avg = (k: keyof Nutrients) =>
    loggedDays.length ? Math.round(loggedDays.reduce((s, d) => s + d.totals[k], 0) / loggedDays.length) : 0;
  const avgCalories = avg('calories');

  return (
    <TabScreen title="Progress">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: TAB_BAR_SPACE, gap: 12 }}>
        <Card className="p-5">
          <Text className="text-[17px] font-semibold text-foreground">Calories, last 7 days</Text>
          <Text className="mb-4 mt-1 text-[14px] text-muted">Dashed line is your {goals.calories} kcal goal</Text>
          <WeekBars days={bars} goal={goals.calories} />
        </Card>

        <Card className="p-5">
          <Text className="text-[17px] font-semibold text-foreground">Daily averages (7 days)</Text>
          <View className="mt-3 flex-row items-baseline">
            <Text className="text-[34px] font-bold text-foreground">{avgCalories}</Text>
            <Text className="ml-1 text-[16px] text-muted">/{goals.calories} kcal</Text>
          </View>
          <Text className="text-[14px] text-muted">
            {loggedDays.length ? `Average across ${loggedDays.length} logged ${loggedDays.length === 1 ? 'day' : 'days'}` : 'No days logged yet'}
          </Text>
          <View className="mt-4 gap-4">
            {MACROS.map((m) => {
              const value = avg(m.key);
              const goal = goals[m.key];
              const pct = goal > 0 ? Math.min(1, value / goal) : 0;
              return (
                <View key={m.key} accessibilityLabel={`${m.label} average ${value} of ${goal} grams`}>
                  <View className="mb-1.5 flex-row items-baseline justify-between">
                    <Text className="text-[15px] text-foreground">{m.label}</Text>
                    <Text className="text-[15px] font-semibold text-foreground">
                      {value}
                      <Text className="font-normal text-muted"> /{goal}g</Text>
                    </Text>
                  </View>
                  <View className="h-2 overflow-hidden rounded-full bg-track">
                    <View className={`h-2 rounded-full ${m.bar}`} style={{ width: `${pct * 100}%` }} />
                  </View>
                </View>
              );
            })}
          </View>
        </Card>

        <Card className="p-5">
          <Text className="text-[17px] font-semibold text-foreground">Logged days</Text>
          <View className="mt-2 flex-row items-baseline">
            <Text className="text-[34px] font-bold text-foreground">{loggedDays.length}</Text>
            <Text className="ml-1 text-[16px] text-muted">of 7 days logged</Text>
          </View>
          <View className="mt-3 flex-row justify-between">
            {week.map((d) => (
              <View key={d.key} className="items-center">
                <View className={`h-3 w-3 rounded-full ${d.logged ? 'bg-foreground' : 'bg-track'}`} />
                <Text className={`mt-1.5 text-[12px] ${d.isToday ? 'font-bold text-foreground' : 'text-muted'}`}>{d.letter}</Text>
              </View>
            ))}
          </View>
        </Card>
      </ScrollView>
    </TabScreen>
  );
}
