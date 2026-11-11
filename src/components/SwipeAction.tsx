import type { ReactNode } from 'react';
import Animated, { type SharedValue, useAnimatedStyle } from 'react-native-reanimated';

/**
 * The slot for a ReanimatedSwipeable action (`renderRightActions`). The action
 * sits behind its row, so it would show around the row when the row's press
 * feedback shrinks and dims it. Here it is invisible until the row is dragged
 * left. `translation` is the second argument `renderRightActions` receives.
 */
export function SwipeAction({ translation, width, children }: { translation: SharedValue<number>; width: number; children: ReactNode }) {
  const revealed = useAnimatedStyle(() => ({ opacity: translation.value < 0 ? 1 : 0 }));
  // Plain styles, not classes: on native NativeWind drops classes it has to merge with a Reanimated style.
  return <Animated.View style={[{ marginLeft: 10, width }, revealed]}>{children}</Animated.View>;
}
