import { Pressable } from 'react-native';

/** Bottom space scroll content leaves free for the floating + button. */
export const BOTTOM_SPACE = 110;

/** The + button sits just above the home indicator (or 12pt up without one). */
export const fabBottom = (inset: number) => (inset > 0 ? Math.max(12, inset - 4) : 12);

/** Black round floating button (the + / X of the add menu). */
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
