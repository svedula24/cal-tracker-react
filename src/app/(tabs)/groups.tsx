import { Users } from 'lucide-react-native';

import { ComingSoon, TabScreen } from '@/components/Screen';
import { tokens } from '@/lib/tokens';

export default function Groups() {
  return (
    <TabScreen title="Groups">
      <ComingSoon
        icon={<Users size={34} color={tokens.colors.foreground} />}
        title="Groups are coming soon"
        body="Sharing progress with friends needs an online account, which this offline version doesn't include."
      />
    </TabScreen>
  );
}
