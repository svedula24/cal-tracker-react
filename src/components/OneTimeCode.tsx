import * as Clipboard from 'expo-clipboard';
import { Check, Copy } from 'lucide-react-native';
import { useState } from 'react';
import { AccessibilityInfo, Platform, Text, View } from 'react-native';

import { Press } from '@/components/Press';
import { formatCountdown } from '@/lib/connectionsApi';
import { tokens } from '@/lib/tokens';

const c = tokens.colors;
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, Consolas, monospace' });

/** Says `message` with VoiceOver / TalkBack (a changed Text is not read by itself on iOS). */
export const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

/** A live one-time code (Connect ChatGPT, Link another device): big, selectable, with Copy and the time left. */
export function OneTimeCode({ code, left }: { code: string; left: number }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => {
    // On web the browser may refuse (it resolves false); native always copies.
    const ok = await Clipboard.setStringAsync(code).catch(() => false);
    setCopied(ok);
    announce(ok ? 'Copied.' : "Couldn't copy: select the code instead.");
  };
  return (
    <View>
      <View className="mt-3 flex-row items-center justify-between rounded-tile bg-chip px-4 py-3">
        <Text accessibilityLabel={`Code ${code}`} selectable className="text-[30px] font-bold text-foreground" style={{ fontFamily: MONO, letterSpacing: 2 }}>
          {code}
        </Text>
        <Press accessibilityRole="button" accessibilityLabel="Copy code" onPress={copy} className="h-10 w-10 items-center justify-center rounded-full bg-card">
          {copied ? <Check size={18} color={c.good} /> : <Copy size={18} color={c.foreground} />}
        </Press>
      </View>
      {copied === null ? null : (
        <Text accessibilityLiveRegion="polite" className="mt-2 text-[13px] text-muted">
          {copied ? 'Copied.' : "Couldn't copy: select the code instead."}
        </Text>
      )}
      <Text className={`${copied === null ? 'mt-2' : 'mt-[2px]'} text-[13px] text-muted`}>Expires in {formatCountdown(left)}</Text>
    </View>
  );
}

/** A numbered instruction under a code. */
export function Step({ n, text }: { n: number; text: string }) {
  return (
    <View className="flex-row">
      <View className="mr-3 mt-[1px] h-[20px] w-[20px] items-center justify-center rounded-full bg-foreground">
        <Text className="text-[12px] font-semibold text-background">{n}</Text>
      </View>
      <Text className="flex-1 text-[14px] leading-[20px] text-foreground">{text}</Text>
    </View>
  );
}
