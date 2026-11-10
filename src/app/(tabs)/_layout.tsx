import { Tabs } from 'expo-router/js-tabs';
import { useState } from 'react';
import { View } from 'react-native';

import { AddMenu } from '@/components/AddMenu';
import { TabBar } from '@/components/TabBar';

// Four tabs in a floating pill bar plus the black + button. The + menu is drawn
// over everything (tab bar included, dimmed) with its own X button on top.
export default function TabsLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <View className="flex-1 bg-background">
      <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <TabBar {...props} onAdd={() => setMenuOpen(true)} />}>
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="progress" options={{ title: 'Progress' }} />
        <Tabs.Screen name="groups" options={{ title: 'Groups' }} />
        <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
      </Tabs>
      {menuOpen ? <AddMenu onClose={() => setMenuOpen(false)} /> : null}
    </View>
  );
}
