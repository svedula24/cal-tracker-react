import * as Clipboard from 'expo-clipboard';
import { Check, Copy, Footprints } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Platform, ScrollView, Text, View } from 'react-native';

import { Press } from '@/components/Press';
import { Card, PushedScreen } from '@/components/Screen';
import { API_URL } from '@/lib/config';
import { createIntegrationToken, type IntegrationToken, listIntegrationTokens, type ProblemContext, problemMessage, revokeIntegrationToken, stepsUrl } from '@/lib/integrationsApi';
import { deviceToken, syncNow } from '@/lib/sync';
import { SyncUnauthorized } from '@/lib/sync/types';
import { tokens } from '@/lib/tokens';

const c = tokens.colors;
const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, Consolas, monospace' });

/** Says `message` with VoiceOver / TalkBack (a changed Text is not read by itself on iOS). */
const announce = (message: string) => AccessibilityInfo.announceForAccessibility(message);

/** The message for a failed request; a 401 also has sync register this phone again (as after any 401). */
function failed(e: unknown, context: ProblemContext): string {
  if (e instanceof SyncUnauthorized) syncNow();
  return problemMessage(e, context);
}

type CreateState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'made'; id: string; token: string };
type ListState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; tokens: IntegrationToken[] };

/**
 * Apple Health steps: an Apple Shortcuts automation on the iPhone reads today's steps from Health and
 * sends them to Kalo with an integration token (it can set steps and nothing else). This screen makes
 * the token (shown once), shows the URL and how to build the Shortcut, and lists the tokens with Revoke.
 * Opened from Goals; needs the API. The full recipe: docs/health-shortcut.md.
 */
export default function HealthStepsScreen() {
  return (
    <PushedScreen title="Apple Health steps">
      {API_URL ? (
        <HealthSteps />
      ) : (
        <View className="px-5 pt-4">
          <Text className="text-[15px] text-muted">This build has no server, so a Shortcut has nowhere to send your steps.</Text>
        </View>
      )}
    </PushedScreen>
  );
}

function HealthSteps() {
  const url = API_URL!;
  const [create, setCreate] = useState<CreateState>({ kind: 'idle' });
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  // Every request is aborted when the screen closes, so nothing updates an unmounted screen. The new
  // token lives only in this screen's state: leaving the screen forgets it for good.
  const life = useRef<AbortController>(null!);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);

  // Only the newest load may set the list (an older one could bring back a revoked row).
  const loads = useRef(0);
  const loadList = useCallback(async () => {
    const { signal } = life.current;
    const n = ++loads.current;
    const current = () => !signal.aborted && n === loads.current;
    try {
      const token = await deviceToken();
      const got = await listIntegrationTokens(url, token, { signal });
      if (current()) setList({ kind: 'ready', tokens: got });
    } catch (e) {
      if (current()) setList({ kind: 'error', message: failed(e, 'list') });
    }
  }, [url]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const makeToken = async () => {
    const { signal } = life.current;
    setCreate({ kind: 'loading' });
    try {
      const token = await deviceToken();
      const made = await createIntegrationToken(url, token, undefined, { signal });
      if (signal.aborted) return;
      setCreate({ kind: 'made', id: made.id, token: made.token });
      announce('Token created. Copy it now: it will not be shown again.');
      void loadList();
    } catch (e) {
      if (signal.aborted) return;
      const message = failed(e, 'create');
      setCreate({ kind: 'error', message });
      announce(message);
    }
  };

  const revoke = async (id: string) => {
    const { signal } = life.current;
    const token = await deviceToken();
    await revokeIntegrationToken(url, token, id, { signal });
    if (signal.aborted) return;
    loads.current++; // a list load already under way answers from before the revoke
    setCreate((made) => (made.kind === 'made' && made.id === id ? { kind: 'idle' } : made)); // a revoked token is no use to copy
    setList((l) => (l.kind === 'ready' ? { kind: 'ready', tokens: l.tokens.filter((x) => x.id !== id) } : l));
  };

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 12 }}>
      <Card className="p-5">
        <View className="flex-row items-center">
          <Footprints size={18} color={c.foreground} />
          <Text className="ml-2 text-[17px] font-semibold text-foreground">Steps from Apple Health</Text>
        </View>
        <Text className="mt-2 text-[14px] leading-[20px] text-muted">
          Kalo on the web can't read Apple Health. A Shortcuts automation on your iPhone can: it reads today's step count from Health and sends
          it to Kalo a few times a day. It sends steps only, with a token that can set steps and nothing else.
        </Text>
      </Card>

      <Card className="p-5">
        <Text className="text-[17px] font-semibold text-foreground">1. Create a token</Text>
        <TokenPanel state={create} onCreate={makeToken} />
      </Card>

      <Card className="p-5">
        <Text className="text-[17px] font-semibold text-foreground">2. Build the Shortcut</Text>
        <Text className="mt-2 text-[14px] leading-[20px] text-muted">In the Shortcuts app, make a shortcut that sends today's steps:</Text>
        <View className="mt-3" style={{ gap: 8 }}>
          <Step n={1} text="Find Health Samples: Type Steps, Start Date is today, Group By Day. Then Calculate Statistics (Sum), then Round Number." />
          <Step n={2} text="If Rounded Number is greater than 0: Format Date (Current Date, Custom, yyyy-MM-dd), then Get Contents of URL." />
          <Step n={3} text="Get Contents of URL: the URL below with {date} replaced by Formatted Date. Show More: Method PUT, header Authorization = Bearer and your token, Request Body JSON with a Number field steps = Rounded Number." />
          <Step n={4} text="Add the same for yesterday: Adjust Date (Current Date, subtract 1 day); Start Date is on Adjusted Date; Format Date of Adjusted Date." />
        </View>
        <Text className="mt-4 text-[13px] font-semibold text-foreground">URL</Text>
        <Copyable value={stepsUrl(url)} label="URL" small />
        <Text className="mt-2 text-[13px] leading-[18px] text-muted">The iPhone must reach this address over the internet (Kalo's public server).</Text>
      </Card>

      <Card className="p-5">
        <Text className="text-[17px] font-semibold text-foreground">3. Run it every day</Text>
        <Text className="mt-2 text-[14px] leading-[20px] text-foreground">
          Shortcuts → Automation → New → Time of Day, Daily, Run Immediately, Notify When Run off. Make two: 07:00 (sends yesterday's final count)
          and 21:00. Add more times to see steps during the day.
        </Text>
        <Text className="mt-2 text-[13px] leading-[18px] text-muted">The full recipe, with what each error means, is in docs/health-shortcut.md.</Text>
      </Card>

      <Card className="px-5 pb-2 pt-5">
        <Text className="text-[17px] font-semibold text-foreground">Health tokens</Text>
        {list.kind === 'loading' ? (
          <View className="items-start py-4">
            <ActivityIndicator color={c.muted} accessibilityLabel="Loading tokens" />
          </View>
        ) : list.kind === 'error' ? (
          <View className="py-3">
            <Text accessibilityLiveRegion="polite" className="text-[14px] text-bad">
              {list.message}
            </Text>
            <Press accessibilityRole="button" accessibilityLabel="Try again" onPress={() => void loadList()} className="mt-3 h-[40px] w-[120px] items-center justify-center rounded-full border border-foreground">
              <Text className="text-[14px] font-semibold text-foreground">Try again</Text>
            </Press>
          </View>
        ) : list.tokens.length === 0 ? (
          <Text className="py-3 text-[14px] text-muted">No tokens yet.</Text>
        ) : (
          list.tokens.map((t, i) => <TokenRow key={t.id} token={t} first={i === 0} onRevoke={() => revoke(t.id)} />)
        )}
      </Card>
    </ScrollView>
  );
}

function TokenPanel({ state, onCreate }: { state: CreateState; onCreate: () => void }) {
  if (state.kind === 'loading') {
    return (
      <View className="items-start py-4">
        <ActivityIndicator color={c.muted} accessibilityLabel="Creating a token" />
      </View>
    );
  }
  if (state.kind === 'made') {
    return (
      <View testID="new-health-token">
        <Text className="mt-2 text-[14px] leading-[20px] text-foreground">
          Copy it into the Shortcut now. Kalo will not show it again; if you lose it, revoke it and create another.
        </Text>
        <Copyable value={state.token} label="token" />
      </View>
    );
  }
  return (
    <View>
      <Text accessibilityLiveRegion="polite" className={`mt-2 text-[14px] leading-[20px] ${state.kind === 'error' ? 'text-bad' : 'text-muted'}`}>
        {state.kind === 'error' ? state.message : 'The Shortcut sends this token with your steps. It is shown once, right after you create it.'}
      </Text>
      <Press
        accessibilityRole="button"
        accessibilityLabel={state.kind === 'error' ? 'Try again' : 'Create token'}
        onPress={onCreate}
        className="mt-4 h-[48px] items-center justify-center rounded-full bg-fab"
      >
        <Text className="text-[16px] font-semibold text-white">{state.kind === 'error' ? 'Try again' : 'Create token'}</Text>
      </Press>
    </View>
  );
}

/** Text in a box with a Copy button (the browser may refuse to copy: then select it instead). */
function Copyable({ value, label, small = false }: { value: string; label: string; small?: boolean }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => {
    const ok = await Clipboard.setStringAsync(value).catch(() => false);
    setCopied(ok);
    announce(ok ? 'Copied.' : `Couldn't copy: select the ${label} instead.`);
  };
  return (
    <View>
      <View className="mt-2 flex-row items-center rounded-tile bg-chip px-3 py-3">
        <Text selectable className={`flex-1 ${small ? 'text-[13px]' : 'text-[14px]'} text-foreground`} style={{ fontFamily: MONO }}>
          {value}
        </Text>
        <Press accessibilityRole="button" accessibilityLabel={`Copy ${label}`} onPress={copy} className="ml-2 h-10 w-10 items-center justify-center rounded-full bg-card">
          {copied ? <Check size={18} color={c.good} /> : <Copy size={18} color={c.foreground} />}
        </Press>
      </View>
      {copied === null ? null : (
        <Text accessibilityLiveRegion="polite" className="mt-2 text-[13px] text-muted">
          {copied ? 'Copied.' : `Couldn't copy: select the ${label} instead.`}
        </Text>
      )}
    </View>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <View className="flex-row">
      <View className="mr-3 mt-[1px] h-[20px] w-[20px] items-center justify-center rounded-full bg-foreground">
        <Text className="text-[12px] font-semibold text-background">{n}</Text>
      </View>
      <Text className="flex-1 text-[14px] leading-[20px] text-foreground">{text}</Text>
    </View>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function TokenRow({ token, first, onRevoke }: { token: IntegrationToken; first: boolean; onRevoke: () => Promise<void> }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const name = token.label || 'Health token';
  const confirm = async () => {
    setStep('busy');
    try {
      await onRevoke();
    } catch (e) {
      const text = failed(e, 'revoke');
      setMessage(text);
      setStep('error');
      announce(text);
    }
  };
  return (
    <View className={`py-3 ${first ? '' : 'border-t border-border'}`}>
      <View className="flex-row items-center">
        <View className="flex-1">
          <Text className="text-[16px] font-semibold text-foreground">{name}</Text>
          <Text className="mt-[2px] text-[13px] text-muted">
            Created {day(token.createdAt)}
            {token.lastUsedAt ? ` · last used ${day(token.lastUsedAt)}` : ' · not used yet'}
          </Text>
        </View>
        {step === 'idle' || step === 'error' ? (
          <Press accessibilityRole="button" accessibilityLabel={`Revoke ${name}`} onPress={() => setStep('confirm')} className="h-[34px] items-center justify-center rounded-full border border-border px-3">
            <Text className="text-[14px] font-medium text-bad">Revoke</Text>
          </Press>
        ) : null}
      </View>
      {step === 'error' ? (
        <Text accessibilityLiveRegion="polite" className="mt-2 text-[13px] text-bad">
          {message}
        </Text>
      ) : null}
      {step === 'confirm' || step === 'busy' ? (
        <View className="mt-3 rounded-tile bg-chip p-3">
          <Text className="text-[14px] leading-[20px] text-foreground">A Shortcut using this token will stop sending steps. You can create a new token any time.</Text>
          <View className="mt-3 flex-row" style={{ gap: 8 }}>
            <Press accessibilityRole="button" accessibilityLabel="Cancel" disabled={step === 'busy'} onPress={() => setStep('idle')} className="h-[38px] flex-1 items-center justify-center rounded-full border border-border bg-card">
              <Text className="text-[14px] font-medium text-foreground">Cancel</Text>
            </Press>
            <Press accessibilityRole="button" accessibilityLabel={`Confirm revoke ${name}`} disabled={step === 'busy'} onPress={confirm} className="h-[38px] flex-1 items-center justify-center rounded-full bg-bad">
              {step === 'busy' ? <ActivityIndicator color={c.background} /> : <Text className="text-[14px] font-semibold text-white">Revoke</Text>}
            </Press>
          </View>
        </View>
      ) : null}
    </View>
  );
}
