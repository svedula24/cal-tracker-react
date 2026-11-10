import { router } from 'expo-router';
import { Bookmark, Dumbbell, ScanLine, Search, X } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { barBottom, Fab } from '@/components/TabBar';
import { tokens } from '@/lib/tokens';

const ITEMS = [
  { label: 'Log exercise', Icon: Dumbbell, href: '/log-exercise' },
  { label: 'Saved foods', Icon: Bookmark, href: '/saved-foods' },
  { label: 'Food Database', Icon: Search, href: '/food-database' },
  { label: 'Scan food', Icon: ScanLine, href: '/scan-food' },
] as const;

/** The + menu: dims the whole screen, shows four action tiles, + becomes X. */
export function AddMenu({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const bottom = barBottom(insets.bottom);
  return (
    <View className="absolute inset-0">
      <Pressable accessibilityLabel="Close menu" onPress={onClose} className="absolute inset-0 bg-black/30" />
      <View pointerEvents="box-none" className="absolute left-0 right-0 flex-row flex-wrap px-[30px]" style={{ bottom: bottom + 104, gap: 16 }}>
        {ITEMS.map(({ label, Icon, href }) => (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={() => {
              onClose();
              router.push(href);
            }}
            className="h-[94px] items-center justify-center rounded-tile bg-card"
            style={{ width: '47.5%' }}
          >
            <Icon size={26} color={tokens.colors.foreground} fill={label === 'Saved foods' ? tokens.colors.foreground : 'none'} />
            <Text className="mt-2 text-[16px] font-medium text-foreground">{label}</Text>
          </Pressable>
        ))}
      </View>
      <View pointerEvents="box-none" className="absolute right-[18px]" style={{ bottom: bottom + 1 }}>
        <Fab label="Close menu" onPress={onClose}>
          <X size={28} color="#fff" strokeWidth={2} />
        </Fab>
      </View>
    </View>
  );
}
