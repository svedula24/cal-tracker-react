import { Sparkles } from 'lucide-react-native';
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Press } from '@/components/Press';
import { Card, goBack, PushedScreen } from '@/components/Screen';
import { type GoalPatch, useGoals } from '@/lib/data';
import { parseValue } from '@/lib/measure';
import { type Goals, type GoalSource, type GoalType, inSuggestLimit, type SuggestInput, suggestInputValid, suggestTargets } from '@/lib/nutrition';
import { tokens } from '@/lib/tokens';

const c = tokens.colors;

const TARGETS = [
  { key: 'calories', label: 'Calories', unit: 'cal' },
  { key: 'protein', label: 'Protein', unit: 'g' },
  { key: 'carbs', label: 'Carbs', unit: 'g' },
  { key: 'fat', label: 'Fat', unit: 'g' },
  { key: 'fiber', label: 'Fiber', unit: 'g' },
  { key: 'sugar', label: 'Sugar', unit: 'g' },
  { key: 'sodium', label: 'Sodium', unit: 'mg' },
  { key: 'steps', label: 'Steps', unit: 'steps' },
] as const;
const ACTIVITY = [
  { key: 'workoutKcal', label: 'Workout day', a11y: 'Workout day calories', unit: 'cal' },
  { key: 'activeRestKcal', label: 'Active rest day', a11y: 'Active rest day calories', unit: 'cal' },
] as const;
type FieldKey = (typeof TARGETS)[number]['key'] | (typeof ACTIVITY)[number]['key'];
/** The four targets a suggestion fills; typing one of them makes the goal manual. */
const SUGGESTED: readonly FieldKey[] = ['calories', 'protein', 'carbs', 'fat'];

const GOAL_TYPES: { value: GoalType; label: string }[] = [
  { value: 'lose', label: 'Lose' },
  { value: 'maintain', label: 'Maintain' },
  { value: 'gain', label: 'Gain' },
];

// What the server accepts (backend/app/schemas/logs.py): it rejects the whole goal row otherwise,
// and sync would drop it.
const MAX_AMOUNT = 1e9;
const MAX_STEPS = 2 ** 31 - 1;

/** A field's value as typed: a number (parseValue) within the server's limits, steps a whole number; null when not. */
const parseField = (key: FieldKey, t: string): number | null => {
  const n = parseValue(t);
  if (n === null) return null;
  if (key === 'steps') return /^[\d,]+$/.test(t.trim()) && Number.isInteger(n) && n <= MAX_STEPS ? n : null;
  return n <= MAX_AMOUNT ? n : null;
};

/** What a suggestion was made from; the targets stop being that suggestion when any of it changes. */
type Basis = { sex: SuggestInput['sex']; goal: GoalType; age: number | null; heightCm: number | null; weightKg: number | null };
const sameBasis = (a: Basis, b: Basis) =>
  a.sex === b.sex && a.goal === b.goal && a.age === b.age && a.heightCm === b.heightCm && a.weightKg === b.weightKg;

/**
 * Goals: the seven daily targets, the step goal, the goal type and the calories a workout or
 * active-rest day adds. "Suggest" fills calories and macros from sex, age, height and weight; those
 * four inputs are used once and never stored. Save makes the change from today on: earlier days keep
 * the goal they had.
 */
export default function GoalsScreen() {
  const { goals, ready } = useGoals();
  return (
    <PushedScreen title="Goals">
      {/* The form starts from the stored goal, so it waits until that has loaded. */}
      {ready ? <GoalsForm key={goals.id} goals={goals} /> : null}
    </PushedScreen>
  );
}

function GoalsForm({ goals }: { goals: Goals }) {
  const { set } = useGoals();
  const insets = useSafeAreaInsets();
  const [values, setValues] = useState<Record<FieldKey, string>>(
    () => Object.fromEntries([...TARGETS, ...ACTIVITY].map(({ key }) => [key, String(goals[key])])) as Record<FieldKey, string>,
  );
  const [goalType, setGoalType] = useState<GoalType>(goals.goal);
  const [source, setSource] = useState<GoalSource>(goals.source);

  // The suggestion's inputs: only in this screen's state, never saved.
  const [sex, setSex] = useState<SuggestInput['sex']>('female');
  const [age, setAge] = useState('');
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const body = { age: parseValue(age), heightCm: parseValue(height), weightKg: parseValue(weight) };
  const canSuggest = suggestInputValid(body);
  // The inputs of the last suggestion filled here (null: none yet this visit).
  const [basis, setBasis] = useState<Basis | null>(null);
  const current: Basis = { sex, goal: goalType, ...body };
  // Suggested targets stay suggested only while the inputs they came from do: a stored suggestion
  // until the goal type changes, one filled here until any of its inputs does.
  const stale = source === 'computed' && (basis ? !sameBasis(basis, current) : goalType !== goals.goal);
  const shownSource: GoalSource = stale ? 'manual' : source;

  const edit = (key: FieldKey) => (t: string) => {
    setValues((v) => ({ ...v, [key]: t }));
    if (SUGGESTED.includes(key)) setSource('manual');
  };
  const suggest = () => {
    if (!canSuggest) return;
    const s = suggestTargets({ sex, goal: goalType, age: body.age!, heightCm: body.heightCm!, weightKg: body.weightKg! });
    setValues((v) => ({ ...v, calories: String(s.calories), protein: String(s.protein), carbs: String(s.carbs), fat: String(s.fat) }));
    setSource('computed');
    setBasis(current);
  };

  const parsed = Object.fromEntries(Object.entries(values).map(([k, t]) => [k, parseField(k as FieldKey, t)])) as Record<FieldKey, number | null>;
  const valid = Object.values(parsed).every((n) => n !== null);
  const save = () => {
    if (!valid) return;
    const patch: GoalPatch = { ...(parsed as Record<FieldKey, number>), goal: goalType, source: shownSource };
    set(patch);
    goBack();
  };

  return (
    <View className="flex-1">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 120, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Card className="px-5 pb-2 pt-5">
          <View className="flex-row items-center justify-between">
            <Text className="text-[17px] font-semibold text-foreground">Daily targets</Text>
            <View accessibilityLabel={`Goal source: ${shownSource === 'computed' ? 'suggested' : 'manual'}`} className="rounded-full bg-chip px-[10px] py-[4px]">
              <Text className="text-[12.5px] font-medium text-foreground">{shownSource === 'computed' ? 'Suggested' : 'Manual'}</Text>
            </View>
          </View>
          <Text className="mt-1 text-[13px] text-muted">From today on. Earlier days keep the goal they had.</Text>
          <View className="mt-2">
            {TARGETS.map(({ key, label, unit }, i) => (
              <Field key={key} label={label} unit={unit} value={values[key]} invalid={parsed[key] === null} onChange={edit(key)} first={i === 0} />
            ))}
          </View>
        </Card>

        <Card className="p-5">
          <Text className="text-[17px] font-semibold text-foreground">Goal</Text>
          <Chips options={GOAL_TYPES} value={goalType} onChange={setGoalType} label={(o) => `${o.label} weight`} />
        </Card>

        <Card className="px-5 pb-2 pt-5">
          <Text className="text-[17px] font-semibold text-foreground">Activity calories</Text>
          <Text className="mt-1 text-[13px] text-muted">
            Added to a day's calories (and a quarter of them to carbs, in grams) on top of its steps. A day can set its own on Home.
          </Text>
          <View className="mt-2">
            {ACTIVITY.map(({ key, label, a11y, unit }, i) => (
              <Field key={key} label={label} unit={unit} value={values[key]} invalid={parsed[key] === null} onChange={edit(key)} first={i === 0} a11y={a11y} />
            ))}
          </View>
        </Card>

        <Card className="p-5">
          <View className="flex-row items-center">
            <Sparkles size={18} color={c.foreground} />
            <Text className="ml-2 text-[17px] font-semibold text-foreground">Suggest</Text>
          </View>
          <Text className="mt-1 text-[13px] text-muted">
            Fills calories, protein, carbs and fat for your goal. These details are only used for the suggestion and are not saved.
          </Text>
          <Chips
            options={[
              { value: 'female', label: 'Female' },
              { value: 'male', label: 'Male' },
            ]}
            value={sex}
            onChange={setSex}
            label={(o) => o.label}
          />
          <View className="mt-2">
            <Field label="Age" unit="years" value={age} invalid={age !== '' && !inSuggestLimit('age', body.age)} onChange={setAge} first />
            <Field label="Height" unit="cm" value={height} invalid={height !== '' && !inSuggestLimit('heightCm', body.heightCm)} onChange={setHeight} />
            <Field label="Weight" unit="kg" value={weight} invalid={weight !== '' && !inSuggestLimit('weightKg', body.weightKg)} onChange={setWeight} />
          </View>
          <Press
            accessibilityRole="button"
            accessibilityLabel="Fill from suggestion"
            accessibilityState={{ disabled: !canSuggest }}
            aria-disabled={!canSuggest}
            disabled={!canSuggest}
            onPress={suggest}
            className={`mt-3 h-[44px] items-center justify-center rounded-full border ${canSuggest ? 'border-foreground' : 'border-border'}`}
          >
            <Text className={`text-[15px] font-semibold ${canSuggest ? 'text-foreground' : 'text-faint'}`}>Fill from suggestion</Text>
          </Press>
        </Card>
      </ScrollView>

      <View className="absolute inset-x-0 bottom-0 bg-background px-[22px] pt-3" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
        <Press
          accessibilityRole="button"
          accessibilityLabel="Save goals"
          accessibilityState={{ disabled: !valid }}
          aria-disabled={!valid}
          disabled={!valid}
          onPress={save}
          className={`h-[56px] items-center justify-center rounded-full ${valid ? 'bg-fab' : 'bg-faint'}`}
        >
          <Text className="text-[20px] font-semibold text-white">Save</Text>
        </Press>
      </View>
    </View>
  );
}

function Field({ label, a11y, unit, value, invalid, onChange, first = false }: { label: string; a11y?: string; unit: string; value: string; invalid: boolean; onChange: (t: string) => void; first?: boolean }) {
  return (
    <View className={`flex-row items-center py-3 ${first ? '' : 'border-t border-border'}`}>
      <Text className="flex-1 text-[16px] text-foreground">{label}</Text>
      <TextInput
        accessibilityLabel={a11y ?? label}
        value={value}
        onChangeText={onChange}
        keyboardType="decimal-pad"
        selectTextOnFocus
        className={`text-right text-[16px] font-semibold ${invalid ? 'text-bad' : 'text-foreground'}`}
        style={{ width: 90, padding: 0, outlineStyle: 'none' } as object}
      />
      <Text className="ml-[6px] w-[42px] text-[14px] text-muted">{unit}</Text>
    </View>
  );
}

function Chips<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: (o: { value: T; label: string }) => string }) {
  return (
    <View className="mt-3 flex-row" style={{ gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Press
            key={o.value}
            accessibilityRole="button"
            accessibilityLabel={label(o)}
            accessibilityState={{ selected: on }}
            aria-selected={on} // react-native-web ignores accessibilityState
            onPress={() => onChange(o.value)}
            className={`h-[34px] flex-1 items-center justify-center rounded-full border ${on ? 'border-foreground bg-foreground' : 'border-border bg-card'}`}
          >
            <Text className={`text-[14px] font-medium ${on ? 'text-background' : 'text-foreground'}`}>{o.label}</Text>
          </Press>
        );
      })}
    </View>
  );
}
