import { router } from 'expo-router';
import { Bookmark, ScanLine, Search, X } from 'lucide-react-native';
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Fab, fabBottom } from '@/components/Fab';
import { Press } from '@/components/Press';
import { useEntries } from '@/lib/data';
import { fmt, scale } from '@/lib/measure';
import { recentFoods } from '@/lib/recentFoods';
import { tokens } from '@/lib/tokens';

const ITEMS = [
  { label: 'Saved foods', Icon: Bookmark, href: '/saved-foods' },
  { label: 'Food Database', Icon: Search, href: '/food-database' },
  { label: 'Scan food', Icon: ScanLine, href: '/scan-food' },
] as const;

/** How many recent foods the menu offers: it must fit above the tiles on a small phone. */
const RECENT_LIMIT = 3;

/**
 * The + menu: dims the screen, shows the action tiles above the button, + becomes X.
 * Above the tiles, the foods the user logged last ("Recent"); none for a new user.
 */
export function AddMenu({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const bottom = fabBottom(insets.bottom);
  const { items } = useEntries();
  const recents = useMemo(() => recentFoods(items, RECENT_LIMIT), [items]);
  // The card is the first of the stagger, so the tiles start one step later.
  const first = recents.length ? 1 : 0;
  return (
    <View className="absolute inset-0">
      <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)} style={StyleSheet.absoluteFill}>
        <Press scale={1} dim={1} accessibilityLabel="Close menu" onPress={onClose} className="absolute inset-0 bg-black/30" />
      </Animated.View>
      <View pointerEvents="box-none" className="absolute left-0 right-0 flex-row flex-wrap px-[30px]" style={{ bottom: bottom + 72, gap: 16 }}>
        {recents.length ? (
          <Animated.View
            entering={FadeInDown.springify().damping(16).stiffness(200)}
            exiting={FadeOutDown.duration(120)}
            style={{ width: '100%' }}
          >
          {/* The classes sit on a plain View: NativeWind and Reanimated don't share one. */}
          <View accessibilityLabel="Recent foods" className="rounded-tile bg-card px-4 pb-1 pt-3">
            <Text className="text-[13px] font-medium text-muted">Recent</Text>
            {recents.map(({ food, grams }, i) => (
              <Press
                key={food.id}
                accessibilityRole="button"
                accessibilityLabel={`Log ${food.name} again, ${fmt(grams)} g`}
                onPress={() => {
                  onClose();
                  // Opens Nutrition at the last amount; nothing is logged until Done.
                  router.push({ pathname: '/nutrition', params: { food: JSON.stringify(food), grams: String(grams) } });
                }}
                className={`py-2 ${i ? 'border-t border-border' : ''}`}
              >
                <Text className="text-[16px] font-medium text-foreground" numberOfLines={1}>
                  {food.name}
                </Text>
                <Text className="mt-0.5 text-[13px] text-muted" numberOfLines={1}>
                  {fmt(grams)} g · {fmt(scale(food.per100g, grams).calories)} cal
                </Text>
              </Press>
            ))}
          </View>
          </Animated.View>
        ) : null}
        {ITEMS.map(({ label, Icon, href }, i) => (
          <Animated.View
            key={label}
            entering={FadeInDown.delay((first + i) * 40).springify().damping(16).stiffness(200)}
            exiting={FadeOutDown.duration(120)}
            // Three tiles: two side by side, Scan food full width below.
            // Scan food takes a row; the other two share one. They grow from 40% rather than take a
            // fixed 47.5%, which with the 16 px gap is wider than the row on a 375 px screen and wrapped.
            style={label === 'Scan food' ? { width: '100%' } : { flexGrow: 1, flexBasis: '40%' }}
          >
          <Press
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => {
              onClose();
              router.push(href);
            }}
            className="h-[94px] items-center justify-center rounded-tile bg-card"
          >
            <Icon size={26} color={tokens.colors.foreground} fill={label === 'Saved foods' ? tokens.colors.foreground : 'none'} />
            <Text className="mt-2 text-[16px] font-medium text-foreground">{label}</Text>
          </Press>
          </Animated.View>
        ))}
      </View>
      <View pointerEvents="box-none" className="absolute right-[18px]" style={{ bottom }}>
        <Fab label="Close menu" onPress={onClose}>
          <X size={28} color="#fff" strokeWidth={2} />
        </Fab>
      </View>
    </View>
  );
}
