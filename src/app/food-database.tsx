import { Search, X } from 'lucide-react-native';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TextInput, View } from 'react-native';

import { Press } from '@/components/Press';
import { BookmarkToggle, FoodRow } from '@/components/logging/FoodRow';
import { PushedScreen } from '@/components/Screen';
import { type Food, loadFoods } from '@/data/foods';
import { useSavedFoods } from '@/lib/data';
import { createFoodIndex } from '@/lib/foodIndex';
import { tokens } from '@/lib/tokens';

// Built on first open (not at app start): ~13k USDA foods, searched in memory, offline.
type Index = { search: ReturnType<typeof createFoodIndex>; count: string; source: string };
let built: Index | null = null; // kept across opens, so the screen never re-shows the spinner
type Load = { index: Index } | 'loading' | 'failed';

const Separator = () => <View className="h-2.5" />;

export default function FoodDatabase() {
  const [query, setQuery] = useState('');
  const saved = useSavedFoods();
  const savedIds = useMemo(() => new Set(saved.items.map((s) => s.id)), [saved.items]);

  // The database loads once the screen is up. The timeout returns to the event
  // loop first, so the heavy work (on iOS/Android the bundled JSON is evaluated
  // synchronously) can't run before this screen's first frame is committed. A
  // failed load shows a Retry button, never an endless spinner.
  const [load, setLoad] = useState<Load>(() => (built ? { index: built } : 'loading'));
  useEffect(() => {
    if (load !== 'loading') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      loadFoods().then(
        ({ foods, source }) => {
          built ??= { search: createFoodIndex(foods), count: foods.length.toLocaleString('en-US'), source };
          if (!cancelled) setLoad({ index: built });
        },
        () => !cancelled && setLoad('failed'),
      );
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [load]);
  const index = typeof load === 'object' ? load.index : null;

  // Typing stays responsive; the scan runs on the deferred value.
  const q = useDeferredValue(query).trim();
  const results = useMemo(() => (index ? index.search(q) : []), [q, index]);
  const count = index?.count ?? '';

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
            <Press accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} hitSlop={8}>
              <X size={18} color={tokens.colors.muted} />
            </Press>
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
            trailing={<BookmarkToggle name={item.name} saved={savedIds.has(item.id)} onPress={() => toggleSaved(item)} />}
          />
        )}
        ListEmptyComponent={
          index ? (
            <Text className="mt-10 px-6 text-center text-[15px] text-muted">
              {q ? `No foods match "${q}"` : `Search ${count} foods from USDA FoodData Central. Works offline.`}
            </Text>
          ) : load === 'failed' ? (
            <View className="mt-10 items-center px-6">
              <Text className="text-center text-[15px] text-muted">Couldn&apos;t load the food database.</Text>
              <Press accessibilityRole="button" accessibilityLabel="Retry" onPress={() => setLoad('loading')} className="mt-3 rounded-full bg-fab px-5 py-2.5">
                <Text className="text-[15px] font-semibold text-white">Retry</Text>
              </Press>
            </View>
          ) : (
            <View className="mt-10 items-center" accessibilityLabel="Loading foods">
              <ActivityIndicator color={tokens.colors.muted} />
            </View>
          )
        }
        ListFooterComponent={
          results.length ? <Text className="mt-4 text-center text-[11px] text-faint">Data: {index?.source}</Text> : undefined
        }
      />
    </PushedScreen>
  );
}
