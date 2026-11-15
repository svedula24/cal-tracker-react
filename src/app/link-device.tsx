import { router, useLocalSearchParams } from 'expo-router';
import { Smartphone } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TextInput, View } from 'react-native';

import { announce, OneTimeCode, Step } from '@/components/OneTimeCode';
import { Press } from '@/components/Press';
import { Card, PushedScreen } from '@/components/Screen';
import { API_URL } from '@/lib/config';
import { codeDeadline } from '@/lib/connectionsApi';
import { createLinkCode, linkProblem, normaliseCode } from '@/lib/linkApi';
import { ownData } from '@/lib/data';
import { deviceToken, hasPreviousAccount, linkThisDevice, switchToPreviousAccount, syncNow, useLinkOffer } from '@/lib/sync';
import { SyncUnauthorized } from '@/lib/sync/types';
import { tokens } from '@/lib/tokens';

const c = tokens.colors;

type CodeState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'code'; code: string; deadline: number };

/**
 * Link another device: this install shows a one-time code; the other device (a new phone, Kalo as a
 * home-screen web app) enters it and gets the same data. Also where an install enters a code
 * (`?enter=1`, from Home's first-run offer, or "Link this device instead"). Opened from Goals; needs the API.
 */
export default function LinkDeviceScreen() {
  const { enter } = useLocalSearchParams<{ enter?: string }>();
  const [entering, setEntering] = useState(enter === '1');
  return (
    <PushedScreen title={entering ? 'Link this device' : 'Link another device'}>
      {!API_URL ? (
        <View className="px-5 pt-4">
          <Text className="text-[15px] text-muted">This build has no server, so devices cannot be linked.</Text>
        </View>
      ) : entering ? (
        <EnterCode />
      ) : (
        <ShowCode onEnterInstead={() => setEntering(true)} />
      )}
    </PushedScreen>
  );
}

function ShowCode({ onEnterInstead }: { onEnterInstead: () => void }) {
  const url = API_URL!;
  const [code, setCode] = useState<CodeState>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const life = useRef<AbortController>(null!);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);

  const getCode = async () => {
    const { signal } = life.current;
    setCode({ kind: 'loading' });
    try {
      const token = await deviceToken();
      const got = await createLinkCode(url, token, { signal });
      if (signal.aborted) return;
      const at = Date.now();
      setNow(at);
      setCode({ kind: 'code', code: got.code, deadline: codeDeadline(got.expiresAt, at) });
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof SyncUnauthorized) syncNow();
      const message = linkProblem(e, 'code');
      setCode({ kind: 'error', message });
      announce(message);
    }
  };

  const live = code.kind === 'code' && now < code.deadline;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const expired = code.kind === 'code' && !live;
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 12 }}>
      <Card className="p-5">
        <View className="flex-row items-center">
          <Smartphone size={18} color={c.foreground} />
          <Text className="ml-2 text-[17px] font-semibold text-foreground">Use Kalo on another device</Text>
        </View>
        <Text className="mt-2 text-[14px] leading-[20px] text-muted">
          Another phone, or Kalo added to an iPhone home screen from Safari, can share this device&apos;s food log and goals. Everything you log on
          either one shows up on both.
        </Text>
      </Card>

      <Card className="p-5">
        <Text className="text-[17px] font-semibold text-foreground">Link code</Text>
        {code.kind === 'loading' ? (
          <View className="items-start py-4">
            <ActivityIndicator color={c.muted} accessibilityLabel="Getting a code" />
          </View>
        ) : live ? (
          <View>
            <OneTimeCode code={code.code} left={code.deadline - now} />
            <View className="mt-4" style={{ gap: 8 }}>
              <Step n={1} text="On the other device, open Kalo." />
              <Step n={2} text="Tap “Already use Kalo? Link this device”." />
              <Step n={3} text="Enter this code. It works once, for ten minutes." />
            </View>
          </View>
        ) : (
          <View>
            <Text accessibilityLiveRegion="polite" className={`mt-2 text-[14px] leading-[20px] ${code.kind === 'error' ? 'text-bad' : 'text-muted'}`}>
              {code.kind === 'error'
                ? code.message
                : expired
                  ? 'That code has expired. Codes last ten minutes and work once.'
                  : 'Get a one-time code, then enter it on the other device.'}
            </Text>
            <Press
              accessibilityRole="button"
              accessibilityLabel={expired ? 'Get a new code' : code.kind === 'error' ? 'Try again' : 'Get code'}
              onPress={getCode}
              className="mt-4 h-[48px] items-center justify-center rounded-full bg-fab"
            >
              <Text className="text-[16px] font-semibold text-white">{expired ? 'Get a new code' : code.kind === 'error' ? 'Try again' : 'Get code'}</Text>
            </Press>
          </View>
        )}
      </Card>

      <SwitchBack />

      <Press accessibilityRole="button" accessibilityLabel="Link this device instead" onPress={onEnterInstead} className="items-center py-3">
        <Text className="text-center text-[14px] font-medium text-muted">Have a code from another device? Link this device instead</Text>
      </Press>
    </ScrollView>
  );
}

type LinkState = { kind: 'idle' } | { kind: 'confirm'; text: string } | { kind: 'linking' } | { kind: 'error'; message: string } | { kind: 'done' };

/** What linking does to an install that has data of its own: it stops opening this account. */
function replaceWarning(): string {
  const { entries } = ownData();
  const what = entries > 0 ? `This device's ${entries.toLocaleString()} ${entries === 1 ? 'entry belongs' : 'entries belong'}` : "This device's data belongs";
  return (
    `${what} to its own account. After linking, this device opens the other device's account instead. ` +
    "This account's data stays on the server, but no device will open it until you switch back here (Link another device → Switch back)."
  );
}

function EnterCode() {
  // A new install waiting on the first-run offer has no data of its own: nothing to warn about.
  const fresh = useLinkOffer();
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<LinkState>({ kind: 'idle' });
  const code = normaliseCode(typed);
  const busy = state.kind === 'linking';
  const canLink = code !== null && !busy;

  const link = async () => {
    if (!code) return;
    setState({ kind: 'linking' });
    try {
      // Not aborted when the screen closes: once the server has used the code, the token must be kept.
      await linkThisDevice(code);
      setState({ kind: 'done' });
      announce('Linked.');
    } catch (e) {
      const message = linkProblem(e, 'link');
      setState({ kind: 'error', message });
      announce(message);
    }
  };
  const submit = () => {
    if (!canLink) return;
    if (fresh || state.kind === 'confirm') void link();
    else setState({ kind: 'confirm', text: replaceWarning() });
  };

  if (state.kind === 'done') {
    return (
      <View className="px-4 pt-2">
        <Card className="p-5">
          <Text className="text-[17px] font-semibold text-foreground">Linked</Text>
          <Text accessibilityLiveRegion="polite" className="mt-2 text-[14px] leading-[20px] text-muted">
            This device now shares the other device&apos;s data. It is loading in the background and appears on Home as it arrives.
          </Text>
          <Press accessibilityRole="button" accessibilityLabel="Done" onPress={() => router.replace('/')} className="mt-4 h-[48px] items-center justify-center rounded-full bg-fab">
            <Text className="text-[16px] font-semibold text-white">Done</Text>
          </Press>
        </Card>
      </View>
    );
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 12 }}>
      <Card className="p-5">
        <Text className="text-[17px] font-semibold text-foreground">Enter the code from your other device</Text>
        <Text className="mt-2 text-[14px] leading-[20px] text-muted">On the device you already use Kalo on: Goals → Link another device → Get code.</Text>
        <View className="mt-4 h-14 justify-center rounded-tile border border-border bg-chip px-4">
          <TextInput
            accessibilityLabel="Link code"
            placeholder="XXXX-XXXX"
            placeholderTextColor={c.muted}
            value={typed}
            onChangeText={(t) => {
              setTyped(t.toUpperCase()); // as the code is shown (web ignores autoCapitalize)
              if (state.kind === 'error' || state.kind === 'confirm') setState({ kind: 'idle' });
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            maxLength={16}
            returnKeyType="go"
            onSubmitEditing={submit}
            editable={!busy}
            className="h-full text-[22px] font-semibold text-foreground"
            style={{ outlineStyle: 'none', letterSpacing: 2 } as object}
          />
        </View>
        {state.kind === 'error' ? (
          <Text accessibilityLiveRegion="polite" className="mt-3 text-[14px] leading-[20px] text-bad">
            {state.message}
          </Text>
        ) : null}
        {state.kind === 'confirm' ? (
          <View className="mt-3 rounded-tile bg-chip p-3">
            <Text className="text-[14px] leading-[20px] text-foreground">{state.text}</Text>
          </View>
        ) : null}
        <Press
          accessibilityRole="button"
          accessibilityLabel={state.kind === 'confirm' ? 'Replace and link' : 'Link'}
          accessibilityState={{ disabled: !canLink }}
          aria-disabled={!canLink}
          disabled={!canLink}
          onPress={submit}
          className={`mt-4 h-[48px] items-center justify-center rounded-full ${canLink ? (state.kind === 'confirm' ? 'bg-bad' : 'bg-fab') : 'bg-faint'}`}
        >
          {busy ? (
            <ActivityIndicator color={c.background} accessibilityLabel="Linking" />
          ) : (
            <Text className="text-[16px] font-semibold text-white">{state.kind === 'confirm' ? 'Replace and link' : 'Link'}</Text>
          )}
        </Press>
      </Card>
    </ScrollView>
  );
}

/** Shown when this install was linked away from an account: opens that account again (its token was kept). */
function SwitchBack() {
  const [shown, setShown] = useState(false);
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy' | 'done' | 'error'>('idle');
  useEffect(() => {
    let live = true;
    void hasPreviousAccount().then((has) => live && setShown(has));
    return () => {
      live = false;
    };
  }, []);
  if (!shown) return null;
  const go = async () => {
    setStep('busy');
    try {
      await switchToPreviousAccount();
      setStep('done');
      announce('Switched back.');
    } catch {
      setStep('error');
      announce("Couldn't switch back. Try again.");
    }
  };
  return (
    <Card className="p-5">
      <Text className="text-[17px] font-semibold text-foreground">Previous account</Text>
      <Text accessibilityLiveRegion="polite" className={`mt-2 text-[14px] leading-[20px] ${step === 'error' ? 'text-bad' : 'text-muted'}`}>
        {step === 'done'
          ? 'This device opens its previous account again. Its data is loading and appears on Home as it arrives.'
          : step === 'error'
            ? "Couldn't switch back. Try again."
            : step === 'confirm' || step === 'busy'
              ? "This device will open the account it had before it was linked. The data shown now is replaced by that account's (it stays on the server, and you can switch again here)."
              : 'This device was linked away from an account of its own. That account is still on the server.'}
      </Text>
      {step === 'done' ? null : (
        <Press
          accessibilityRole="button"
          accessibilityLabel={step === 'confirm' || step === 'busy' ? 'Confirm switch back' : 'Switch back to the previous account'}
          disabled={step === 'busy'}
          onPress={step === 'confirm' ? go : () => setStep('confirm')}
          className="mt-4 h-[44px] items-center justify-center rounded-full border border-foreground"
        >
          {step === 'busy' ? (
            <ActivityIndicator color={c.foreground} />
          ) : (
            <Text className="text-[15px] font-semibold text-foreground">{step === 'confirm' ? 'Switch back' : 'Switch back to the previous account'}</Text>
          )}
        </Press>
      )}
    </Card>
  );
}
