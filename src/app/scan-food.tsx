import { CameraView, type PermissionResponse, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router, useIsFocused } from 'expo-router';
import { ScanLine } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Platform, ScrollView, Text, TextInput, View } from 'react-native';

import { Press } from '@/components/Press';
import { PrimaryButton } from '@/components/logging/PrimaryButton';
import { ComingSoon, PushedScreen } from '@/components/Screen';
import type { Food } from '@/data/foods';
import { isUpcE, lookupBarcode, upcEToUpcA } from '@/lib/barcodeApi';
import { API_URL } from '@/lib/config';
import { loadToken } from '@/lib/identity';
import { tokens } from '@/lib/tokens';

// Scan a packaged food's barcode (or type its number): the Kalo server looks it up in Open Food
// Facts, and Nutrition opens with the product, logged as a custom entry in grams on Done.
// Needs EXPO_PUBLIC_API_URL; the camera is native only (on web the number is typed).

const BARCODE_TYPES: ('ean13' | 'ean8' | 'upc_a' | 'upc_e')[] = ['ean13', 'ean8', 'upc_a', 'upc_e'];
const LOOKUP_TIMEOUT_MS = 15_000;
const native = Platform.OS !== 'web';

// The permission hook only where there is a camera to ask for: chosen once, so every render calls
// the same hook. Web never shows the camera.
const noCamera = () => Promise.reject<PermissionResponse>(new Error('No camera on web'));
const useWebPermission = (): [PermissionResponse | null, () => Promise<PermissionResponse>, () => Promise<PermissionResponse>] => [
  null,
  noCamera,
  noCamera,
];
const usePermission = native ? useCameraPermissions : useWebPermission;

type Phase =
  | { kind: 'idle' } // the camera (native) or the prompt to type a number (web)
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

function Scanner({ baseUrl }: { baseUrl: string }) {
  const focused = useIsFocused();
  const [permission, requestPermission, getPermission] = usePermission();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [typed, setTyped] = useState('');
  // Set the moment a code is read and cleared only by "Scan again": the camera reports a code many
  // times a second, and state would update too late to drop the repeats.
  const busy = useRef(false);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  // The hook reads the permission once: read it again when the user comes back from Settings.
  useEffect(() => {
    if (!native) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') getPermission().catch(() => {});
    });
    return () => sub.remove();
  }, [getPermission]);

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
        // The app registers with the server in the background (src/lib/sync); until then there is no token.
        const token = await loadToken();
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

  // Found: this render took the camera down, so the haptic is felt (iOS mutes haptics while the
  // camera runs); then Nutrition takes this screen's place.
  useEffect(() => {
    if (phase.kind !== 'found') return;
    if (native) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    router.replace({ pathname: '/nutrition', params: { food: JSON.stringify(phase.food) } });
  }, [phase]);

  const onScanned = useCallback(
    ({ type, data }: { type: string; data: string }) => {
      if (busy.current) return;
      // A UPC-E goes out as its UPC-A: the server would take its 8 digits for an EAN-8. Typed codes go as typed.
      const code = barcode(isUpcE(type) ? upcEToUpcA(data) : data);
      if (code) void lookup(code);
    },
    [lookup],
  );

  const scanAgain = () => {
    busy.current = false;
    setPhase({ kind: 'idle' });
  };

  const code = barcode(typed);
  const canLookUp = !!code && phase.kind !== 'looking';
  const lookUpTyped = () => {
    if (code && canLookUp) void lookup(code);
  };
  // Only one camera preview may run: none while another screen covers this one.
  const cameraOn = native && focused && phase.kind === 'idle' && !!permission?.granted;

  return (
    <PushedScreen title="Scan barcode">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ paddingHorizontal: tokens.spacing.screenX, paddingBottom: 40 }}
      >
        <View className="mt-2 h-[300px] overflow-hidden rounded-card bg-chip">
          {cameraOn ? (
            <>
              <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }} onBarcodeScanned={onScanned} />
              <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
                <View className="h-[120px] w-[240px] rounded-tile border-2 border-white/90" />
                <Text className="absolute bottom-4 text-[14px] font-medium text-white">Point the camera at a barcode</Text>
              </View>
            </>
          ) : (
            <Panel
              phase={phase}
              permission={permission}
              onAllow={() => void requestPermission().catch(() => {})}
              onRetry={(c) => void lookup(c)}
              onScanAgain={scanAgain}
            />
          )}
        </View>

        <Text className="mb-2 mt-6 text-[15px] font-semibold text-foreground">Type the barcode</Text>
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
        <Text className="mt-2 text-[13px] text-muted">For a code the camera can&apos;t read: the 8 to 14 digits under it.</Text>

        <Text className="mt-8 text-center text-[11px] text-faint">Product data from Open Food Facts (ODbL)</Text>
      </ScrollView>
    </PushedScreen>
  );
}

/** What the camera's place shows while the camera is off: permission, a lookup, or its result. */
function Panel({
  phase,
  permission,
  onAllow,
  onRetry,
  onScanAgain,
}: {
  phase: Phase;
  permission: PermissionResponse | null;
  onAllow: () => void;
  onRetry: (code: string) => void;
  onScanAgain: () => void;
}) {
  const search = <SmallButton label="Search food database" onPress={() => router.replace('/food-database')} />;
  // On web there is no camera to go back to: the field below takes another code.
  const again = native ? <SmallButton label="Scan again" onPress={onScanAgain} primary /> : null;
  switch (phase.kind) {
    case 'looking':
    case 'found':
      return (
        <Message title={phase.kind === 'looking' ? `Looking up ${phase.code}…` : 'Found'}>
          <ActivityIndicator accessibilityLabel="Looking up" color={tokens.colors.muted} />
        </Message>
      );
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
        <Message title="That barcode couldn't be read" body={`${phase.code} isn't a valid barcode. Try again or type it below.`}>
          {again}
        </Message>
      );
    case 'no_token':
      return (
        <Message title="Connecting to the Kalo server" body="Kalo is still signing in to the server. Try again in a moment.">
          <SmallButton label="Try again" onPress={() => onRetry(phase.code)} primary />
          {again}
        </Message>
      );
    case 'unavailable':
      return (
        <Message title="Couldn't reach the Kalo server" body={`The lookup of ${phase.code} didn't go through. Check your connection and try again.`}>
          <SmallButton label="Try again" onPress={() => onRetry(phase.code)} primary />
          {again}
        </Message>
      );
    case 'idle':
      if (!native) return <Message icon title="Type the number under the barcode" body="Scanning with the camera works in the Kalo app." />;
      if (!permission) {
        return (
          <Message title="Starting the camera…">
            <ActivityIndicator color={tokens.colors.muted} />
          </Message>
        );
      }
      // Granted, but another screen covers this one.
      if (permission.granted) return <Message icon title="Point the camera at a barcode" />;
      return permission.canAskAgain ? (
        <Message icon title="Allow camera access" body="Kalo uses the camera to read food barcodes. Nothing is recorded.">
          <SmallButton label="Allow camera" onPress={onAllow} primary />
        </Message>
      ) : (
        <Message icon title="Camera access is off" body="Turn on the camera for Kalo in Settings, or type the barcode below.">
          <SmallButton label="Open settings" onPress={() => void Linking.openSettings().catch(() => {})} primary />
        </Message>
      );
  }
}

function Message({ title, body, icon = false, children }: { title: string; body?: string; icon?: boolean; children?: React.ReactNode }) {
  return (
    <View className="flex-1 items-center justify-center px-6">
      {icon ? (
        <View className="mb-3 h-14 w-14 items-center justify-center rounded-full bg-card">
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
