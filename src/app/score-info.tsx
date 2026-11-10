import { ScrollView, Text, View } from 'react-native';

import { Card, PushedScreen } from '@/components/Screen';

// Mirrors dailyScore() in src/lib/nutrition.ts — keep the numbers in sync.
const WEIGHTS = [
  { label: 'Calories', weight: 30, dot: 'bg-foreground' },
  { label: 'Protein', weight: 30, dot: 'bg-protein' },
  { label: 'Carbs', weight: 20, dot: 'bg-carbs' },
  { label: 'Fat', weight: 20, dot: 'bg-fat' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <Text className="mb-2 text-[17px] font-semibold text-foreground">{title}</Text>
      {children}
    </Card>
  );
}

const P = ({ children }: { children: React.ReactNode }) => (
  <Text className="text-[15px] leading-[22px] text-muted">{children}</Text>
);

export default function ScoreInfo() {
  return (
    <PushedScreen title="How Daily Score Works">
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 40, gap: 12 }}>
        <Section title="A score from 0 to 100">
          <P>
            Your Daily Score shows how balanced your day is. It combines four parts — calories, protein, carbs and fat —
            each scored out of 100, then weighted and added together.
          </P>
          <View className="mt-4 gap-3">
            {WEIGHTS.map((w) => (
              <View key={w.label} className="flex-row items-center" accessibilityLabel={`${w.label} ${w.weight} percent`}>
                <View className={`h-2.5 w-2.5 rounded-full ${w.dot}`} />
                <Text className="ml-3 flex-1 text-[16px] text-foreground">{w.label}</Text>
                <Text className="text-[16px] font-bold text-foreground">{w.weight}%</Text>
              </View>
            ))}
          </View>
        </Section>

        <Section title="On track">
          <P>
            Each part is On track when you've eaten between 70% and 115% of its goal. Anywhere inside that band earns the
            full 100 points for that part.
          </P>
        </Section>

        <Section title="Outside the band">
          <P>
            Points drop the further you are outside the band: each part loses 7.5 points for every percent below 70% or
            above 115% of its goal, down to zero.
          </P>
        </Section>

        <Section title="Your calorie goal">
          <P>
            The calories goal used for the score is your daily goal plus any rollover calories plus the calories you've
            burned from steps.
          </P>
        </Section>

        <Section title="Reading your score">
          <P>85 and above is Great balance, 70 to 84 is Good progress, and below 70 Needs attention.</P>
        </Section>
      </ScrollView>
    </PushedScreen>
  );
}
