import { type ReactNode, useState } from 'react';
import Animated, { runOnJS, type SharedValue, useAnimatedReaction, useAnimatedStyle } from 'react-native-reanimated';

/**
 * The slot for a ReanimatedSwipeable action (`renderRightActions`). The action
 * sits behind its row, so it would show around the row when the row's press
 * feedback shrinks and dims it. Here it is invisible, and takes no touches,
 * until the row is dragged left. `translation` is the second argument
 * `renderRightActions` receives.
 */
export function SwipeAction({ translation, width, children }: { translation: SharedValue<number>; width: number; children: ReactNode }) {
  const revealed = useAnimatedStyle(() => ({ opacity: translation.value < 0 ? 1 : 0 }));
  // Touches follow React state, not the animated style: a plain `pointerEvents` style is
  // applied the same way on every platform, where an animated one is not guaranteed to be.
  const [touchable, setTouchable] = useState(false);
  useAnimatedReaction(
    () => translation.value < 0,
    (now, before) => {
      if (now !== before) runOnJS(setTouchable)(now);
    },
  );
  // Plain styles, not classes: on native NativeWind drops classes it has to merge with a Reanimated style.
  return <Animated.View style={[{ marginLeft: 10, width, pointerEvents: touchable ? 'auto' : 'none' }, revealed]}>{children}</Animated.View>;
}
