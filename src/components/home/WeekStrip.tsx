import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type AccessibilityActionEvent, FlatList, type FlatListInstance, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { Press } from '@/components/Press';
import { cardShadow } from '@/components/Screen';
import { Ring } from '@/components/Ring';
import { useDayBudgets, useEntries } from '@/lib/data';
import { caloriesByDay, dayStatus, parseDay, stripPage, stripPageOf, todayKey } from '@/lib/nutrition';
import { tokens } from '@/lib/tokens';

const SIZE = 35;
/** This week and the 52 before it; more when entries go further back (up to ten years). */
const MIN_PAGES = 53;
const MAX_PAGES = 52 * 10 + 1;
/** Room for the active day's shadow inside the scroll view, which clips its content. */
const SHADOW_ROOM = 14;

export type WeekStripHandle = { goToday: () => void };

type Props = {
  ref?: Ref<WeekStripHandle>;
  selected: string;
  onSelect: (key: string) => void;
  todayProgress: number;
  /** True while the strip is scrolled off the first page or the selected day is not on it. */
  onAwayChange?: (away: boolean) => void;
};

/**
 * The day strip, in pages of 7 days that snap one at a time. Page 0 (where it starts) is five
 * days back, today and tomorrow; swiping right goes back a week at a time. Past rings: green on
 * goal, red off goal (the goal that day), dashed when nothing was logged.
 */
export function WeekStrip({ ref, selected, onSelect, todayProgress, onAwayChange }: Props) {
  const entries = useEntries().items;
  const kcal = useMemo(() => caloriesByDay(entries), [entries]);
  const tKey = todayKey();
  const today = useMemo(() => parseDay(tKey), [tKey]);

  const pages = useMemo(() => {
    let oldest = 0;
    for (const k of kcal.keys()) {
      const p = stripPageOf(k, today);
      if (Number.isFinite(p) && p > oldest) oldest = p;
    }
    return Math.min(MAX_PAGES, Math.max(MIN_PAGES, oldest + 1));
  }, [kcal, today]);
  // Oldest page first, so swiping right goes back in time; the list starts at its end.
  const data = useMemo(() => Array.from({ length: pages }, (_, i) => pages - 1 - i), [pages]);

  const windowWidth = useWindowDimensions().width;
  const [width, setWidth] = useState(windowWidth);
  const list = useRef<FlatListInstance>(null);
  const [page, setPage] = useState(() => Math.min(stripPageOf(selected, today), pages - 1));
  const pageRef = useRef(page);
  const show = (p: number) => {
    pageRef.current = p;
    setPage(p);
  };
  const scrollTo = (p: number, animated: boolean) => {
    const target = Math.max(0, Math.min(pages - 1, p));
    list.current?.scrollToOffset({ offset: (pages - 1 - target) * width, animated });
    show(target);
  };

  // Keep the shown page in place when the width or the page count changes (and on mount).
  useLayoutEffect(() => {
    list.current?.scrollToOffset({ offset: (pages - 1 - pageRef.current) * width, animated: false });
  }, [width, pages]);

  // A day selected from elsewhere (midnight rollover, Today) brings its page into view. Only a
  // change of the selected day moves the strip: the user's own scrolling must not snap back.
  const selectedPage = Math.min(stripPageOf(selected, today), pages - 1);
  useEffect(() => {
    if (selectedPage !== pageRef.current) scrollTo(selectedPage, true);
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const away = page !== 0 || selectedPage !== 0;
  useEffect(() => onAwayChange?.(away), [away, onAwayChange]);

  useImperativeHandle(ref, () => ({
    goToday: () => {
      onSelect(tKey);
      scrollTo(0, true);
    },
  }));

  // Screen readers: each day offers "Previous week" / "Next week" instead of a swipe.
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'previousWeek') scrollTo(pageRef.current + 1, true);
    else if (e.nativeEvent.actionName === 'nextWeek') scrollTo(pageRef.current - 1, true);
  };

  const extra = useMemo(() => ({ selected, todayProgress, width, pages, kcal }), [selected, todayProgress, width, pages, kcal]);

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ marginVertical: -SHADOW_ROOM }}>
      <FlatList
        ref={list}
        testID="day-strip"
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        data={data}
        // Everything the pages draw from: a new value re-renders the mounted pages (FlatList otherwise
        // keeps them as they are). `kcal` is new whenever an entry changes, so past rings follow edits.
        extraData={extra}
        keyExtractor={(p) => String(p)}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        initialScrollIndex={pages - 1 - page}
        initialNumToRender={1}
        maxToRenderPerBatch={2}
        windowSize={3}
        onScroll={(e) => {
          const p = pages - 1 - Math.round(e.nativeEvent.contentOffset.x / width);
          if (p !== pageRef.current && p >= 0 && p < pages) show(p);
        }}
        scrollEventThrottle={32}
        renderItem={({ item }) => (
          <StripPage
            page={item}
            today={today}
            width={width}
            kcal={kcal}
            selected={selected}
            onSelect={onSelect}
            todayProgress={todayProgress}
            isOldest={item === pages - 1}
            onAction={onAction}
          />
        )}
      />
    </View>
  );
}

type PageProps = {
  page: number;
  today: Date;
  width: number;
  kcal: Map<string, number>;
  selected: string;
  onSelect: (key: string) => void;
  todayProgress: number;
  isOldest: boolean;
  onAction: (e: AccessibilityActionEvent) => void;
};

function StripPage({ page, today, width, kcal, selected, onSelect, todayProgress, isOldest, onAction }: PageProps) {
  const days = useMemo(() => stripPage(page, today), [page, today]);
  // Each day is judged against the goal in force on that day; only the rendered pages ask.
  const budgets = useDayBudgets(days.map((d) => d.key));
  const actions = [
    ...(isOldest ? [] : [{ name: 'previousWeek', label: 'Previous week' }]),
    ...(page > 0 ? [{ name: 'nextWeek', label: 'Next week' }] : []),
  ];
  return (
    <View style={{ width, paddingVertical: SHADOW_ROOM }} className="flex-row justify-between px-[22px]">
      {days.map((d) => {
        const active = d.key === selected;
        const status = dayStatus(kcal.get(d.key) ?? 0, budgets[d.key]);
        return (
          <Press
            key={d.key}
            disabled={d.isFuture}
            accessibilityRole="button"
            accessibilityLabel={`${d.label} ${d.day}`}
            accessibilityState={{ selected: active, disabled: d.isFuture }}
            accessibilityActions={actions}
            onAccessibilityAction={onAction}
            onPress={() => onSelect(d.key)}
            className={`w-[49px] items-center rounded-[15px] pb-[7px] pt-[9px] ${active ? 'bg-card' : ''}`}
            style={active ? cardShadow : undefined}
          >
            <Text className={`mb-[6px] text-[12.5px] ${d.isFuture ? 'text-faint' : active ? 'font-medium text-foreground' : 'text-muted'}`}>
              {d.label}
            </Text>
            {d.isToday ? (
              <Ring size={SIZE} stroke={1.8} progress={todayProgress} color={tokens.colors.foreground}>
                <Text className="text-[15px] text-foreground">{d.day}</Text>
              </Ring>
            ) : (
              <View style={{ width: SIZE, height: SIZE }} className="items-center justify-center">
                <Svg width={SIZE} height={SIZE} style={{ position: 'absolute' }}>
                  <Circle
                    cx={SIZE / 2}
                    cy={SIZE / 2}
                    r={SIZE / 2 - 1}
                    fill="none"
                    strokeWidth={1.8}
                    stroke={d.isFuture || status === 'none' ? tokens.colors.track : status === 'good' ? tokens.colors.good : tokens.colors.bad}
                    strokeDasharray={!d.isFuture && status === 'none' ? '3 3' : undefined}
                  />
                </Svg>
                <Text className={`text-[15px] ${d.isFuture ? 'text-faint' : 'text-foreground'}`}>{d.day}</Text>
              </View>
            )}
          </Press>
        );
      })}
    </View>
  );
}

/** On Home's top bar while the strip is away from today: back to the first page, today selected. */
export function TodayButton({ onPress }: { onPress: () => void }) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel="Today"
      onPress={onPress}
      className="mr-2 h-[33px] flex-row items-center rounded-full bg-card px-[13px]"
      style={cardShadow}
    >
      <Text className="text-[15px] font-semibold text-foreground">Today</Text>
    </Press>
  );
}
