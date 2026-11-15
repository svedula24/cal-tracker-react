import { Plus } from 'lucide-react-native';
import { memo, useDeferredValue, useRef, useState } from 'react';
import { Platform, ScrollView, type ScrollViewInstance, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown, FadeOut, LayoutAnimationConfig, LinearTransition } from 'react-native-reanimated';
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
import { TodayButton, WeekStrip, type WeekStripHandle } from '@/components/home/WeekStrip';
import { type Entry, setDayLog, useDay, useEntries } from '@/lib/data';
import { dayKcal, todayKey } from '@/lib/nutrition';
import { useSelectedDay } from '@/lib/selectedDay';

const PAGES = 3;
// Built once: a new builder per render makes Reanimated reconfigure every card on every render.
const ENTER = FadeInDown.duration(260);
const EXIT = FadeOut.duration(160);
const LAYOUT = LinearTransition.duration(220);

export default function Home() {
  const [day, setDay] = useSelectedDay();
  // A day tap commits the strip, the score and the first pager page at once; the other two pages
  // and the entries (`shown`) follow in a second, deferred commit right after. Until then they
  // keep showing the previous day, and their callbacks act on the day they show.
  const shown = useDeferredValue(day);
  const d = useDay(day);
  const today = useDay(todayKey());
  const { width } = useWindowDimensions();
  const pager = useRef<ScrollViewInstance>(null);
  const [page, setPage] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const strip = useRef<WeekStripHandle>(null);
  const [stripAway, setStripAway] = useState(false);
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
              {stripAway ? <TodayButton onPress={() => strip.current?.goToday()} /> : null}
              <ScorePill score={d.score.value} />
              <StreakPill />
            </View>
          </View>

          <View className="mt-[15px]">
            <WeekStrip
              ref={strip}
              onAwayChange={setStripAway}
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
            <MorePages day={shown} width={width} />
          </ScrollView>

          <View className="mt-[17px]">
            <Dots count={PAGES} index={page} onSelect={goTo} />
          </View>

          <Text className="mt-[34px] px-[16px] text-[21px] font-semibold tracking-tight text-foreground">
            Recently uploaded
          </Text>
          {/* Native skips the exit animations through LayoutAnimationConfig; web ignores that, so there the
              old day's cards drop them in the commit before the switch. */}
          <Entries day={shown} switching={Platform.OS === 'web' && shown !== day} />
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

/** Pager pages 2 (more nutrients, health score) and 3 (activity) for `day`. */
const MorePages = memo(function MorePages({ day, width }: { day: string; width: number }) {
  const d = useDay(day);
  // The day type's share of the activity calories, and what the goal alone would add for it.
  const typeKcal = d.burned - d.stepsKcal;
  const goalTypeKcal = dayKcal(d.goals, { dayType: d.log.dayType });
  const typeLabel = d.log.dayType === 'active_rest' ? 'Active rest' : 'Workout';
  return (
    <>
      <View style={{ width }} className="px-[24px]">
        <NutrientRow keys={['fiber', 'sugar', 'sodium']} totals={d.totals} goals={d.target} />
        <HealthScoreCard value={d.health.value} text={d.health.text} />
      </View>
      <View style={{ width }} className="px-[24px]">
        <View className="flex-row" style={{ gap: 10 }}>
          <StepsCard day={day} steps={d.log.steps} goal={d.goals.steps} onSteps={(steps) => setDayLog(day, { steps })} />
          <BurnedCard
            total={d.burned}
            steps={d.stepsKcal}
            day={typeKcal !== 0 || d.log.workoutKcal != null ? { label: typeLabel, kcal: typeKcal } : null}
          />
        </View>
        <DayTypeCard
          day={day}
          dayType={d.log.dayType ?? null}
          workoutKcal={d.log.workoutKcal ?? null}
          goalKcal={goalTypeKcal}
          // Rest adds nothing, so it also clears the day's typed workout calories.
          onDayType={(dayType) => setDayLog(day, dayType === 'rest' ? { dayType, workoutKcal: null } : { dayType })}
          onWorkoutKcal={(workoutKcal) => setDayLog(day, { workoutKcal })}
        />
      </View>
    </>
  );
});

/**
 * "Recently uploaded" for `day`. Adding or deleting a meal animates; switching days does not: the
 * new day's cards mount under a fresh LayoutAnimationConfig that skips entering and exiting. On web,
 * which ignores skipExiting, the commit before the switch (`switching`) also takes the exit and
 * layout animations off the old day's cards; native skips that extra render. Home's first mount still
 * animates its cards in.
 */
const Entries = memo(function Entries({ day, switching }: { day: string; switching: boolean }) {
  const { entries } = useDay(day);
  const { remove } = useEntries();
  const [prevDay, setPrevDay] = useState(day);
  const [switched, setSwitched] = useState(false);
  if (day !== prevDay) {
    setPrevDay(day);
    setSwitched(true);
  }
  return (
    <LayoutAnimationConfig key={day} skipEntering={switched} skipExiting>
      <View className="mt-[26px] px-[24px]" style={{ gap: 18 }}>
        {entries.length === 0 ? (
          <View className="items-center rounded-2xl border border-border bg-entry px-6 py-8">
            <Text className="text-[17px] font-medium text-foreground">
              You haven&apos;t uploaded any food
            </Text>
            <Text className="mt-1 text-center text-[14px] text-muted">
              Tap + to log your first meal of the day.
            </Text>
          </View>
        ) : (
          entries.map((e) => <EntryItem key={e.id} entry={e} animate={!switching} onDelete={remove} />)
        )}
      </View>
    </LayoutAnimationConfig>
  );
});

function EntryItem({ entry, animate, onDelete }: { entry: Entry; animate: boolean; onDelete: (id: string) => void }) {
  return (
    <Animated.View entering={ENTER} exiting={animate ? EXIT : undefined} layout={animate ? LAYOUT : undefined}>
      <EntryCard entry={entry} onDelete={() => onDelete(entry.id)} />
    </Animated.View>
  );
}
