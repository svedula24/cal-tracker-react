import * as Clipboard from 'expo-clipboard';
import { Check, Copy, MessageSquare } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, AppState, Platform, ScrollView, Text, View } from 'react-native';

import { Press } from '@/components/Press';
import { Card, PushedScreen } from '@/components/Screen';
import { API_URL } from '@/lib/config';
import { codeDeadline, type Connection, createPairingCode, disconnect, formatCountdown, listConnections, type ProblemContext, problemMessage } from '@/lib/connectionsApi';
import { isDemoGoal, useGoals } from '@/lib/data';
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

type CodeState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'code'; code: string; deadline: number };

type ListState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; connections: Connection[] };

/**
 * Connect ChatGPT: a one-time code to type into Kalo's sign-in page in ChatGPT (web), and the
 * connections the user has made, each with Disconnect. Opened from Goals; needs the API.
 */
export default function ConnectChatGPTScreen() {
  return (
    <PushedScreen title="Connect ChatGPT">
      {API_URL ? (
        <Connect />
      ) : (
        <View className="px-5 pt-4">
          <Text className="text-[15px] text-muted">This build has no server, so ChatGPT cannot reach your data.</Text>
        </View>
      )}
    </PushedScreen>
  );
}

function Connect() {
  const url = API_URL!;
  const { goals, ready } = useGoals();
  const [code, setCode] = useState<CodeState>({ kind: 'idle' });
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [now, setNow] = useState(() => Date.now());
  // Every request is aborted when the screen closes, so nothing updates an unmounted screen.
  const life = useRef<AbortController>(null!); // set by the effect below, before any handler runs
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);

  // Only the newest load may set the list: an older one answering last (say, started before a
  // Disconnect) would bring back a row that was just removed.
  const loads = useRef(0);
  const loadList = useCallback(async () => {
    const { signal } = life.current;
    const n = ++loads.current;
    const current = () => !signal.aborted && n === loads.current;
    try {
      const token = await deviceToken();
      const connections = await listConnections(url, token, { signal });
      if (current()) setList({ kind: 'ready', connections });
    } catch (e) {
      if (current()) setList({ kind: 'error', message: failed(e, 'list') });
    }
  }, [url]);

  // On open, and on coming back to the app (from ChatGPT, where the user just connected).
  useEffect(() => {
    void loadList();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void loadList();
    });
    return () => sub.remove();
  }, [loadList]);

  const getCode = async () => {
    const { signal } = life.current;
    setCode({ kind: 'loading' });
    try {
      const token = await deviceToken();
      const got = await createPairingCode(url, token, { signal });
      if (signal.aborted) return;
      const at = Date.now();
      setNow(at);
      setCode({ kind: 'code', code: got.code, deadline: codeDeadline(got.expiresAt, at) });
    } catch (e) {
      if (signal.aborted) return;
      const message = failed(e, 'code');
      setCode({ kind: 'error', message });
      announce(message);
    }
  };

  // The countdown ticks while a live code is shown.
  const live = code.kind === 'code' && now < code.deadline;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const remove = async (id: string) => {
    const { signal } = life.current;
    const token = await deviceToken();
    await disconnect(url, token, id, { signal });
    if (signal.aborted) return;
    loads.current++; // a list load already under way answers from before the Disconnect
    setList((l) => (l.kind === 'ready' ? { kind: 'ready', connections: l.connections.filter((x) => x.id !== id) } : l));
  };

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 12 }}>
      <Card className="p-5">
        <View className="flex-row items-center">
          <MessageSquare size={18} color={c.foreground} />
          <Text className="ml-2 text-[17px] font-semibold text-foreground">Use Kalo from ChatGPT</Text>
        </View>
        <Text className="mt-2 text-[14px] leading-[20px] text-muted">
          Ask ChatGPT what you have eaten, or have it log food and change your goals. It works in ChatGPT on the web (chatgpt.com), not in the
          ChatGPT iPhone app.
        </Text>
        {ready && isDemoGoal(goals) ? (
          <View testID="demo-goals-note" className="mt-3 rounded-tile bg-chip p-3">
            <Text className="text-[13.5px] leading-[19px] text-foreground">
              Your goals are still the demo ones ({goals.calories.toLocaleString()} cal). ChatGPT will see them until you set your own on the Goals
              screen.
            </Text>
          </View>
        ) : null}
      </Card>

      <Card className="p-5">
        <Text className="text-[17px] font-semibold text-foreground">Connection code</Text>
        <CodePanel state={code} now={now} onGet={getCode} />
      </Card>

      <Card className="px-5 pb-2 pt-5">
        <Text className="text-[17px] font-semibold text-foreground">Connected</Text>
        {list.kind === 'loading' ? (
          <View className="items-start py-4">
            <ActivityIndicator color={c.muted} accessibilityLabel="Loading connections" />
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
        ) : list.connections.length === 0 ? (
          <Text className="py-3 text-[14px] text-muted">Nothing is connected yet.</Text>
        ) : (
          list.connections.map((conn, i) => <ConnectionRow key={conn.id} connection={conn} first={i === 0} onDisconnect={() => remove(conn.id)} />)
        )}
      </Card>
    </ScrollView>
  );
}

function CodePanel({ state, now, onGet }: { state: CodeState; now: number; onGet: () => void }) {
  if (state.kind === 'loading') {
    return (
      <View className="items-start py-4">
        <ActivityIndicator color={c.muted} accessibilityLabel="Getting a code" />
      </View>
    );
  }
  if (state.kind === 'code' && now < state.deadline) return <LiveCode code={state.code} left={state.deadline - now} />;

  const expired = state.kind === 'code';
  return (
    <View>
      <Text accessibilityLiveRegion="polite" className={`mt-2 text-[14px] leading-[20px] ${state.kind === 'error' ? 'text-bad' : 'text-muted'}`}>
        {state.kind === 'error'
          ? state.message
          : expired
            ? 'That code has expired. Codes last ten minutes and work once.'
            : 'Get a one-time code, then enter it when ChatGPT asks you to sign in to Kalo.'}
      </Text>
      <Press
        accessibilityRole="button"
        accessibilityLabel={expired ? 'Get a new code' : state.kind === 'error' ? 'Try again' : 'Get code'}
        onPress={onGet}
        className="mt-4 h-[48px] items-center justify-center rounded-full bg-fab"
      >
        <Text className="text-[16px] font-semibold text-white">{expired ? 'Get a new code' : state.kind === 'error' ? 'Try again' : 'Get code'}</Text>
      </Press>
    </View>
  );
}

function LiveCode({ code, left }: { code: string; left: number }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = async () => {
    // On web the browser may refuse (it resolves false); native always copies.
    const ok = await Clipboard.setStringAsync(code).catch(() => false);
    setCopied(ok);
    announce(ok ? 'Copied.' : "Couldn't copy: select the code instead.");
  };
  const countdown = formatCountdown(left);
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
      <Text className={`${copied === null ? 'mt-2' : 'mt-[2px]'} text-[13px] text-muted`}>Expires in {countdown}</Text>
      <View className="mt-4" style={{ gap: 8 }}>
        <Step n={1} text="In ChatGPT on the web: Settings → Apps & Connectors → add Kalo." />
        <Step n={2} text="Enter this code when Kalo asks you to sign in." />
        <Step n={3} text="Leave “also log, edit and delete” checked to let ChatGPT make changes, or clear it for read only." />
      </View>
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

function ConnectionRow({ connection, first, onDisconnect }: { connection: Connection; first: boolean; onDisconnect: () => Promise<void> }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const name = connection.clientName || 'Unnamed app';
  const writes = connection.scopes.includes('nutrition:write');
  const confirm = async () => {
    setStep('busy');
    try {
      await onDisconnect();
    } catch (e) {
      const text = failed(e, 'disconnect');
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
            {writes ? 'Can read, log and change' : 'Read only'} · since {day(connection.createdAt)}
            {connection.lastUsedAt ? ` · last used ${day(connection.lastUsedAt)}` : ''}
          </Text>
        </View>
        {step === 'idle' || step === 'error' ? (
          <Press accessibilityRole="button" accessibilityLabel={`Disconnect ${name}`} onPress={() => setStep('confirm')} className="h-[34px] items-center justify-center rounded-full border border-border px-3">
            <Text className="text-[14px] font-medium text-bad">Disconnect</Text>
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
          <Text className="text-[14px] leading-[20px] text-foreground">{name} will lose access to your Kalo data. You can connect again with a new code.</Text>
          <View className="mt-3 flex-row" style={{ gap: 8 }}>
            <Press accessibilityRole="button" accessibilityLabel="Cancel" disabled={step === 'busy'} onPress={() => setStep('idle')} className="h-[38px] flex-1 items-center justify-center rounded-full border border-border bg-card">
              <Text className="text-[14px] font-medium text-foreground">Cancel</Text>
            </Press>
            <Press accessibilityRole="button" accessibilityLabel={`Confirm disconnect ${name}`} disabled={step === 'busy'} onPress={confirm} className="h-[38px] flex-1 items-center justify-center rounded-full bg-bad">
              {step === 'busy' ? <ActivityIndicator color={c.background} /> : <Text className="text-[14px] font-semibold text-white">Disconnect</Text>}
            </Press>
          </View>
        </View>
      ) : null}
    </View>
  );
}
