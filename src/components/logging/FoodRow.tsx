import { Bookmark } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { Card } from '@/components/Screen';
import type { Food } from '@/data/foods';
import { tokens } from '@/lib/tokens';

import { AddPanel } from './AddPanel';
import { MacroLine } from './MacroLine';

/**
 * A food card: name, serving · calories, macros. Tapping toggles the inline
 * add panel. `trailing` is the right-side control (bookmark or remove).
 */
export function FoodRow({
  food,
  expanded,
  onToggle,
  trailing,
}: {
  food: Food;
  expanded: boolean;
  onToggle: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <Card className="px-4 py-3.5">
      <View className="flex-row items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={food.name}
          accessibilityState={{ expanded }}
          onPress={onToggle}
          className="flex-1 pr-2"
        >
          <Text className="text-[16px] font-medium text-foreground" numberOfLines={1}>
            {food.name}
          </Text>
          <Text className="mt-0.5 text-[13px] text-muted" numberOfLines={1}>
            {food.serving} · {food.nutrients.calories} cal
          </Text>
          <View className="mt-1.5">
            <MacroLine nutrients={food.nutrients} />
          </View>
        </Pressable>
        {trailing}
      </View>
      {expanded ? <AddPanel food={food} /> : null}
    </Card>
  );
}

export function BookmarkToggle({ name, saved, onPress }: { name: string; saved: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={saved ? `Unsave ${name}` : `Save ${name}`}
      accessibilityState={{ selected: saved }}
      onPress={onPress}
      hitSlop={8}
      className="h-10 w-10 items-center justify-center rounded-full"
    >
      <Bookmark
        size={20}
        color={saved ? tokens.colors.foreground : tokens.colors.muted}
        fill={saved ? tokens.colors.foreground : 'transparent'}
      />
    </Pressable>
  );
}
