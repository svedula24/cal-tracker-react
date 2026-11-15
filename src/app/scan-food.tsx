import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useIsFocused } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ScanLine, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Press } from '@/components/Press';
import { PrimaryButton } from '@/components/logging/PrimaryButton';
import { WebCamera } from '@/components/scan/WebCamera';
import { ComingSoon, goBack, PushedScreen } from '@/components/Screen';
import type { Food } from '@/data/foods';
import { isUpcE, lookupBarcode, upcEToUpcA } from '@/lib/barcodeApi';
import { API_URL } from '@/lib/config';
import { deviceToken } from '@/lib/sync';
import { tokens } from '@/lib/tokens';
import type { CameraProblem } from '@/lib/webBarcode';

// Scan a packaged food's barcode: the Kalo server looks it up in Open Food Facts, and Nutrition
// opens with the product (credited to Open Food Facts there), logged as a custom entry in grams on
// Done. Needs EXPO_PUBLIC_API_URL. Just the camera, full screen, scanning from the start: expo-camera
// on native; on web (the home-screen app) getUserMedia and ZXing (src/components/scan/WebCamera.web.tsx).
// Web without a usable camera (no camera API, permission denied, none found): the number is typed.

const BARCODE_TYPES: ('ean13' | 'ean8' | 'upc_a' | 'upc_e')[] = ['ean13', 'ean8', 'upc_a', 'upc_e'];
const LOOKUP_TIMEOUT_MS = 15_000;
const native = Platform.OS !== 'web';

type Phase =
  | { kind: 'idle' } // scanning, or waiting for a typed number
  | { kind: 'looking'; code: string }
  | { kind: 'found'; food: Food }
  | { kind: 'not_found'; code: string }
  | { kind: 'incomplete'; code: string; name: string | null }
  | { kind: 'invalid'; code: string }
  | { kind: 'no_token'; code: string }
  | { kind: 'unavailable'; code: string };

/** A barcode as typed or read: spaces and dashes dropped; null unless 8 to 14 digits are left. */
const barcode = (text: string): string | null => {
  const digits = text.replace(/[\s-]/g, '');
  return /^[0-9]{8,14}$/.test(digits) ? digits : null;
};

export default function ScanFood() {
  if (!API_URL) {
    return (
      <PushedScreen title="Scan barcode">
        <ComingSoon
          icon={<ScanLine size={34} color={tokens.colors.foreground} />}
          title="Barcode scanning needs the Kalo server"
          body="Barcodes are looked up through the Kalo server, which this build isn't connected to. You can search the food database instead."
          action={<PrimaryButton label="Search food database" onPress={() => router.replace('/food-database')} />}
        />
      </PushedScreen>
    );
  }
  return <Scanner baseUrl={API_URL} />;
}

/** The lookup shared by the camera and the typed number: one at a time, its result as a Phase. */
function useLookup(baseUrl: string) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Set the moment a code is read and cleared only by "Scan again": the camera reports a code many
  // times a second, and state would update too late to drop the repeats.
  const busy = useRef(false);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  const lookup = useCallback(
    async (code: string) => {
      if (inFlight.current) return; // one lookup at a time
      busy.current = true;
      const controller = new AbortController();
      inFlight.current = controller;
      const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
      setPhase({ kind: 'looking', code });
      let next: Phase;
      try {
        // This install's token, registering now if it has none (a new install holds off registering
        // while it offers to link to another device: scanning means it is used on its own). Null when
        // the server cannot be reached to register.
        const token = await deviceToken().catch(() => null);
        if (!token) {
          next = { kind: 'no_token', code };
        } else {
          const result = await lookupBarcode(baseUrl, code, { token, signal: controller.signal });
          next = result.kind === 'found' ? result : result.kind === 'incomplete' ? { ...result, code } : { kind: result.kind, code };
        }
      } catch {
        // Unreachable, an error status, an unreadable token store, or the timeout.
        next = { kind: 'unavailable', code };
      } finally {
        clearTimeout(timer);
        inFlight.current = null;
      }
      setPhase(next);
    },
    [baseUrl],
  );

  // Found: Nutrition takes this screen's place, and the success haptic fires a moment later. This
  // render takes the camera down, but it stops asynchronously, and iOS mutes haptics while it runs;
  // the timer outlives the screen, which is fine (it touches no state).
  useEffect(() => {
    if (phase.kind !== 'found') return;
    if (native) setTimeout(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}), 150);
    router.replace({ pathname: '/nutrition', params: { food: JSON.stringify(phase.food) } });
  }, [phase]);

  const scanAgain = useCallback(() => {
    busy.current = false;
    setPhase({ kind: 'idle' });
  }, []);

  return { phase, busy, lookup, scanAgain };
}

function Scanner({ baseUrl }: { baseUrl: string }) {
  const state = useLookup(baseUrl);
  return native ? <CameraScanner {...state} /> : <WebScanner {...state} />;
}

type LookupState = ReturnType<typeof useLookup>;

/** A code read by either camera, looked up unless one already is. */
function useOnScanned({ busy, lookup }: Pick<LookupState, 'busy' | 'lookup'>) {
  return useCallback(
    ({ type, data }: { type: string; data: string }) => {
      if (busy.current) return;
      // A UPC-E goes out as its UPC-A: the server would take its 8 digits for an EAN-8.
      const code = barcode(isUpcE(type) ? upcEToUpcA(data) : data);
      if (code) void lookup(code);
    },
    [busy, lookup],
  );
}

/** Why the web camera isn't used, above the typed field. */
const CAMERA_PROBLEMS: Record<CameraProblem, string> = {
  unsupported: "This browser can't use the camera here. Type the 8 to 14 digits under the barcode instead.",
  denied: 'Camera access is off for Kalo. Allow the camera for this site in your browser settings, or type the 8 to 14 digits under the barcode.',
  no_camera: 'No camera was found. Type the 8 to 14 digits under the barcode instead.',
  failed: "The camera couldn't start. Type the 8 to 14 digits under the barcode instead.",
};

/** Web: the camera as on native; the typed number only when there is no camera to use. */
function WebScanner(state: LookupState) {
  const focused = useIsFocused();
  const [camera, setCamera] = useState<'starting' | 'live' | CameraProblem>('starting');
  const onScanned = useOnScanned(state);
  if (camera !== 'starting' && camera !== 'live') {
    return (
      <TypedLookup {...state} note={CAMERA_PROBLEMS[camera]} onRetryCamera={camera === 'unsupported' ? undefined : () => setCamera('starting')} />
    );
  }
  const { phase } = state;
  return (
    <ScannerFrame {...state} spinner={camera === 'starting' ? 'starting' : phase.kind === 'looking' || phase.kind === 'found' ? 'looking' : null}>
      <WebCamera active={focused && phase.kind !== 'found'} scanning={phase.kind === 'idle'} onRead={onScanned} onState={setCamera} />
    </ScannerFrame>
  );
}

/** The camera edge to edge (`children`), a close button, a spinner, and a sheet over it when a
 *  result needs the user. Shared by the native and the web camera. */
function ScannerFrame({
  phase,
  lookup,
  scanAgain,
  spinner,
  children,
}: Pick<LookupState, 'phase' | 'lookup' | 'scanAgain'> & { spinner: 'starting' | 'looking' | null; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 overflow-hidden bg-black">
      {children}

      {/* Starting the camera, or looking a code up: a small spinner over the frame. */}
      {spinner ? (
        <View pointerEvents="none" className={`absolute inset-0 items-center justify-center ${spinner === 'looking' ? 'bg-black/30' : ''}`}>
          <View className="h-14 w-14 items-center justify-center rounded-full bg-black/50">
            <ActivityIndicator accessibilityLabel={spinner === 'looking' ? 'Looking up' : 'Starting the camera'} color="white" />
          </View>
        </View>
      ) : null}

      {phase.kind !== 'idle' && phase.kind !== 'looking' && phase.kind !== 'found' ? (
        <View className="absolute inset-x-0 bottom-0 rounded-t-card bg-card px-2 pt-6" style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}>
          <Result phase={phase} camera onRetry={(c) => void lookup(c)} onScanAgain={scanAgain} />
        </View>
      ) : null}

      <CloseButton dark />
    </View>
  );
}

function CloseButton({ dark }: { dark: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel="Close"
      onPress={goBack}
      hitSlop={8}
      className={`absolute left-4 h-10 w-10 items-center justify-center rounded-full ${dark ? 'bg-black/40' : 'bg-chip'}`}
      style={{ top: insets.top + 8 }}
    >
      <X size={22} color={dark ? 'white' : tokens.colors.foreground} />
    </Press>
  );
}

/** Native: expo-camera, after its permission. */
function CameraScanner(state: LookupState) {
  const { phase } = state;
  const focused = useIsFocused();
  const [permission, requestPermission, getPermission] = useCameraPermissions();

  // The hook reads the permission once: read it again when the user comes back from Settings.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') getPermission().catch(() => {});
    });
    return () => sub.remove();
  }, [getPermission]);

  const onScanned = useOnScanned(state);

  const granted = !!permission?.granted;
  // Only one camera preview may run: none while another screen covers this one. It stays up behind
  // a lookup and its result, and goes down on Found so the haptic is felt.
  const cameraOn = focused && granted && phase.kind !== 'found';
  if (permission && !granted) {
    return (
      <View className="flex-1 bg-background">
        {focused ? <StatusBar style="dark" /> : null}
        {permission.canAskAgain ? (
          <Message icon title="Allow camera access" body="Kalo uses the camera to read food barcodes. Nothing is recorded." fill>
            <SmallButton label="Allow camera" onPress={() => void requestPermission().catch(() => {})} primary />
          </Message>
        ) : (
          <Message icon title="Camera access is off" body="Turn on the camera for Kalo in Settings to scan barcodes." fill>
            <SmallButton label="Open settings" onPress={() => void Linking.openSettings().catch(() => {})} primary />
          </Message>
        )}
        <CloseButton dark={false} />
      </View>
    );
  }

  // Still asking for the permission (the spinner, undimmed), or looking a code up.
  const spinner = !permission ? 'starting' : phase.kind === 'looking' || phase.kind === 'found' ? 'looking' : null;
  return (
    <ScannerFrame {...state} spinner={spinner}>
      {focused ? <StatusBar style="light" /> : null}
      {cameraOn ? (
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
          onBarcodeScanned={phase.kind === 'idle' ? onScanned : undefined}
        />
      ) : null}
    </ScannerFrame>
  );
}

/** Web without a usable camera: the number under the barcode, typed, with the result below. */
function TypedLookup({
  phase,
  lookup,
  scanAgain,
  note,
  onRetryCamera,
}: LookupState & { note: string; onRetryCamera?: () => void }) {
  const [typed, setTyped] = useState('');
  const code = barcode(typed);
  const canLookUp = !!code && phase.kind !== 'looking';
  const lookUpTyped = () => {
    if (code && canLookUp) void lookup(code);
  };
  return (
    <PushedScreen title="Scan barcode">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: tokens.spacing.screenX, paddingBottom: 40 }}>
        <Text className="mb-2 mt-2 text-[15px] font-semibold text-foreground">Type the barcode</Text>
        <View className="flex-row items-center" style={{ gap: 10 }}>
          <View className="h-12 flex-1 justify-center rounded-full border border-border bg-chip px-4">
            <TextInput
              accessibilityLabel="Barcode number"
              placeholder="Digits under the barcode"
              placeholderTextColor={tokens.colors.muted}
              value={typed}
              onChangeText={setTyped}
              keyboardType="number-pad"
              maxLength={20}
              returnKeyType="search"
              onSubmitEditing={lookUpTyped}
              className="h-full text-[16px] text-foreground"
              style={{ outlineStyle: 'none' } as object}
            />
          </View>
          <Press
            accessibilityRole="button"
            accessibilityLabel="Look up"
            accessibilityState={{ disabled: !canLookUp }}
            disabled={!canLookUp}
            onPress={lookUpTyped}
            className={`h-12 items-center justify-center rounded-full px-5 ${canLookUp ? 'bg-foreground' : 'bg-faint'}`}
          >
            <Text className="text-[15px] font-semibold text-card">Look up</Text>
          </Press>
        </View>
        <Text className="mt-2 text-[13px] text-muted">{note}</Text>
        {onRetryCamera ? (
          <View className="mt-3 flex-row">
            <SmallButton label="Use the camera" onPress={onRetryCamera} />
          </View>
        ) : null}

        <View className="mt-8">
          {phase.kind === 'looking' || phase.kind === 'found' ? (
            <Message title={phase.kind === 'looking' ? `Looking up ${phase.code}…` : 'Found'}>
              <ActivityIndicator accessibilityLabel="Looking up" color={tokens.colors.muted} />
            </Message>
          ) : phase.kind !== 'idle' ? (
            <Result phase={phase} camera={false} onRetry={(c) => void lookup(c)} onScanAgain={scanAgain} />
          ) : null}
        </View>

        <Text className="mt-8 text-center text-[11px] text-faint">Product data from Open Food Facts (ODbL)</Text>
      </ScrollView>
    </PushedScreen>
  );
}

type ResultPhase = Exclude<Phase, { kind: 'idle' } | { kind: 'looking' } | { kind: 'found' }>;

/** A result that needs the user: what happened, and Scan again / Search food database / Try again. */
function Result({
  phase,
  camera,
  onRetry,
  onScanAgain,
}: {
  phase: ResultPhase;
  camera: boolean;
  onRetry: (code: string) => void;
  onScanAgain: () => void;
}) {
  const search = <SmallButton label="Search food database" onPress={() => router.replace('/food-database')} />;
  // Without a camera there is nothing to go back to: the field above takes another code.
  const again = camera ? <SmallButton label="Scan again" onPress={onScanAgain} primary /> : null;
  switch (phase.kind) {
    case 'not_found':
      return (
        <Message title="No product found" body={`Open Food Facts has no product with the barcode ${phase.code}.`}>
          {again}
          {search}
        </Message>
      );
    case 'incomplete':
      return (
        <Message
          title="No nutrition facts"
          body={`${phase.name ?? 'This product'} (${phase.code}) is in Open Food Facts without its calories, protein, carbs and fat.`}
        >
          {again}
          {search}
        </Message>
      );
    case 'invalid':
      return (
        <Message title="That barcode couldn't be read" body={`${phase.code} isn't a valid barcode.${camera ? ' Try scanning it again.' : ''}`}>
          {again}
        </Message>
      );
    case 'no_token':
      return (
        <Message title="Connecting to the Kalo server" body="Kalo is still signing in to the server. Try again in a moment.">
          <SmallButton label="Try again" onPress={() => onRetry(phase.code)} primary={!camera} />
          {again}
        </Message>
      );
    case 'unavailable':
      return (
        <Message title="Couldn't reach the Kalo server" body={`The lookup of ${phase.code} didn't go through. Check your connection and try again.`}>
          <SmallButton label="Try again" onPress={() => onRetry(phase.code)} primary={!camera} />
          {again}
        </Message>
      );
  }
}

function Message({
  title,
  body,
  icon = false,
  fill = false,
  children,
}: {
  title: string;
  body?: string;
  icon?: boolean;
  fill?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <View className={`items-center px-6 ${fill ? 'flex-1 justify-center' : ''}`}>
      {icon ? (
        <View className="mb-3 h-14 w-14 items-center justify-center rounded-full bg-chip">
          <ScanLine size={26} color={tokens.colors.foreground} />
        </View>
      ) : null}
      <Text className="text-center text-[18px] font-bold text-foreground">{title}</Text>
      {body ? <Text className="mt-1.5 text-center text-[14px] leading-[20px] text-muted">{body}</Text> : null}
      {children ? (
        <View className="mt-4 flex-row flex-wrap justify-center" style={{ gap: 10 }}>
          {children}
        </View>
      ) : null}
    </View>
  );
}

function SmallButton({ label, onPress, primary = false }: { label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={`rounded-full px-5 py-2.5 ${primary ? 'bg-foreground' : 'border border-border bg-card'}`}
    >
      <Text className={`text-[15px] font-semibold ${primary ? 'text-card' : 'text-foreground'}`}>{label}</Text>
    </Press>
  );
}
