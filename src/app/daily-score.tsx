import { router } from 'expo-router';
import { ChevronRight, Info } from 'lucide-react-native';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

import { useDay } from '@/lib/data';
import { parseDay } from '@/lib/nutrition';
import { useSelectedDay } from '@/lib/selectedDay';
import { tokens } from '@/lib/tokens';

const c = tokens.colors;
// The sheet starts just below Home's header, which stays visible above it.
const HEADER = 88;

function ScoreRing({ value }: { value: number }) {
  const size = 83;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Defs>
          <LinearGradient id="g" x1="0" y1="1" x2="1" y2="0">
            <Stop offset="0" stopColor="#8FD9AE" />
            <Stop offset="1" stopColor={c.good} />
          </LinearGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.track} strokeWidth={stroke} fill="none" />
        {value > 0 ? <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="url(#g)"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(circ * value) / 100} ${circ}`}
        /> : null}
      </Svg>
      <Text className="text-[32px] font-semibold text-foreground">{value}</Text>
    </View>
  );
}

export default function DailyScore() {
  const insets = useSafeAreaInsets();
  const [day] = useSelectedDay();
  const { score } = useDay(day);
  const date = parseDay(day).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const top = insets.top + HEADER;

  return (
    <View className="flex-1">
      <Pressable accessibilityLabel="Close daily score" onPress={() => router.back()} className="absolute inset-x-0 bottom-0 bg-black/45" style={{ top }} />
      <View className="absolute inset-x-0 rounded-[26px] bg-card px-[27px] pt-[27px]" style={{ top }}>
        <View className="flex-row items-center justify-between">
          <View className="flex-1 pr-2">
            <Text className="text-[12.5px] text-muted">{date} • Daily Score</Text>
            <Text className="mt-[2px] text-[20px] font-bold tracking-tight text-foreground">{score.headline}</Text>
            <Text className="mt-[2px] text-[12px] text-muted" numberOfLines={2}>{score.tip}</Text>
          </View>
          <ScoreRing value={score.value} />
        </View>

        <View className="mt-[13px] border-t border-track pt-[11px]">
          {score.rows.map((r) => (
            <View key={r.key} className="h-[27px] flex-row items-center">
              <Text className="w-[56px] text-[12.5px] text-muted">{r.label}</Text>
              <View className="mx-[6px] h-[5px] flex-1 overflow-hidden rounded-full bg-track">
                <View
                  className={`h-full rounded-full ${r.onTrack ? 'bg-good' : 'bg-bad'}`}
                  style={{ width: `${Math.min(1, r.ratio) * 100}%` }}
                />
              </View>
              <Text className="w-[80px] text-right text-[12.5px] text-muted">
                {r.eaten}/{r.goal}
                {r.unit}
              </Text>
              <Text className="w-[64px] text-right text-[12.5px] text-muted">{r.onTrack ? 'On track' : 'Adjust'}</Text>
            </View>
          ))}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="How Daily Score Works"
          onPress={() => router.push('/score-info')}
          className="mt-[11px] flex-row items-center border-t border-track pb-[20px] pt-[17px]"
        >
          <Info size={16} color={c.muted} />
          <Text className="ml-[11px] flex-1 text-[12.5px] text-muted">How Daily Score Works</Text>
          <ChevronRight size={17} color={c.muted} />
        </Pressable>
      </View>
    </View>
  );
}
