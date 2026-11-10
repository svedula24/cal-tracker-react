import { Search, X } from 'lucide-react-native';
import { useDeferredValue, useMemo, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';

import { BookmarkToggle, FoodRow } from '@/components/logging/FoodRow';
import { PushedScreen } from '@/components/Screen';
import { FOOD_DATA_SOURCE, foods, type Food } from '@/data/foods';
import { useSavedFoods } from '@/lib/data';
import { createFoodIndex } from '@/lib/foodIndex';
import { tokens } from '@/lib/tokens';

// Built once: ~13k USDA foods, searched in memory (offline, no API).
const search = createFoodIndex(foods);
const COUNT = foods.length.toLocaleString('en-US');

const Separator = () => <View className="h-2.5" />;

export default function FoodDatabase() {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const saved = useSavedFoods();
  const savedIds = useMemo(() => new Set(saved.items.map((s) => s.id)), [saved.items]);

  // Typing stays responsive; the 13k-food scan runs on the deferred value.
  const q = useDeferredValue(query).trim();
  const results = useMemo(() => search(q), [q]);

  // Saved with a snapshot, so a later data refresh can't lose it.
  const toggleSaved = (food: Food) => (savedIds.has(food.id) ? saved.remove(food.id) : saved.add({ id: food.id, food }));

  return (
    <PushedScreen title="Food Database">
      <View className="px-[22px] pb-3 pt-2">
        <View className="h-12 flex-row items-center rounded-full border border-border bg-chip px-4">
          <Search size={18} color={tokens.colors.muted} />
          <TextInput
            accessibilityLabel="Search foods"
            placeholder={`Search ${COUNT} foods`}
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
          <Text className="mt-10 px-6 text-center text-[15px] text-muted">
            {q ? `No foods match "${q}"` : `Search ${COUNT} foods from USDA FoodData Central. Works offline.`}
          </Text>
        }
        ListFooterComponent={
          results.length ? <Text className="mt-4 text-center text-[11px] text-faint">Data: {FOOD_DATA_SOURCE}</Text> : null
        }
      />
    </PushedScreen>
  );
}
