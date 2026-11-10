import { Droplet, Drumstick, Wheat } from 'lucide-react-native';
import { Text, View } from 'react-native';

import type { Nutrients } from '@/lib/nutrition';
import { tokens } from '@/lib/tokens';

/** "P g · C g · F g" with the Home entry-card macro icons. */
export function MacroLine({ nutrients, servings = 1 }: { nutrients: Nutrients; servings?: number }) {
  const items = [
    { key: 'protein', Icon: Drumstick, color: tokens.colors.protein, value: nutrients.protein },
    { key: 'carbs', Icon: Wheat, color: tokens.colors.carbs, value: nutrients.carbs },
    { key: 'fat', Icon: Droplet, color: tokens.colors.fat, value: nutrients.fat },
  ] as const;
  return (
    <View className="flex-row items-center gap-3">
      {items.map(({ key, Icon, color, value }) => (
        <View key={key} className="flex-row items-center gap-1">
          <Icon size={13} color={color} fill={color} />
          <Text className="text-[13px] text-muted">{Math.round(value * servings)}g</Text>
        </View>
      ))}
    </View>
  );
}
