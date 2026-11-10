import { router } from 'expo-router';
import {
  ChevronsUpDown,
  Droplet,
  Drumstick,
  Flame,
  Footprints,
  GlassWater,
  Apple,
  History,
  Candy,
  PersonStanding,
  Soup,
  Target,
  Wheat,
} from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Ring } from '@/components/Ring';
import { Card, cardShadow } from '@/components/Screen';
import { STREAK_DAYS } from '@/lib/data';
import type { Nutrients } from '@/lib/nutrition';
import { tokens } from '@/lib/tokens';

const c = tokens.colors;

// ── Header pills ─────────────────────────────────────────────────────────────
export function ScorePill({ score }: { score: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Daily score ${score}`}
      onPress={() => router.push('/daily-score')}
      className="h-[33px] flex-row items-center rounded-full border-[2px] border-good bg-card px-[11px]"
    >
      <Target size={19} color={c.foreground} strokeWidth={2.2} />
      <Text className="ml-[7px] text-[18px] font-semibold text-foreground">{score}</Text>
    </Pressable>
  );
}

export function StreakPill() {
  return (
    <View
      accessibilityLabel={`${STREAK_DAYS} day streak`}
      className="ml-2 h-[33px] flex-row items-center rounded-full bg-card px-[13px]"
      style={cardShadow}
    >
      <Flame size={19} color="#F59E2D" fill="#F7A33A" />
      <Text className="ml-[6px] text-[18px] font-semibold text-foreground">{STREAK_DAYS}</Text>
    </View>
  );
}

// ── Page 1: calories + macros ────────────────────────────────────────────────
export function CalorieCard({ eaten, budget, rollover, burned }: { eaten: number; budget: number; rollover: number; burned: number }) {
  const [showLeft, setShowLeft] = useState(false);
  const value = showLeft ? Math.max(0, budget - eaten) : eaten;
  return (
    <Card className="h-[148px] flex-row items-center justify-between pl-[30px] pr-[24px]">
      <View>
        <View className="flex-row items-end">
          <Text className="text-[39px] font-bold tracking-tight text-foreground" style={{ lineHeight: 44 }}>
            {value}
          </Text>
          {showLeft ? null : <Text className="mb-[5px] ml-[2px] text-[15px] text-muted">/{budget}</Text>}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showLeft ? 'Show calories eaten' : 'Show calories left'}
          onPress={() => setShowLeft((v) => !v)}
          className="mt-[1px] flex-row items-center"
        >
          <Text className="text-[12.5px] text-muted">{showLeft ? 'Calories left' : 'Calories eaten'}</Text>
          <ChevronsUpDown size={12} color={c.muted} style={{ marginLeft: 3 }} />
        </Pressable>
        <View className="mt-[9px] flex-row">
          {rollover > 0 ? <Chip icon={<History size={11} color={c.foreground} strokeWidth={2.4} />} text={`+${rollover}`} label="Rollover calories" /> : null}
          {burned > 0 ? <Chip icon={<Footprints size={11} color={c.muted} strokeWidth={2.4} />} text={`+${burned}`} label="Calories burned added" /> : null}
        </View>
      </View>
      <Ring size={107} stroke={7.5} progress={budget ? eaten / budget : 0} color={c.foreground}>
        <Flame size={20} color={c.foreground} fill={c.foreground} />
      </Ring>
    </Card>
  );
}

function Chip({ icon, text, label }: { icon: React.ReactNode; text: string; label: string }) {
  return (
    <View accessibilityLabel={label} className="mr-[7px] h-[20px] flex-row items-center rounded-full bg-chip px-[7px]">
      {icon}
      <Text className="ml-[4px] text-[11.5px] font-semibold text-foreground">{text}</Text>
    </View>
  );
}

const NUTRIENT_META = {
  protein: { label: 'Protein eaten', unit: 'g', color: c.protein, Icon: Drumstick },
  carbs: { label: 'Carbs eaten', unit: 'g', color: c.carbs, Icon: Wheat },
  fat: { label: 'Fat eaten', unit: 'g', color: c.fat, Icon: Droplet },
  fiber: { label: 'Fiber eaten', unit: 'g', color: c.fiber, Icon: Apple },
  sugar: { label: 'Sugar eaten', unit: 'g', color: c.sugar, Icon: Candy },
  sodium: { label: 'Sodium eaten', unit: 'mg', color: c.sodium, Icon: Soup },
} as const;

export type NutrientKey = keyof typeof NUTRIENT_META;

export function NutrientCard({ k, eaten, goal }: { k: NutrientKey; eaten: number; goal: number }) {
  const m = NUTRIENT_META[k];
  return (
    <Card className="h-[143px] flex-1 px-[12px] pt-[12px]">
      <View className="flex-row items-end">
        <Text className={`${String(eaten).length >= 4 ? 'text-[15px]' : 'text-[16.5px]'} font-semibold text-foreground`}>{eaten}</Text>
        <Text className="mb-[2px] ml-[1px] text-[10px] text-muted" numberOfLines={1}>
          /{goal}
          {m.unit}
        </Text>
      </View>
      <Text className="mt-[1px] text-[12.5px] text-muted" numberOfLines={1}>{m.label}</Text>
      <View className="mt-[17px] items-center">
        <Ring size={66} stroke={5.5} progress={goal ? eaten / goal : 0} color={m.color}>
          <m.Icon size={17} color={m.color} fill={m.color} />
        </Ring>
      </View>
    </Card>
  );
}

export function NutrientRow({ keys, totals, goals }: { keys: NutrientKey[]; totals: Nutrients; goals: Nutrients }) {
  return (
    <View className="flex-row" style={{ gap: 10 }}>
      {keys.map((k) => (
        <NutrientCard key={k} k={k} eaten={totals[k]} goal={goals[k]} />
      ))}
    </View>
  );
}

// ── Page 2: health score ─────────────────────────────────────────────────────
export function HealthScoreCard({ value, text }: { value: number; text: string }) {
  return (
    <Card className="mt-[10px] h-[142px] px-[16px] pt-[16px]">
      <View className="flex-row items-center justify-between">
        <Text className="text-[15.5px] font-semibold text-foreground">Health Score</Text>
        <Text className="text-[15.5px] font-semibold text-foreground">{value}/10</Text>
      </View>
      <View className="mt-[12px] h-[5px] overflow-hidden rounded-full bg-track">
        <View className="h-full rounded-full bg-health" style={{ width: `${value * 10}%` }} />
      </View>
      <Text numberOfLines={3} className="mt-[15px] text-[13px] leading-[16.5px] text-muted">
        {text}
      </Text>
    </Card>
  );
}

// ── Page 3: activity ─────────────────────────────────────────────────────────
export function StepsCard({ steps, goal }: { steps: number; goal: number }) {
  return (
    <Card className="h-[216px] flex-1 px-[16px] pt-[16px]">
      <Text className="text-[13.5px] text-muted">Steps</Text>
      <View className="flex-row items-end">
        <Text className="text-[24px] font-bold text-foreground">{steps.toLocaleString('en-US')}</Text>
        <Text className="mb-[3px] ml-[3px] text-[13px] text-muted">/{goal.toLocaleString('en-US')}</Text>
      </View>
      <View className="mt-[22px] items-center">
        <Ring size={106} stroke={7.5} progress={goal ? steps / goal : 0} color={c.foreground}>
          <PersonStanding size={22} color={c.foreground} strokeWidth={2.4} />
        </Ring>
      </View>
    </Card>
  );
}

export function BurnedCard({ total }: { total: number }) {
  return (
    <Card className="h-[216px] flex-1 px-[16px] pt-[16px]">
      <Text className="text-[13.5px] text-muted">Calories burned</Text>
      <View className="flex-row items-end">
        <Text className="text-[24px] font-bold text-foreground">{total}</Text>
        <Text className="mb-[3px] ml-[3px] text-[13px] text-muted">cal</Text>
      </View>
      <BurnRow icon={<Footprints size={17} color={c.foreground} />} label="Steps" value={total} />
    </Card>
  );
}

function BurnRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <View className="mt-[14px] flex-row">
      <View className="mt-[2px]">{icon}</View>
      <View className="ml-[10px]">
        <Text className="text-[15px] font-medium text-foreground">{label}</Text>
        <Text className="text-[13px] text-muted">{value} cal</Text>
      </View>
    </View>
  );
}

export function WaterCard({ cups, onLog }: { cups: number; onLog: () => void }) {
  return (
    <Card className="mt-[10px] h-[75px] flex-row items-center px-[18px]">
      <GlassWater size={30} color={c.water} strokeWidth={1.6} />
      <View className="ml-[16px] flex-1">
        <Text className="text-[14px] text-muted">Water</Text>
        <Text className="text-[17px] font-semibold text-foreground">
          {cups * 8} fl oz ({cups} {cups === 1 ? 'cup' : 'cups'})
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Log Water"
        onPress={onLog}
        className="h-[32px] items-center justify-center rounded-full border border-border bg-card px-[17px]"
      >
        <Text className="text-[15px] font-medium text-foreground">Log Water</Text>
      </Pressable>
    </Card>
  );
}

// ── Pager dots ───────────────────────────────────────────────────────────────
export function Dots({ count, index, onSelect }: { count: number; index: number; onSelect: (i: number) => void }) {
  return (
    <View className="flex-row justify-center" style={{ gap: 7 }}>
      {Array.from({ length: count }, (_, i) => (
        <Pressable
          key={i}
          accessibilityRole="button"
          accessibilityLabel={`Page ${i + 1}`}
          accessibilityState={{ selected: i === index }}
          hitSlop={6}
          onPress={() => onSelect(i)}
          className={`h-[8px] w-[8px] rounded-full ${i === index ? 'bg-foreground' : 'border border-faint'}`}
        />
      ))}
    </View>
  );
}
