import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import type { Food } from '@/data/foods';
import { newEntry, useEntries } from '@/lib/data';
import { useSelectedDay } from '@/lib/selectedDay';

import { PrimaryButton } from './PrimaryButton';
import { ServingsStepper } from './Stepper';

/** Expanded panel under a food row: servings, live calories, "Add to log". */
export function AddPanel({ food }: { food: Food }) {
  const [servings, setServings] = useState(1);
  const [day] = useSelectedDay();
  const { add } = useEntries();
  const calories = Math.round(food.nutrients.calories * servings);

  const onAdd = () => {
    add(newEntry(food, servings, day));
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <View className="mt-3 border-t border-border pt-3">
      <View className="flex-row items-center justify-between">
        <View>
          <Text className="text-[13px] text-muted">Servings</Text>
          <Text className="mt-0.5 text-[20px] font-bold text-foreground">
            {calories} <Text className="text-[14px] font-normal text-muted">cal</Text>
          </Text>
        </View>
        <ServingsStepper value={servings} onChange={setServings} />
      </View>
      <PrimaryButton label="Add to log" accessibilityLabel={`Add ${food.name} to log`} onPress={onAdd} className="mt-3" />
    </View>
  );
}
