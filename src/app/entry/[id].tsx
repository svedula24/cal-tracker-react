import { router, useLocalSearchParams } from 'expo-router';
import { Flame } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { PrimaryButton } from '@/components/logging/PrimaryButton';
import { ServingsStepper } from '@/components/logging/Stepper';
import { Card, PushedScreen } from '@/components/Screen';
import { useEntries } from '@/lib/data';
import { formatTime, type Nutrients } from '@/lib/nutrition';
import { tokens } from '@/lib/tokens';

const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

const ROWS: { key: keyof Nutrients; label: string; unit: string; color: string }[] = [
  { key: 'protein', label: 'Protein', unit: 'g', color: tokens.colors.protein },
  { key: 'carbs', label: 'Carbs', unit: 'g', color: tokens.colors.carbs },
  { key: 'fat', label: 'Fat', unit: 'g', color: tokens.colors.fat },
  { key: 'fiber', label: 'Fiber', unit: 'g', color: tokens.colors.fiber },
  { key: 'sugar', label: 'Sugar', unit: 'g', color: tokens.colors.sugar },
  { key: 'sodium', label: 'Sodium', unit: 'mg', color: tokens.colors.sodium },
];

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

export default function EntryDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { items, ready, update, remove } = useEntries();
  const entry = items.find((e) => e.id === id);
  const [name, setName] = useState(entry?.name ?? '');

  // Pick up the stored name once the entry is found (e.g. after hydration).
  const entryName = entry?.name;
  useEffect(() => {
    if (entryName !== undefined) setName((cur) => (cur === '' ? entryName : cur));
  }, [entryName]);

  if (!entry) {
    return (
      <PushedScreen title="Edit entry">
        <View className="flex-1 items-center justify-center px-10 pb-24">
          <Text className="text-[20px] font-bold text-foreground">{ready ? 'Entry not found' : 'Loading…'}</Text>
          {ready ? <PrimaryButton label="Go back" onPress={goBack} className="mt-5" /> : null}
        </View>
      </PushedScreen>
    );
  }

  const s = entry.servings;
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== entry.name) update(entry.id, { name: trimmed });
    else if (!trimmed) setName(entry.name);
  };

  return (
    <PushedScreen title="Edit entry">
      <ScrollView contentContainerClassName="px-[22px] pb-12 pt-2" keyboardShouldPersistTaps="handled">
        <Card className="px-4 py-3.5">
          <Text className="text-[13px] text-muted">Name</Text>
          <TextInput
            accessibilityLabel="Food name"
            value={name}
            onChangeText={(t) => {
              setName(t);
              if (t.trim()) update(entry.id, { name: t.trim() });
            }}
            onBlur={commitName}
            returnKeyType="done"
            className="mt-1 text-[20px] font-semibold text-foreground"
          />
          <Text className="mt-2 text-[13px] text-muted">Logged at {formatTime(entry.time)}</Text>
        </Card>

        <Card className="mt-2.5 flex-row items-center justify-between px-4 py-3.5">
          <Text className="text-[16px] font-medium text-foreground">Servings</Text>
          <ServingsStepper value={s} onChange={(servings) => update(entry.id, { servings })} />
        </Card>

        <Card className="mt-2.5 px-4 py-4">
          <View className="flex-row items-center">
            <View className="h-11 w-11 items-center justify-center rounded-full bg-track">
              <Flame size={22} color={tokens.colors.foreground} fill={tokens.colors.foreground} />
            </View>
            <View className="ml-3">
              <Text className="text-[32px] font-bold leading-[36px] text-foreground">{Math.round(entry.nutrients.calories * s)}</Text>
              <Text className="text-[13px] text-muted">Calories</Text>
            </View>
          </View>
          <View className="mt-3">
            {ROWS.map(({ key, label, unit, color }, i) => (
              <View key={key} className={`flex-row items-center py-2.5 ${i ? 'border-t border-border' : ''}`}>
                <View className="mr-2.5 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                <Text className="flex-1 text-[15px] text-foreground">{label}</Text>
                <Text className="text-[15px] font-medium text-foreground">
                  {fmt(Math.round(entry.nutrients[key] * s * 10) / 10)}
                  {unit}
                </Text>
              </View>
            ))}
          </View>
        </Card>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Delete entry"
          onPress={() => {
            remove(entry.id);
            goBack();
          }}
          className="mt-5 h-[52px] items-center justify-center rounded-full bg-chip active:opacity-70"
        >
          <Text className="text-[16px] font-semibold text-bad">Delete entry</Text>
        </Pressable>
      </ScrollView>
    </PushedScreen>
  );
}
