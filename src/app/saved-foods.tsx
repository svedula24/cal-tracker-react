import { router } from 'expo-router';
import { Bookmark, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { FoodRow } from '@/components/logging/FoodRow';
import { PrimaryButton } from '@/components/logging/PrimaryButton';
import { ComingSoon, PushedScreen } from '@/components/Screen';
import { foodById, type Food } from '@/data/foods';
import { useSavedFoods } from '@/lib/data';
import { tokens } from '@/lib/tokens';

export default function SavedFoods() {
  const saved = useSavedFoods();
  const [openId, setOpenId] = useState<string | null>(null);
  const list = saved.items.map((s) => foodById.get(s.id) ?? s.food).filter((f): f is Food => !!f);

  if (list.length === 0) {
    return (
      <PushedScreen title="Saved foods">
        <ComingSoon
          icon={<Bookmark size={34} color={tokens.colors.foreground} />}
          title="No saved foods yet"
          body="Tap the bookmark in Food Database to save foods you log often."
          action={<PrimaryButton label="Browse foods" onPress={() => router.push('/food-database')} />}
        />
      </PushedScreen>
    );
  }

  return (
    <PushedScreen title="Saved foods">
      <ScrollView contentContainerClassName="gap-2.5 px-[22px] pb-10 pt-2" keyboardShouldPersistTaps="handled">
        {list.map((food) => (
          <ReanimatedSwipeable
            key={food.id}
            friction={2}
            rightThreshold={40}
            overshootRight={false}
            renderRightActions={() => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Remove"
                onPress={() => saved.remove(food.id)}
                className="ml-2.5 w-[88px] items-center justify-center rounded-card bg-bad"
              >
                <Text className="text-[15px] font-semibold text-card">Remove</Text>
              </Pressable>
            )}
          >
            <FoodRow
              food={food}
              expanded={openId === food.id}
              onToggle={() => setOpenId(openId === food.id ? null : food.id)}
              trailing={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${food.name}`}
                  onPress={() => saved.remove(food.id)}
                  hitSlop={8}
                  className="h-10 w-10 items-center justify-center rounded-full"
                >
                  <Trash2 size={19} color={tokens.colors.muted} />
                </Pressable>
              }
            />
          </ReanimatedSwipeable>
        ))}
        <Text className="mt-2 text-center text-[13px] text-muted">Swipe left on a food to remove it.</Text>
      </ScrollView>
    </PushedScreen>
  );
}
