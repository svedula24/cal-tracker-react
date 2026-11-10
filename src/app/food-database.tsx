import { Search, X } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';

import { BookmarkToggle, FoodRow } from '@/components/logging/FoodRow';
import { PushedScreen } from '@/components/Screen';
import { foods } from '@/data/foods';
import { useSavedFoods } from '@/lib/data';
import { tokens } from '@/lib/tokens';

export default function FoodDatabase() {
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const saved = useSavedFoods();
  const savedIds = useMemo(() => new Set(saved.items.map((s) => s.id)), [saved.items]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => (q ? foods.filter((f) => f.name.toLowerCase().includes(q)) : foods), [q]);

  const toggleSaved = (id: string) => (savedIds.has(id) ? saved.remove(id) : saved.add({ id }));

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
      <FlatList
        data={results}
        keyExtractor={(f) => f.id}
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-2.5 px-[22px] pb-10"
        ListEmptyComponent={
          <Text className="mt-10 text-center text-[15px] text-muted">No foods match "{query.trim()}"</Text>
        }
        renderItem={({ item }) => (
          <FoodRow
            food={item}
            expanded={openId === item.id}
            onToggle={() => setOpenId(openId === item.id ? null : item.id)}
            trailing={<BookmarkToggle name={item.name} saved={savedIds.has(item.id)} onPress={() => toggleSaved(item.id)} />}
          />
        )}
      />
    </PushedScreen>
  );
}
