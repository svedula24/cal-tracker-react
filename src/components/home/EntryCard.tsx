import { Image } from 'expo-image';
import { useRef } from 'react';
import { router } from 'expo-router';
import { Droplet, Drumstick, Trash2, Wheat } from 'lucide-react-native';
import { Text, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { Press } from '@/components/Press';
import { SwipeAction } from '@/components/SwipeAction';
import type { Entry } from '@/lib/data';
import { formatTime } from '@/lib/nutrition';
import { tokens } from '@/lib/tokens';

const c = tokens.colors;

function Macro({ icon, value }: { icon: React.ReactNode; value: number }) {
  return (
    <View className="mr-[16px] flex-row items-center">
      {icon}
      <Text className="ml-[5px] text-[12.5px] text-muted">{value}g</Text>
    </View>
  );
}

/** A "Recently uploaded" card. Tap to edit; swipe left to delete. */
export function EntryCard({ entry, onDelete }: { entry: Entry; onDelete: () => void }) {
  const s = entry.servings;
  const kcal = Math.round(entry.nutrients.calories * s);
  const g = (v: number) => Math.round(v * s);
  // A drag that opens the swipe action must not also count as a tap on the card.
  const dragged = useRef(false);
  return (
    <ReanimatedSwipeable
      friction={2}
      onSwipeableOpenStartDrag={() => {
        dragged.current = true;
      }}
      onSwipeableOpen={() => {
        dragged.current = false;
      }}
      onSwipeableClose={() => {
        dragged.current = false;
      }}
      rightThreshold={60}
      renderRightActions={(_progress, translation) => (
        <SwipeAction translation={translation} width={84}>
          <Press
            accessibilityRole="button"
            accessibilityLabel={`Delete ${entry.name}`}
            onPress={onDelete}
            className="flex-1 items-center justify-center rounded-2xl bg-bad"
          >
            <Trash2 size={22} color="#fff" />
            <Text className="mt-1 text-[13px] font-semibold text-white">Delete</Text>
          </Press>
        </SwipeAction>
      )}
    >
      <Press
        accessibilityRole="button"
        accessibilityLabel={`Edit ${entry.name}`}
        onPress={() => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          router.push({ pathname: '/nutrition', params: { id: entry.id } });
        }}
        className="h-[120px] flex-row overflow-hidden rounded-2xl border border-border bg-entry"
      >
        {entry.photo ? <Image source={{ uri: entry.photo }} style={{ width: 122, height: '100%' }} contentFit="cover" /> : null}
        <View className="flex-1 px-[15px] pt-[17px]">
          <View className="flex-row items-start justify-between">
            <Text numberOfLines={1} className="mr-3 flex-1 text-[15px] text-foreground">
              {entry.name}
            </Text>
            <Text className="mt-[2px] text-[11px] text-muted">{formatTime(entry.time)}</Text>
          </View>
          <Text className="mt-[14px] text-[16px] font-medium text-foreground">
            {kcal} Calories <Text className="text-[14px] font-normal text-muted">consumed</Text>
          </Text>
          <View className="mt-[15px] flex-row">
            <Macro icon={<Drumstick size={14} color={c.protein} fill={c.protein} />} value={g(entry.nutrients.protein)} />
            <Macro icon={<Wheat size={14} color={c.carbs} />} value={g(entry.nutrients.carbs)} />
            <Macro icon={<Droplet size={14} color={c.fat} fill={c.fat} />} value={g(entry.nutrients.fat)} />
          </View>
        </View>
      </Press>
    </ReanimatedSwipeable>
  );
}
