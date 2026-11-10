import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { Card, TabScreen } from '@/components/Screen';
import { TAB_BAR_SPACE } from '@/components/TabBar';
import { useGoals } from '@/lib/data';
import type { Goals } from '@/lib/nutrition';
import { tokens } from '@/lib/tokens';

const GOAL_OPTIONS: { value: Goals['goal']; label: string }[] = [
  { value: 'lose', label: 'Lose' },
  { value: 'maintain', label: 'Maintain' },
  { value: 'gain', label: 'Gain' },
];

type TargetKey = 'calories' | 'protein' | 'carbs' | 'fat' | 'fiber' | 'sugar' | 'sodium' | 'waterCups' | 'steps';
const TARGETS: { key: TargetKey; label: string; unit: string }[] = [
  { key: 'calories', label: 'Calories', unit: 'kcal' },
  { key: 'protein', label: 'Protein', unit: 'g' },
  { key: 'carbs', label: 'Carbs', unit: 'g' },
  { key: 'fat', label: 'Fat', unit: 'g' },
  { key: 'fiber', label: 'Fiber', unit: 'g' },
  { key: 'sugar', label: 'Sugar', unit: 'g' },
  { key: 'sodium', label: 'Sodium', unit: 'mg' },
  { key: 'waterCups', label: 'Water', unit: 'cups' },
  { key: 'steps', label: 'Steps', unit: '' },
];

function TargetRow({ label, unit, value, onCommit, last }: { label: string; unit: string; value: number; onCommit: (n: number) => void; last: boolean }) {
  // While editing, show the raw text (may be empty/invalid); otherwise the stored goal.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <View className={`flex-row items-center py-3 ${last ? '' : 'border-b border-border'}`}>
      <Text className="flex-1 text-[16px] text-foreground">{label}</Text>
      <TextInput
        accessibilityLabel={`${label} goal`}
        value={draft ?? String(value)}
        onChangeText={(t) => {
          const clean = t.replace(/[^0-9]/g, '');
          setDraft(clean);
          const n = Number(clean);
          if (clean !== '' && Number.isInteger(n) && n > 0) onCommit(n);
        }}
        onBlur={() => setDraft(null)}
        keyboardType="number-pad"
        inputMode="numeric"
        returnKeyType="done"
        selectTextOnFocus
        className="min-w-[72px] rounded-xl bg-background px-3 py-2 text-right text-[16px] font-semibold text-foreground"
        placeholderTextColor={tokens.colors.faint}
      />
      <Text className="ml-2 w-10 text-[14px] text-muted">{unit}</Text>
    </View>
  );
}

export default function Profile() {
  const { goals, setGoals } = useGoals();

  return (
    <TabScreen title="Profile">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: TAB_BAR_SPACE, gap: 12 }}
      >
        <Card className="p-5">
          <Text className="mb-3 text-[17px] font-semibold text-foreground">Goal</Text>
          <View className="flex-row rounded-full bg-track p-1" accessibilityRole="tablist">
            {GOAL_OPTIONS.map((o) => {
              const selected = goals.goal === o.value;
              return (
                <Pressable
                  key={o.value}
                  accessibilityRole="tab"
                  accessibilityLabel={o.label}
                  accessibilityState={{ selected }}
                  aria-selected={selected}
                  onPress={() => setGoals({ goal: o.value })}
                  className={`flex-1 items-center rounded-full py-2.5 ${selected ? 'bg-foreground' : ''}`}
                >
                  <Text className={`text-[15px] font-semibold ${selected ? 'text-card' : 'text-muted'}`}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <Card className="px-5 py-2">
          <Text className="pb-1 pt-3 text-[17px] font-semibold text-foreground">Daily targets</Text>
          {TARGETS.map((t, i) => (
            <TargetRow
              key={t.key}
              label={t.label}
              unit={t.unit}
              value={goals[t.key]}
              last={i === TARGETS.length - 1}
              onCommit={(n) => setGoals({ [t.key]: n } as Partial<Goals>)}
            />
          ))}
        </Card>

        <Text className="px-2 pt-2 text-center text-[13px] text-muted">Kalo stores everything on this device.</Text>
      </ScrollView>
    </TabScreen>
  );
}
