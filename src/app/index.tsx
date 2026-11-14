import { Plus } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { ScrollView, type ScrollViewInstance, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown, FadeOut, LinearTransition } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { KaloLogo } from '@/components/KaloMark';
import { AddMenu } from '@/components/AddMenu';
import { BOTTOM_SPACE, Fab, fabBottom } from '@/components/Fab';
import { EntryCard } from '@/components/home/EntryCard';
import {
  BurnedCard,
  DayTypeCard,
  CalorieCard,
  Dots,
  HealthScoreCard,
  NutrientRow,
  ScorePill,
  StepsCard,
  StreakPill,
} from '@/components/home/HomeCards';
import { WeekStrip } from '@/components/home/WeekStrip';
import { setDayLog, useDay, useEntries } from '@/lib/data';
import { dayKcal, todayKey } from '@/lib/nutrition';
import { useSelectedDay } from '@/lib/selectedDay';

const PAGES = 3;

export default function Home() {
  const [day, setDay] = useSelectedDay();
  const d = useDay(day);
  const today = useDay(todayKey());
  const { remove } = useEntries();
  // The day type's share of the activity calories, and what the goal alone would add for it.
  const typeKcal = d.burned - d.stepsKcal;
  const goalTypeKcal = dayKcal(d.goals, { dayType: d.log.dayType });
  const typeLabel = d.log.dayType === 'active_rest' ? 'Active rest' : 'Workout';
  const { width } = useWindowDimensions();
  const pager = useRef<ScrollViewInstance>(null);
  const [page, setPage] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const insets = useSafeAreaInsets();

  const goTo = (i: number) => {
    pager.current?.scrollTo({ x: i * width, animated: true });
    setPage(i);
  };

  return (
    <View className="flex-1 bg-background">
      <SafeAreaView edges={['top']} className="flex-1">
        <ScrollView
          contentContainerStyle={{ paddingBottom: BOTTOM_SPACE }}
          showsVerticalScrollIndicator={false}
        >
          <View className="flex-row items-center justify-between px-[22px] pt-[22px]">
            <KaloLogo />
            <View className="flex-row items-center">
              <ScorePill score={d.score.value} />
              <StreakPill />
            </View>
          </View>

          <View className="mt-[15px] px-[14px]">
            <WeekStrip
              selected={day}
              onSelect={setDay}
              todayProgress={today.budget ? today.totals.calories / today.budget : 0}
            />
          </View>

          <ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            className="mt-[20px]"
            onScroll={(e) => {
              const i = Math.round(e.nativeEvent.contentOffset.x / width);
              if (i !== page) setPage(i);
            }}
            scrollEventThrottle={32}
          >
            <View style={{ width }} className="px-[24px]">
              <CalorieCard
                eaten={d.totals.calories}
                budget={d.budget}
                rollover={d.log.rollover}
                burned={d.burned}
              />
              <View className="mt-[10px]">
                <NutrientRow keys={['protein', 'carbs', 'fat']} totals={d.totals} goals={d.target} />
              </View>
            </View>
            <View style={{ width }} className="px-[24px]">
              <NutrientRow keys={['fiber', 'sugar', 'sodium']} totals={d.totals} goals={d.target} />
              <HealthScoreCard value={d.health.value} text={d.health.text} />
            </View>
            <View style={{ width }} className="px-[24px]">
              <View className="flex-row" style={{ gap: 10 }}>
                <StepsCard key={day} steps={d.log.steps} goal={d.goals.steps} onSteps={(steps) => setDayLog(day, { steps })} />
                <BurnedCard
                  total={d.burned}
                  steps={d.stepsKcal}
                  day={typeKcal !== 0 || d.log.workoutKcal != null ? { label: typeLabel, kcal: typeKcal } : null}
                />
              </View>
              <DayTypeCard
                key={day}
                dayType={d.log.dayType ?? null}
                workoutKcal={d.log.workoutKcal ?? null}
                goalKcal={goalTypeKcal}
                // Rest adds nothing, so it also clears the day's typed workout calories.
                onDayType={(dayType) => setDayLog(day, dayType === 'rest' ? { dayType, workoutKcal: null } : { dayType })}
                onWorkoutKcal={(workoutKcal) => setDayLog(day, { workoutKcal })}
              />
            </View>
          </ScrollView>

          <View className="mt-[17px]">
            <Dots count={PAGES} index={page} onSelect={goTo} />
          </View>

          <Text className="mt-[34px] px-[16px] text-[21px] font-semibold tracking-tight text-foreground">
            Recently uploaded
          </Text>
          <View className="mt-[26px] px-[24px]" style={{ gap: 18 }}>
            {d.entries.length === 0 ? (
              <View className="items-center rounded-2xl border border-border bg-entry px-6 py-8">
                <Text className="text-[17px] font-medium text-foreground">
                  You haven&apos;t uploaded any food
                </Text>
                <Text className="mt-1 text-center text-[14px] text-muted">
                  Tap + to log your first meal of the day.
                </Text>
              </View>
            ) : (
              d.entries.map((e) => (
                <Animated.View key={e.id} entering={FadeInDown.duration(260)} exiting={FadeOut.duration(160)} layout={LinearTransition.duration(220)}>
                  <EntryCard entry={e} onDelete={() => remove(e.id)} />
                </Animated.View>
              ))
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
      <View
        pointerEvents="box-none"
        className="absolute right-[18px]"
        style={{ bottom: fabBottom(insets.bottom) }}
      >
        <Fab label="Add" onPress={() => setMenuOpen(true)}>
          <Plus size={30} color="#fff" strokeWidth={2.2} />
        </Fab>
      </View>
      {menuOpen ? <AddMenu onClose={() => setMenuOpen(false)} /> : null}
    </View>
  );
}
