import { router } from 'expo-router';
import { Bookmark, ScanLine, Search, X } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Press } from '@/components/Press';
import { Fab, fabBottom } from '@/components/Fab';
import { tokens } from '@/lib/tokens';

const ITEMS = [
  { label: 'Saved foods', Icon: Bookmark, href: '/saved-foods' },
  { label: 'Food Database', Icon: Search, href: '/food-database' },
  { label: 'Scan food', Icon: ScanLine, href: '/scan-food' },
] as const;

/** The + menu: dims the screen, shows the action tiles above the button, + becomes X. */
export function AddMenu({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const bottom = fabBottom(insets.bottom);
  return (
    <View className="absolute inset-0">
      <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)} style={StyleSheet.absoluteFill}>
        <Press scale={1} dim={1} accessibilityLabel="Close menu" onPress={onClose} className="absolute inset-0 bg-black/30" />
      </Animated.View>
      <View pointerEvents="box-none" className="absolute left-0 right-0 flex-row flex-wrap px-[30px]" style={{ bottom: bottom + 72, gap: 16 }}>
        {ITEMS.map(({ label, Icon, href }, i) => (
          <Animated.View
            key={label}
            entering={FadeInDown.delay(i * 40).springify().damping(16).stiffness(200)}
            exiting={FadeOutDown.duration(120)}
            // Three tiles: two side by side, Scan food full width below.
            style={{ width: label === 'Scan food' ? '100%' : '47.5%' }}
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
