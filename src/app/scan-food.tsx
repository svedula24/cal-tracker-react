import { router } from 'expo-router';
import { ScanLine } from 'lucide-react-native';

import { PrimaryButton } from '@/components/logging/PrimaryButton';
import { ComingSoon, PushedScreen } from '@/components/Screen';
import { tokens } from '@/lib/tokens';

// Backend cut: photo recognition needs a camera + AI service.
export default function ScanFood() {
  return (
    <PushedScreen title="Scan food">
      <ComingSoon
        icon={<ScanLine size={34} color={tokens.colors.foreground} />}
        title="Scan food is coming soon"
        body="Photo recognition needs a camera and an AI service, which this offline version doesn't include. You can search the food database instead."
        action={<PrimaryButton label="Search food database" onPress={() => router.replace('/food-database')} />}
      />
    </PushedScreen>
  );
}
