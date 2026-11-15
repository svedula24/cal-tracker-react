import { router } from 'expo-router';
import { Smartphone } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { Press } from '@/components/Press';
import { Card } from '@/components/Screen';
import { answerLinkOffer, useLinkOffer } from '@/lib/sync';
import { tokens } from '@/lib/tokens';

/**
 * A new install's first-run offer (only with a server, before this install has an account): link to
 * the account of a device already in use, or start fresh. Until answered, sync waits (src/lib/sync).
 */
export function LinkOffer() {
  if (!useLinkOffer()) return null;
  return (
    <View className="mt-[15px] px-[16px]">
      <Card className="p-4">
        <View className="flex-row items-center">
          <Smartphone size={18} color={tokens.colors.foreground} />
          <Text className="ml-2 flex-1 text-[16px] font-semibold text-foreground">Already use Kalo on another device?</Text>
        </View>
        <Text className="mt-1 text-[14px] leading-[20px] text-muted">Link this device to see the same food log and goals here.</Text>
        <View className="mt-3 flex-row" style={{ gap: 8 }}>
          <Press
            accessibilityRole="button"
            accessibilityLabel="Already use Kalo? Link this device"
            onPress={() => router.push('/link-device?enter=1')}
            className="h-[40px] flex-1 items-center justify-center rounded-full bg-fab"
          >
            <Text className="text-[14px] font-semibold text-white">Link this device</Text>
          </Press>
          <Press accessibilityRole="button" accessibilityLabel="Not now" onPress={answerLinkOffer} className="h-[40px] flex-1 items-center justify-center rounded-full border border-border bg-card">
            <Text className="text-[14px] font-medium text-foreground">Not now</Text>
          </Press>
        </View>
      </Card>
    </View>
  );
}
