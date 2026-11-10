import { router } from 'expo-router';
import { Bookmark } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { Press } from '@/components/Press';
import { Card } from '@/components/Screen';
import type { Food } from '@/data/foods';
import { fmt, servingSummary } from '@/lib/measure';
import { tokens } from '@/lib/tokens';

import { MacroLine } from './MacroLine';

/**
 * A food card: name, default serving · calories, macros. Tapping opens the
 * Nutrition screen. `trailing` is the right-side control (bookmark or remove).
 */
export function FoodRow({ food, trailing }: { food: Food; trailing?: React.ReactNode }) {
  const { serving, nutrients } = servingSummary(food);
  const open = () => router.push({ pathname: '/nutrition', params: { food: JSON.stringify(food) } });
  return (
    <Card className="px-4 py-3.5">
      <View className="flex-row items-center">
        <Press accessibilityRole="button" accessibilityLabel={food.name} onPress={open} className="flex-1 pr-2">
          <Text className="text-[16px] font-medium text-foreground" numberOfLines={1}>
            {food.name}
          </Text>
          <Text className="mt-0.5 text-[13px] text-muted" numberOfLines={1}>
            {serving} · {fmt(nutrients.calories)} cal
          </Text>
          <View className="mt-1.5">
            <MacroLine nutrients={nutrients} />
          </View>
        </Press>
        {trailing}
      </View>
    </Card>
  );
}

export function BookmarkToggle({ name, saved, onPress }: { name: string; saved: boolean; onPress: () => void }) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={saved ? `Unsave ${name}` : `Save ${name}`}
      accessibilityState={{ selected: saved }}
      onPress={onPress}
      hitSlop={8}
      className="h-10 w-10 items-center justify-center rounded-full"
    >
      <Bookmark size={20} color={saved ? tokens.colors.foreground : tokens.colors.muted} fill={saved ? tokens.colors.foreground : 'transparent'} />
    </Press>
  );
}
