import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { ChartNoAxesColumn, House, Plus, User, Users } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { tokens } from '@/lib/tokens';

const ICONS = { index: House, progress: ChartNoAxesColumn, groups: Users, profile: User } as const;

/** Bottom inset every tab screen should leave free for the floating bar. */
export const TAB_BAR_SPACE = 120;

/** Bar sits just above the home indicator (or 12pt up without one). */
export const barBottom = (inset: number) => (inset > 0 ? Math.max(12, inset - 4) : 12);

export function Fab({ onPress, label, children }: { onPress: () => void; label: string; children: React.ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="h-[53px] w-[53px] items-center justify-center rounded-full bg-fab"
      style={{ shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}
    >
      {children}
    </Pressable>
  );
}

export function TabBar({ state, descriptors, navigation, onAdd }: BottomTabBarProps & { onAdd: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      className="absolute left-0 right-0 flex-row items-center px-[18px]"
      style={{ bottom: barBottom(insets.bottom) }}
    >
      <View
        className="mr-2.5 flex-1 flex-row rounded-full border border-border bg-card/95 p-1"
        style={{ shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 2 } }}
      >
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const Icon = ICONS[route.name as keyof typeof ICONS] ?? House;
          const title = descriptors[route.key].options.title ?? route.name;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={title}
              onPress={() => {
                const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !e.defaultPrevented) navigation.navigate(route.name);
              }}
              className={`flex-1 items-center rounded-full py-2 ${focused ? 'bg-tab-active' : ''}`}
            >
              <Icon
                size={19}
                color={focused ? tokens.colors.foreground : tokens.colors.muted}
                fill={focused && route.name === 'index' ? tokens.colors.foreground : 'none'}
              />
              <Text className={`mt-0.5 text-[11.5px] ${focused ? 'font-semibold text-foreground' : 'text-muted'}`}>{title}</Text>
            </Pressable>
          );
        })}
      </View>
      <Fab label="Add" onPress={onAdd}>
        <Plus size={30} color="#fff" strokeWidth={2.2} />
      </Fab>
    </View>
  );
}
