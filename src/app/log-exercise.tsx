import { router } from 'expo-router';
import { Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { PrimaryButton } from '@/components/logging/PrimaryButton';
import { Card, PushedScreen } from '@/components/Screen';
import { exerciseCalories, nowOn, useExercise, type Exercise } from '@/lib/data';
import { formatTime, parseDay, todayKey } from '@/lib/nutrition';
import { useSelectedDay } from '@/lib/selectedDay';
import { makeId } from '@/lib/store';
import { tokens } from '@/lib/tokens';

const TYPES = ['Run', 'Walk', 'Cycle', 'Weights', 'Swim', 'Other'] as const;
const QUICK = [15, 30, 45, 60] as const;
const INTENSITIES: { key: Exercise['intensity']; label: string }[] = [
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
];

function Chip({ label, selected, onPress, accessibilityLabel }: { label: string; selected: boolean; onPress: () => void; accessibilityLabel?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`h-10 items-center justify-center rounded-full px-4 ${selected ? 'bg-foreground' : 'bg-chip'}`}
    >
      <Text className={`text-[15px] font-medium ${selected ? 'text-card' : 'text-foreground'}`}>{label}</Text>
    </Pressable>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mt-6">
      <Text className="mb-2.5 text-[15px] font-semibold text-foreground">{title}</Text>
      {children}
    </View>
  );
}

export default function LogExercise() {
  const [day] = useSelectedDay();
  const exercise = useExercise();
  const [type, setType] = useState<string>('Run');
  const [minutesText, setMinutesText] = useState('30');
  const [intensity, setIntensity] = useState<Exercise['intensity']>('medium');

  const minutes = Math.max(0, parseInt(minutesText, 10) || 0);
  const calories = exerciseCalories(minutes, intensity);
  const logged = exercise.items.filter((e) => e.date === day).sort((a, b) => b.time.localeCompare(a.time));
  const listTitle =
    day === todayKey()
      ? "Today's exercise"
      : `Exercise · ${parseDay(day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;

  const onLog = () => {
    if (minutes <= 0) return;
    exercise.add({ id: makeId(), date: day, time: nowOn(day), type, minutes, intensity, calories });
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <PushedScreen title="Log exercise">
      <ScrollView contentContainerClassName="px-[22px] pb-12" keyboardShouldPersistTaps="handled">
        <Section title="Type">
          <View className="flex-row flex-wrap gap-2">
            {TYPES.map((t) => (
              <Chip key={t} label={t} selected={type === t} onPress={() => setType(t)} />
            ))}
          </View>
        </Section>

        <Section title="Minutes">
          <Card className="flex-row items-center px-4 py-3">
            <TextInput
              accessibilityLabel="Minutes"
              value={minutesText}
              onChangeText={(t) => setMinutesText(t.replace(/[^0-9]/g, '').slice(0, 3))}
              keyboardType="number-pad"
              inputMode="numeric"
              placeholder="0"
              placeholderTextColor={tokens.colors.faint}
              className="flex-1 text-[28px] font-bold text-foreground"
            />
            <Text className="text-[15px] text-muted">min</Text>
          </Card>
          <View className="mt-2.5 flex-row gap-2">
            {QUICK.map((m) => (
              <Chip
                key={m}
                label={`${m}`}
                accessibilityLabel={`${m} minutes`}
                selected={minutes === m}
                onPress={() => setMinutesText(String(m))}
              />
            ))}
          </View>
        </Section>

        <Section title="Intensity">
          <View accessibilityRole="radiogroup" className="flex-row rounded-full bg-track p-1">
            {INTENSITIES.map(({ key, label }) => {
              const selected = intensity === key;
              return (
                <Pressable
                  key={key}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ checked: selected }}
                  onPress={() => setIntensity(key)}
                  className={`h-10 flex-1 items-center justify-center rounded-full ${selected ? 'bg-card' : ''}`}
                >
                  <Text className={`text-[15px] ${selected ? 'font-semibold text-foreground' : 'text-muted'}`}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        <View className="mt-7 items-center">
          <Text className="text-[30px] font-bold text-foreground">≈ {calories} cal</Text>
          <Text className="mt-0.5 text-[13px] text-muted">estimated burn</Text>
        </View>
        <PrimaryButton label="Log exercise" onPress={onLog} disabled={minutes <= 0} className="mt-4" />

        <Section title={listTitle}>
          {logged.length === 0 ? (
            <Text className="text-[14px] text-muted">Nothing logged yet.</Text>
          ) : (
            <View className="gap-2.5">
              {logged.map((e) => (
                <Card key={e.id} className="flex-row items-center px-4 py-3.5">
                  <View className="flex-1">
                    <Text className="text-[16px] font-medium text-foreground">{e.type}</Text>
                    <Text className="mt-0.5 text-[13px] text-muted">
                      {e.minutes} min · {e.intensity[0].toUpperCase() + e.intensity.slice(1)} · {formatTime(e.time)}
                    </Text>
                  </View>
                  <Text className="mr-2 text-[15px] font-semibold text-foreground">{e.calories} cal</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${e.type}`}
                    onPress={() => exercise.remove(e.id)}
                    hitSlop={8}
                    className="h-9 w-9 items-center justify-center rounded-full"
                  >
                    <Trash2 size={18} color={tokens.colors.muted} />
                  </Pressable>
                </Card>
              ))}
            </View>
          )}
        </Section>
      </ScrollView>
    </PushedScreen>
  );
}
