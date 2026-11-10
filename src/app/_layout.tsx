import '../global.css';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { tokens } from '@/lib/tokens';

// Root stack: the tab group plus every pushed screen. Daily Score is a
// transparent modal drawn over Home. GestureHandlerRootView is required for
// the swipe-to-delete rows.
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: tokens.colors.background } }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="daily-score"
            options={{ presentation: 'transparentModal', animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }}
          />
        </Stack>
        <StatusBar style="dark" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
