import { Pressable, Text } from 'react-native';

/** Black pill button (~52px), white label. */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  accessibilityLabel,
  className = '',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  className?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`h-[52px] items-center justify-center rounded-full px-6 ${disabled ? 'bg-faint' : 'bg-foreground active:opacity-80'} ${className}`}
    >
      <Text className="text-[16px] font-semibold text-card">{label}</Text>
    </Pressable>
  );
}
