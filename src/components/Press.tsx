import { cssInterop } from 'nativewind';
import { forwardRef, useCallback } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewInstance, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle, ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// A plain style only: Base composes it into an array with the animated style,
// where Pressable's `({ pressed }) => style` form would be ignored.
type PressProps = Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle> };
type BaseProps = PressProps & { animatedStyle: AnimatedStyle<ViewStyle> };

// NativeWind resolves `className` into this component's `style`. The animated
// style is kept in its own prop and composed here, because on native NativeWind
// drops every class when it has to merge a Reanimated style object itself.
const Base = forwardRef<ViewInstance, BaseProps>(function PressBase({ animatedStyle, style, ...props }, ref) {
  return <AnimatedPressable ref={ref} {...props} style={[style, animatedStyle]} />;
});
const StyledBase = cssInterop(Base, { className: 'style' });

const SPRING = { damping: 18, stiffness: 320, mass: 0.6, reduceMotion: ReduceMotion.System };

/**
 * A Pressable with touch feedback: it springs down to `scale` and dims to
 * `dim` while pressed, on the UI thread. Drop-in for Pressable on controls,
 * except `style` takes a plain style, not a `({ pressed }) => style` function.
 * Press owns `opacity` and `transform`: an `opacity-*` or `scale-*` class on
 * it has no effect, even at rest.
 */
export function Press({ scale = 0.96, dim = 0.85, onPressIn, onPressOut, ...props }: PressProps & { scale?: number; dim?: number }) {
  const pressed = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * (1 - scale) }],
    opacity: 1 - pressed.value * (1 - dim),
  }));
  const pressIn = useCallback<NonNullable<PressableProps['onPressIn']>>(
    (e) => {
      pressed.value = withSpring(1, SPRING);
      onPressIn?.(e);
    },
    [onPressIn, pressed],
  );
  const pressOut = useCallback<NonNullable<PressableProps['onPressOut']>>(
    (e) => {
      pressed.value = withSpring(0, SPRING);
      onPressOut?.(e);
    },
    [onPressOut, pressed],
  );
  return <StyledBase {...props} onPressIn={pressIn} onPressOut={pressOut} animatedStyle={animated} />;
}
