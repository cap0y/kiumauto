// 매매시간/단계별 익절 순수 로직 (UI와 분리해 검증 가능하게 유지)

export const hmsToSec = (h: number, m: number, s = 0) => h * 3600 + m * 60 + s

// 자정을 넘는 구간(from > to)도 지원
export const secInRange = (sec: number, from: number, to: number) =>
  from <= to ? sec >= from && sec < to : sec >= from || sec < to

export const pad2 = (n: number) => String(n).padStart(2, '0')

export interface StepThresholds {
  익절1: number
  익절2: number
  익절3: number
  익절4: number
  손절: number
}

// C# 키움데이터수신처리.cs 단계별 익절 로직 이식
// - 손절: 전량 매도
// - 각 단계: 현재 잔량 대비 10% → 44.45% → 20% → 50% (최초 물량 기준 10/40/60/잔량에 해당)
// - 이미 지나간 단계는 다시 발동하지 않음
export function stepSellTier(
  profitPercent: number,
  t: StepThresholds,
  doneStep: number
): { step: number; ratio: number; reason: string } | null {
  if (profitPercent <= t.손절) return { step: 4, ratio: 1, reason: '단계별손절' }

  const tiers: Array<[number, number, number]> = [
    [4, t.익절4, 0.5],
    [3, t.익절3, 0.2],
    [2, t.익절2, 0.4445],
    [1, t.익절1, 0.1],
  ]
  for (const [step, trigger, ratio] of tiers) {
    if (doneStep < step && profitPercent >= trigger) {
      return { step, ratio, reason: `단계별익절${step}` }
    }
  }
  return null
}
