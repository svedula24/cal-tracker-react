import { Search, X } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, SectionList, Text, TextInput, View } from 'react-native';

import { BookmarkToggle, FoodRow } from '@/components/logging/FoodRow';
import { PushedScreen } from '@/components/Screen';
import { foods, type Food } from '@/data/foods';
import { useSavedFoods } from '@/lib/data';
import { offOnWeb, useRemoteFoodSearch } from '@/lib/foodSearch';
import { tokens } from '@/lib/tokens';

const Separator = () => <View className="h-2.5" />;

export default function FoodDatabase() {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const saved = useSavedFoods();
  const savedIds = useMemo(() => new Set(saved.items.map((s) => s.id)), [saved.items]);

  const q = query.trim().toLowerCase();
  const local = useMemo(() => (q ? foods.filter((f) => f.name.toLowerCase().includes(q)) : foods), [q]);
  const remote = useRemoteFoodSearch(query);

  // Online foods are saved with a snapshot so Saved foods works offline too.
  const toggleSaved = (food: Food) =>
    savedIds.has(food.id) ? saved.remove(food.id) : saved.add(food.source && food.source !== 'kalo' ? { id: food.id, food } : { id: food.id });

  const sections = [
    ...(local.length ? [{ key: 'kalo', title: q ? 'Kalo foods' : '', data: local }] : []),
    ...(remote.foods.length ? [{ key: 'online', title: Platform.OS === 'web' && !offOnWeb() ? 'USDA' : 'USDA & Open Food Facts', data: remote.foods }] : []),
  ];
  const nothing = !local.length && !remote.foods.length && !remote.loading;

  return (
    <PushedScreen title="Food Database">
      <View className="px-[22px] pb-3 pt-2">
        <View className="h-12 flex-row items-center rounded-full border border-border bg-chip px-4">
          <Search size={18} color={tokens.colors.muted} />
          <TextInput
            accessibilityLabel="Search foods"
            placeholder="Search foods"
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
      <SectionList
        sections={sections}
        keyExtractor={(f) => f.id}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        // contentContainerClassName is not mapped for SectionList; use a plain style.
        contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 40 }}
        ItemSeparatorComponent={Separator}
        renderSectionHeader={({ section }) =>
          section.title ? <Text className="mb-2 mt-3 text-[13px] font-semibold uppercase tracking-wide text-muted">{section.title}</Text> : null
        }
        renderItem={({ item }) => (
          <FoodRow
            food={item}
            expanded={openId === item.id}
            onToggle={() => setOpenId(openId === item.id ? null : item.id)}
            trailing={<BookmarkToggle name={item.name} saved={savedIds.has(item.id)} onPress={() => toggleSaved(item)} />}
          />
        )}
        ListFooterComponent={
          <View className="mt-4 items-center">
            {remote.loading ? (
              <View className="flex-row items-center" accessibilityLabel="Searching online">
                <ActivityIndicator color={tokens.colors.muted} />
                <Text className="ml-2 text-[14px] text-muted">Searching online…</Text>
              </View>
            ) : null}
            {nothing && q ? <Text className="mt-6 text-center text-[15px] text-muted">No foods match "{query.trim()}"</Text> : null}
            {remote.errors.length > 0 && !remote.loading ? (
              <Text className="mt-2 text-center text-[13px] text-muted">
                Couldn&apos;t reach {remote.errors.join(' · ')}. Showing what&apos;s available.
              </Text>
            ) : null}
            {q.length >= 2 ? (
              <Text className="mt-4 text-center text-[11px] text-faint">
                Data: USDA FoodData Central · Open Food Facts (ODbL). Values per 100 g.
              </Text>
            ) : null}
          </View>
        }
      />
    </PushedScreen>
  );
}
