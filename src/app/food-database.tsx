import { Search, X } from 'lucide-react-native';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';

import { BookmarkToggle, FoodRow } from '@/components/logging/FoodRow';
import { PushedScreen } from '@/components/Screen';
import { getFoodDataSource, getFoods, type Food } from '@/data/foods';
import { useSavedFoods } from '@/lib/data';
import { createFoodIndex } from '@/lib/foodIndex';
import { tokens } from '@/lib/tokens';

// Built on first open (not at app start): ~13k USDA foods, searched in memory, offline.
let search: ReturnType<typeof createFoodIndex> | null = null;
const getSearch = () => (search ??= createFoodIndex(getFoods()));

const Separator = () => <View className="h-2.5" />;

// requestIdleCallback where available (React Native, most browsers), else the next tick.
const whenIdle = (cb: () => void): number =>
  typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: 500 }) : (setTimeout(cb, 1) as unknown as number);
const cancelIdle = (id: number) => (typeof cancelIdleCallback === 'function' ? cancelIdleCallback(id) : clearTimeout(id));

export default function FoodDatabase() {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const saved = useSavedFoods();
  const savedIds = useMemo(() => new Set(saved.items.map((s) => s.id)), [saved.items]);

  // Load the database after the screen has painted, when the JS thread is idle.
  // (On iOS/Android the native stack animates the push on the UI thread, so this
  // JS work can't drop animation frames; it just mustn't delay the first paint.)
  const [ready, setReady] = useState(() => search !== null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (ready || failed) return;
    const id = whenIdle(() => {
      try {
        getSearch();
        setReady(true);
      } catch {
        setFailed(true); // shown with a Retry button below, never an endless spinner
      }
    });
    return () => cancelIdle(id);
  }, [ready, failed]);

  // Typing stays responsive; the scan runs on the deferred value.
  const q = useDeferredValue(query).trim();
  const results = useMemo(() => (ready ? getSearch()(q) : []), [q, ready]);
  const count = ready ? getFoods().length.toLocaleString('en-US') : '';

  // Saved with a snapshot, so a later data refresh can't lose it.
  const toggleSaved = (food: Food) => (savedIds.has(food.id) ? saved.remove(food.id) : saved.add({ id: food.id, food }));

  return (
    <PushedScreen title="Food Database">
      <View className="px-[22px] pb-3 pt-2">
        <View className="h-12 flex-row items-center rounded-full border border-border bg-chip px-4">
          <Search size={18} color={tokens.colors.muted} />
          <TextInput
            accessibilityLabel="Search foods"
            placeholder={count ? `Search ${count} foods` : 'Search foods'}
            placeholderTextColor={tokens.colors.muted}
            value={query}
            onChangeText={setQuery}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            className="ml-2 h-full flex-1 text-[16px] text-foreground"
            style={{ outlineStyle: 'none' } as object}
          />
          {query ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} hitSlop={8}>
              <X size={18} color={tokens.colors.muted} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <FlatList
        data={results}
        keyExtractor={(f) => f.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 40 }}
        ItemSeparatorComponent={Separator}
        renderItem={({ item }) => (
          <FoodRow
            food={item}
            expanded={openId === item.id}
            onToggle={() => setOpenId(openId === item.id ? null : item.id)}
            trailing={<BookmarkToggle name={item.name} saved={savedIds.has(item.id)} onPress={() => toggleSaved(item)} />}
          />
        )}
        ListEmptyComponent={
          ready ? (
            <Text className="mt-10 px-6 text-center text-[15px] text-muted">
              {q ? `No foods match "${q}"` : `Search ${count} foods from USDA FoodData Central. Works offline.`}
            </Text>
          ) : failed ? (
            <View className="mt-10 items-center px-6">
              <Text className="text-center text-[15px] text-muted">Couldn&apos;t load the food database.</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Retry" onPress={() => setFailed(false)} className="mt-3 rounded-full bg-fab px-5 py-2.5">
                <Text className="text-[15px] font-semibold text-white">Retry</Text>
              </Pressable>
            </View>
          ) : (
            <View className="mt-10 items-center" accessibilityLabel="Loading foods">
              <ActivityIndicator color={tokens.colors.muted} />
            </View>
          )
        }
        ListFooterComponent={
          results.length ? <Text className="mt-4 text-center text-[11px] text-faint">Data: {getFoodDataSource()}</Text> : null
        }
      />
    </PushedScreen>
  );
}
