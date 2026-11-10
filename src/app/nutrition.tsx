import { router, useLocalSearchParams } from 'expo-router';
import { Apple, ArrowLeft, Bookmark, Candy, ChevronDown, ChevronRight, Droplet, Drumstick, Ellipsis, Flame, Pencil, Soup, Wheat } from 'lucide-react-native';
import { useMemo, useRef, useState } from 'react';
import { ScrollView, type ScrollViewInstance, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { Press } from '@/components/Press';
import { cardShadow, goBack } from '@/components/Screen';
import type { Food } from '@/data/foods';
import { type Entry, newEntry, useEntries, useSavedFoods } from '@/lib/data';
import { defaultServing, entryGrams, fmt, foodOfEntry, G, HUNDRED_G, parseQty, qtyText, scale, times } from '@/lib/measure';
import { formatTime, type Nutrients, zero } from '@/lib/nutrition';
import { parseFood } from '@/lib/savedFoods';
import { useSelectedDay } from '@/lib/selectedDay';
import { tokens } from '@/lib/tokens';

const c = tokens.colors;

const MACROS = [
  { key: 'protein', label: 'Protein', Icon: Drumstick, color: c.protein, unit: 'g' },
  { key: 'carbs', label: 'Carbs', Icon: Wheat, color: c.carbs, unit: 'g' },
  { key: 'fat', label: 'Fats', Icon: Droplet, color: c.fat, unit: 'g' },
] as const;
const MICROS = [
  { key: 'fiber', label: 'Fiber', Icon: Apple, color: c.fiber, unit: 'g' },
  { key: 'sugar', label: 'Sugar', Icon: Candy, color: c.sugar, unit: 'g' },
  { key: 'sodium', label: 'Sodium', Icon: Soup, color: c.sodium, unit: 'mg' },
] as const;

/**
 * The Nutrition screen: open from a food (adding it to the day) or from a
 * logged entry (editing it). Type the amount in grams; nutrients are
 * per100g × grams / 100. A hand-written entry (no per-100 g data) keeps a
 * servings field instead.
 */
export default function Nutrition() {
  const { id, food: foodParam } = useLocalSearchParams<{ id?: string; food?: string }>();
  const entries = useEntries();
  const found = id ? entries.items.find((e) => e.id === id) : undefined;
  // Keep showing an entry seen earlier: after Delete the screen is still on its
  // way out, and must not switch to "Entry not found" during the transition.
  const seen = useRef(found);
  if (found) seen.current = found;
  const entry = found ?? seen.current;
  const food = useMemo(() => parseFood(foodParam), [foodParam]);
  // The form mounts only once its data exists, so its state is never seeded
  // from an entry that hasn't loaded from storage yet.
  if (entry) return <NutritionForm key={entry.id} entry={entry} base={foodOfEntry(entry)} />;
  if (food) return <NutritionForm key={food.id} base={food} />;
  const loading = !!id && !entries.ready;
  return (
    <SafeAreaView className="flex-1 items-center justify-center bg-background px-10">
      <Text className="text-[20px] font-bold text-foreground">{loading ? 'Loading…' : 'Entry not found'}</Text>
      {loading ? null : (
        <Press accessibilityRole="button" accessibilityLabel="Go back" onPress={goBack} className="mt-5 rounded-full bg-fab px-6 py-3">
          <Text className="font-semibold text-white">Go back</Text>
        </Press>
      )}
    </SafeAreaView>
  );
}

/** `entry`: the logged entry being edited. `base`: the database food behind it (null for hand-written entries), or the food being added. */
function NutritionForm({ entry, base }: { entry?: Entry; base: Food | null }) {
  const entries = useEntries();
  const saved = useSavedFoods();
  const [day] = useSelectedDay();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pageWidth = width - 44;
  const pager = useRef<ScrollViewInstance>(null);

  const [name, setName] = useState(entry?.name ?? base?.name ?? '');
  // For a food: grams. For a hand-written entry: servings.
  const initial = base ? entryGrams(entry, base) : (entry?.servings ?? 1);
  const [qty, setQty] = useState(initial);
  const [text, setText] = useState(qtyText(initial));
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState(false);
  const [page, setPage] = useState(0);

  // Per one unit (1 g, or one serving of a hand-written entry): what the day's
  // totals multiply by `servings`. The cards show the typed amount.
  const perUnit: Nutrients = base ? scale(base.per100g, 1) : (entry?.nutrients ?? zero());
  const nutrients = times(perUnit, qty);
  const serving = base ? defaultServing(base) : null;
  const isSaved = !!base && saved.items.some((s) => s.id === base.id);
  const time = formatTime(entry?.time ?? new Date().toISOString());

  // The field may hold an invalid draft ("abc", or emptied): the cards keep the
  // last valid quantity, the field shows the error and Done is disabled.
  const valid = parseQty(text) !== null;
  const onQty = (t: string) => {
    setText(t);
    const n = parseQty(t);
    if (n !== null) setQty(n);
  };
  const done = () => {
    if (!valid) return;
    const finalName = name.trim() || base?.name || entry?.name || 'Food';
    if (entry) {
      entries.update(entry.id, { name: finalName, servings: qty, measure: base ? G : entry.measure, nutrients: perUnit });
      goBack();
    } else if (base) {
      entries.add({ ...newEntry(base, G, qty, day), name: finalName });
      router.dismissTo('/');
    }
  };

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="flex-1">
        <View className="flex-row items-center justify-between px-[18px] pt-1">
          {/* Back leaves without saving; Done saves (as in the reference app). */}
          <RoundButton label="Back" onPress={goBack}>
            <ArrowLeft size={22} color={c.foreground} />
          </RoundButton>
          <Text className="text-[20px] font-semibold text-foreground">Nutrition</Text>
          {entry ? (
            <RoundButton label="More options" onPress={() => setMenu((m) => !m)}>
              <Ellipsis size={22} color={c.foreground} />
            </RoundButton>
          ) : (
            <View className="w-[46px]" />
          )}
        </View>
        {menu && entry ? (
          <View className="absolute right-[18px] top-[60px] z-10 rounded-2xl border border-border bg-card px-2 py-1" style={cardShadow}>
            <Press
              accessibilityRole="button"
              accessibilityLabel="Delete entry"
              onPress={() => {
                entries.remove(entry.id);
                goBack();
              }}
              className="px-4 py-3"
            >
              <Text className="text-[16px] font-medium text-bad">Delete entry</Text>
            </Press>
          </View>
        ) : null}

        <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 120 }} keyboardShouldPersistTaps="handled" onScrollBeginDrag={() => setMenu(false)}>
          <View className="mt-[14px] flex-row">
            <View className="rounded-full bg-chip px-[14px] py-[7px]">
              <Text className="text-[14px] text-foreground">{time}</Text>
            </View>
          </View>
          <View className="mt-[10px] flex-row items-center">
            <TextInput
              accessibilityLabel="Food name"
              value={name}
              onChangeText={setName}
              multiline
              className="mr-3 flex-1 font-bold text-foreground"
              // USDA names can be long ("Bagels, plain, enriched, with calcium…"): smaller and wrapping.
              style={{ fontSize: name.length > 20 ? 24 : 30, lineHeight: name.length > 20 ? 30 : 36, outlineStyle: 'none' } as object}
            />
            {base ? (
              <Press
                accessibilityRole="button"
                accessibilityLabel={isSaved ? `Unsave ${base.name}` : `Save ${base.name}`}
                onPress={() => (isSaved ? saved.remove(base.id) : saved.add({ id: base.id, food: base }))}
                hitSlop={8}
              >
                <Bookmark size={28} color={c.foreground} fill={isSaved ? c.foreground : 'transparent'} strokeWidth={2.2} />
              </Press>
            ) : null}
          </View>

          <View className="mt-[28px] flex-row items-center justify-between px-[6px]">
            <Text className="flex-1 text-[20px] font-semibold text-foreground">{base ? 'Amount' : 'Number of Servings'}</Text>
            <View className={`h-[40px] flex-row items-center justify-center rounded-full border bg-card pl-2 pr-3 ${valid ? 'border-border' : 'border-bad'}`}>
              <TextInput
                accessibilityLabel={base ? 'Grams' : 'Number of servings'}
                value={text}
                onChangeText={onQty}
                onBlur={() => setText(qtyText(qty))} // parseQty already rounds to what is shown
                keyboardType="decimal-pad"
                selectTextOnFocus
                className="text-center text-[18px] font-semibold text-foreground"
                style={{ width: 64, outlineStyle: 'none' } as object}
              />
              {base ? <Text className="text-[18px] font-semibold text-foreground">g</Text> : null}
              <Pencil size={16} color={c.foreground} style={{ marginLeft: 6 }} />
            </View>
          </View>
          {serving && serving !== HUNDRED_G ? (
            <Text className="mt-[8px] px-[6px] text-[13px] text-muted">
              {serving.label} = {fmt(serving.grams)} g
            </Text>
          ) : null}

          <View className="mt-[24px]">
            <NutrientCard big label="Calories" value={fmt(nutrients.calories)} unit="" icon={<Flame size={30} color={c.foreground} fill={c.foreground} />} />
          </View>
          <ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            className="mt-[10px]"
            onScroll={(e) => {
              const i = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
              if (i !== page) setPage(i);
            }}
            scrollEventThrottle={32}
          >
            {[MACROS, MICROS].map((group, gi) => (
              <View key={gi} className="flex-row" style={{ width: pageWidth, gap: 10 }}>
                {group.map(({ key, label, Icon, color, unit }) => (
                  <NutrientCard key={key} label={label} value={fmt(nutrients[key])} unit={unit} icon={<Icon size={16} color={color} fill={color} />} />
                ))}
              </View>
            ))}
          </ScrollView>
          <View className="mt-[12px] flex-row justify-center" style={{ gap: 7 }}>
            {[0, 1].map((i) => (
              <Press
                key={i}
                accessibilityRole="button"
                accessibilityLabel={`Page ${i + 1}`}
                accessibilityState={{ selected: i === page }}
                hitSlop={6}
                onPress={() => {
                  pager.current?.scrollTo({ x: i * pageWidth, animated: true });
                  setPage(i);
                }}
                className={`h-[8px] w-[8px] rounded-full ${i === page ? 'bg-foreground' : 'border border-faint'}`}
              />
            ))}
          </View>

          <Press accessibilityRole="button" accessibilityLabel="Other nutrition facts" accessibilityState={{ expanded: more }} onPress={() => setMore((m) => !m)} className="mt-[30px] flex-row items-center justify-between">
            <Text className="text-[24px] font-semibold text-foreground">Other nutrition facts</Text>
            {more ? <ChevronDown size={24} color={c.foreground} /> : <ChevronRight size={24} color={c.foreground} />}
          </Press>
          {more ? (
            <View className="mt-[8px] rounded-[22px] border border-border bg-card px-5">
              {[...MACROS, ...MICROS].map(({ key, label, unit }, i) => (
                <View key={key} className={`flex-row items-center justify-between py-3 ${i ? 'border-t border-border' : ''}`}>
                  <Text className="text-[16px] text-foreground">{label}</Text>
                  <Text className="text-[16px] font-medium text-foreground">
                    {fmt(nutrients[key])}
                    {unit}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>

      <View className="absolute inset-x-0 bottom-0 bg-background px-[22px] pt-3" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
        <Press
          accessibilityRole="button"
          accessibilityLabel="Done"
          accessibilityState={{ disabled: !valid }}
          aria-disabled={!valid}
          disabled={!valid}
          onPress={done}
          className={`h-[56px] items-center justify-center rounded-full ${valid ? 'bg-fab' : 'bg-faint'}`}
        >
          <Text className="text-[20px] font-semibold text-white">Done</Text>
        </Press>
      </View>
    </View>
  );
}

function RoundButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Press accessibilityRole="button" accessibilityLabel={label} onPress={onPress} className="h-[46px] w-[46px] items-center justify-center rounded-full bg-chip">
      {children}
    </Press>
  );
}

function NutrientCard({ label, value, unit, icon, big = false }: { label: string; value: string; unit: string; icon: React.ReactNode; big?: boolean }) {
  return (
    <View className={`rounded-[22px] border border-border bg-card ${big ? 'h-[80px] flex-row items-center px-5' : 'h-[62px] flex-1 justify-center px-3'}`}>
      {big ? (
        <>
          {icon}
          <View className="ml-5">
            <Text className="text-[14px] text-muted">{label}</Text>
            <Text className="text-[30px] font-bold leading-[34px] text-foreground">{value}</Text>
          </View>
        </>
      ) : (
        <>
          <View className="flex-row items-center">
            {icon}
            <Text className="ml-2 text-[13px] text-muted">{label}</Text>
          </View>
          <Text className="mt-0.5 text-[20px] font-bold text-foreground">
            {value}
            {unit}
          </Text>
        </>
      )}
    </View>
  );
}
