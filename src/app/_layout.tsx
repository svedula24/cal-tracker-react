import '../global.css';

import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { startSync } from '@/lib/sync';
import { tokens } from '@/lib/tokens';

// Root stack: Home (the only main screen) plus every pushed screen. Daily Score is a
// transparent modal drawn over Home. GestureHandlerRootView is required for
// the swipe-to-delete rows.
export default function RootLayout() {
  // Background sync with the server; does nothing unless the build has an API URL.
  useEffect(() => startSync(), []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: tokens.colors.background } }}>
          <Stack.Screen name="index" />
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
