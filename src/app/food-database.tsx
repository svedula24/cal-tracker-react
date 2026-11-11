import { Search, X } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TextInput, View } from 'react-native';

import { Press } from '@/components/Press';
import { BookmarkToggle, FoodRow } from '@/components/logging/FoodRow';
import { PushedScreen } from '@/components/Screen';
import type { Food } from '@/data/foods';
import { useSavedFoods } from '@/lib/data';
import { tokens } from '@/lib/tokens';
import { useFoodSearch } from '@/lib/useFoodSearch';

const Separator = () => <View className="h-2.5" />;

export default function FoodDatabase() {
  const [query, setQuery] = useState('');
  const saved = useSavedFoods();
  const savedIds = useMemo(() => new Set(saved.items.map((s) => s.id)), [saved.items]);

  // Bundled-only build: the list loads when the screen opens and answers each
  // keystroke; a failed load shows Retry, never an endless spinner. With an API
  // URL the search goes to the API, falling back to the bundled list
  // (src/lib/foodSearch.ts). `q` is the query the results are for.
  const { results, status, source, query: q, remote, bundled, retry } = useFoodSearch(query);
  const count = remote ? '' : (bundled?.count ?? '');
  const offline = remote && source === 'bundled' && status !== 'failed';

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
          {remote && status === 'loading' ? (
            <View className="mr-2" accessibilityLabel="Searching">
              <ActivityIndicator size="small" color={tokens.colors.muted} />
            </View>
          ) : null}
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
          status === 'failed' ? (
            <View className="mt-10 items-center px-6">
              <Text className="text-center text-[15px] text-muted">Couldn&apos;t load the food database.</Text>
              <Press accessibilityRole="button" accessibilityLabel="Retry" onPress={retry} className="mt-3 rounded-full bg-fab px-5 py-2.5">
                <Text className="text-[15px] font-semibold text-white">Retry</Text>
              </Press>
            </View>
          ) : status !== 'loading' ? (
            <Text className="mt-10 px-6 text-center text-[15px] text-muted">
              {q
                ? `No foods match "${q}"`
                : remote
                  ? 'Search USDA FoodData Central.'
                  : `Search ${count} foods from USDA FoodData Central. Works offline.`}
            </Text>
          ) : remote ? undefined : (
            // With an API URL the search field shows the spinner instead.
            <View className="mt-10 items-center" accessibilityLabel="Loading foods">
              <ActivityIndicator color={tokens.colors.muted} />
            </View>
          )
        }
        ListFooterComponent={
          results.length || offline ? (
            <View className="mt-4">
              {offline ? <Text className="text-center text-[11px] text-faint">Offline: searching the built-in list</Text> : null}
              {results.length ? (
                <Text className="text-center text-[11px] text-faint">Data: {source === 'bundled' ? bundled?.source : 'USDA FoodData Central'}</Text>
              ) : null}
            </View>
          ) : undefined
        }
      />
    </PushedScreen>
  );
}
