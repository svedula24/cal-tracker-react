import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { tokens } from '@/lib/tokens';

/** Pushed-screen chrome: back chevron + large title, then content. */
export function PushedScreen({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      <View className="flex-row items-center px-4 pb-2 pt-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          className="h-10 w-10 items-center justify-center rounded-full bg-card"
        >
          <ChevronLeft size={24} color={tokens.colors.foreground} />
        </Pressable>
        <Text className="ml-3 flex-1 text-[22px] font-bold text-foreground">{title}</Text>
        {right}
      </View>
      {children}
    </SafeAreaView>
  );
}

/** Honest placeholder for features that need a camera, AI or a server. */
export function ComingSoon({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <View className="flex-1 items-center justify-center px-10 pb-24">
      <View className="mb-5 h-20 w-20 items-center justify-center rounded-full bg-card">{icon}</View>
      <Text className="text-center text-[22px] font-bold text-foreground">{title}</Text>
      <Text className="mt-2 text-center text-[15px] leading-[21px] text-muted">{body}</Text>
      {action ? <View className="mt-6">{action}</View> : null}
    </View>
  );
}

/** Soft shadow that separates white cards from the white page (as in the reference). */
export const cardShadow = {
  shadowColor: '#1E1A3C',
  shadowOpacity: 0.07,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 3 },
  elevation: 2,
} as const;

/** White rounded card used across the app. */
export function Card({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <View className={`rounded-card border border-border/60 bg-card ${className}`} style={cardShadow}>
      {children}
    </View>
  );
}
