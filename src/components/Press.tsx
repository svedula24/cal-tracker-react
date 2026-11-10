import { cssInterop } from 'nativewind';
import { useCallback } from 'react';
import { Pressable, type PressableProps } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

// An Animated Pressable that still understands NativeWind's className.
const AnimatedPressable = cssInterop(Animated.createAnimatedComponent(Pressable), { className: 'style' });

const SPRING = { damping: 18, stiffness: 320, mass: 0.6, reduceMotion: ReduceMotion.System };

/**
 * A Pressable with touch feedback: it springs down to `scale` and dims to
 * `dim` while pressed, on the UI thread. Drop-in for Pressable on controls.
 */
export function Press({ scale = 0.96, dim = 0.85, onPressIn, onPressOut, style, ...props }: PressableProps & { scale?: number; dim?: number }) {
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
  return <AnimatedPressable {...props} onPressIn={pressIn} onPressOut={pressOut} style={[animated, style as object]} />;
}
