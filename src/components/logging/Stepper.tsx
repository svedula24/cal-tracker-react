import { Minus, Plus } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';

import { tokens } from '@/lib/tokens';

export const formatServings = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** −/+ servings stepper (step 0.5, min 0.5). */
export function ServingsStepper({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const dec = () => onChange(Math.max(0.5, value - 0.5));
  const inc = () => onChange(value + 0.5);
  return (
    <View className="flex-row items-center">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Decrease servings"
        accessibilityState={{ disabled: value <= 0.5 }}
        disabled={value <= 0.5}
        onPress={dec}
        className={`h-10 w-10 items-center justify-center rounded-full bg-track ${value <= 0.5 ? 'opacity-40' : ''}`}
      >
        <Minus size={18} color={tokens.colors.foreground} />
      </Pressable>
      <Text accessibilityLabel={`${formatServings(value)} servings`} className="min-w-[56px] text-center text-[17px] font-semibold text-foreground">
        {formatServings(value)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Increase servings"
        onPress={inc}
        className="h-10 w-10 items-center justify-center rounded-full bg-track"
      >
        <Plus size={18} color={tokens.colors.foreground} />
      </Pressable>
    </View>
  );
}
