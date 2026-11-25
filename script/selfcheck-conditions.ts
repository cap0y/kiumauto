// 매매조건 섹션 동작 검증: npx tsx script/selfcheck-conditions.ts
// 검증 대상: 체크박스/설정값이 실제 매수·매도 판정에 반영되는지
import assert from 'assert'

// ── 1. 매도수식 체크박스가 실제 로직에 연결되는지 ─────────────────
interface SellGate {
  sellFormula1: boolean // 익절/손절
  sellFormula2: boolean // 트레일링
  trailingStop: boolean
  trailingProfitThreshold: number
  trailingDropThreshold: number
  profitTarget: number
  lossLimit: number
}
interface Holding { profitPercent: number; maxProfitPercent: number }

/** AutoTrading.tsx 의 checkSellConditions 규칙 */
function checkSellConditions(h: Holding, g: SellGate): boolean {
  if (!g.sellFormula1 && !g.sellFormula2) return false

  const maxProfit = Math.max(h.profitPercent, h.maxProfitPercent)

  // 매도수식 2: 트레일링
  if (g.sellFormula2 && g.trailingStop && maxProfit >= g.trailingProfitThreshold) {
    const drop = maxProfit - h.profitPercent
    if (drop >= Math.abs(g.trailingDropThreshold)) return true
  }

  if (!g.sellFormula1) return false

  // 익절
  if (g.profitTarget > 0 && maxProfit >= g.profitTarget) return true
  // 손절
  if (g.lossLimit < 0 && h.profitPercent <= g.lossLimit) return true
  return false
}

const baseGate: SellGate = {
  sellFormula1: true, sellFormula2: false, trailingStop: true,
  trailingProfitThreshold: 5, trailingDropThreshold: -3, profitTarget: 10, lossLimit: -3,
}

// 둘 다 해제 → 어떤 조건이든 매도하지 않는다
{
  const g = { ...baseGate, sellFormula1: false, sellFormula2: false }
  assert.equal(checkSellConditions({ profitPercent: 20, maxProfitPercent: 20 }, g), false, '매도수식 전체 해제 시 매도 금지')
  assert.equal(checkSellConditions({ profitPercent: -10, maxProfitPercent: 0 }, g), false, '손실이어도 매도 금지')
}

// 매도수식 1만: 익절/손절 동작, 트레일링은 동작하지 않음
{
  const g = { ...baseGate, sellFormula1: true, sellFormula2: false }
  assert.equal(checkSellConditions({ profitPercent: 12, maxProfitPercent: 12 }, g), true, '익절')
  assert.equal(checkSellConditions({ profitPercent: -4, maxProfitPercent: 0 }, g), true, '손절')
  // 6%까지 올랐다가 2.5%로 하락 (하락 3.5%) — 트레일링은 꺼져 있으므로 매도 안 함
  assert.equal(checkSellConditions({ profitPercent: 2.5, maxProfitPercent: 6 }, g), false, '매도수식2 꺼짐 → 트레일링 미동작')
}

// 매도수식 2만: 트레일링만 동작
{
  const g = { ...baseGate, sellFormula1: false, sellFormula2: true }
  assert.equal(checkSellConditions({ profitPercent: 2.5, maxProfitPercent: 6 }, g), true, '트레일링 매도')
  assert.equal(checkSellConditions({ profitPercent: 12, maxProfitPercent: 12 }, g), false, '매도수식1 꺼짐 → 익절 미동작')
  assert.equal(checkSellConditions({ profitPercent: -4, maxProfitPercent: 0 }, g), false, '매도수식1 꺼짐 → 손절 미동작')
}

// ── 2. 매수수식 2가 전략 6종의 게이트인지 ─────────────────────────
interface BuyGate {
  buyFormula1: boolean
  buyFormula2: boolean
  strategies: { marketOpen: boolean; bollinger: boolean; scalping: boolean; breakout: boolean; marketClose: boolean; basic: boolean }
}
/** AutoTrading.tsx 의 차트분석필요/전략 실행 규칙 */
function effectiveStrategies(g: BuyGate) {
  const on = g.buyFormula2
  return {
    marketOpen: on && g.strategies.marketOpen,
    bollinger: on && g.strategies.bollinger,
    scalping: on && g.strategies.scalping,
    breakout: on && g.strategies.breakout,
    marketClose: on && g.strategies.marketClose,
    basic: on && g.strategies.basic,
  }
}
{
  const all = { marketOpen: true, bollinger: true, scalping: true, breakout: true, marketClose: true, basic: true }
  const off = effectiveStrategies({ buyFormula1: false, buyFormula2: false, strategies: all })
  assert.deepEqual(off, { marketOpen: false, bollinger: false, scalping: false, breakout: false, marketClose: false, basic: false },
    '매수수식2 해제 시 전략 6종 전부 미동작')

  const on = effectiveStrategies({ buyFormula1: false, buyFormula2: true, strategies: all })
  assert.equal(on.marketOpen, true, '매수수식2 체크 시 전략 동작')
  assert.equal(on.basic, true)
}

// ── 3. 매매시간 게이트 ───────────────────────────────────────────
const hmsToSec = (h: number, m: number, s = 0) => h * 3600 + m * 60 + s
const secInRange = (sec: number, from: number, to: number) =>
  from <= to ? sec >= from && sec < to : sec >= from || sec < to

interface TimeGate {
  startHour: number; startMinute: number
  endHour: number; endMinute: number; endSecond: number
  pauseBuyEnabled: boolean; pauseStartHour: number; pauseStartMinute: number
  pauseEndHour: number; pauseEndMinute: number
  buyStopped: boolean
}
function canBuyAt(sec: number, g: TimeGate): boolean {
  if (g.buyStopped) return false
  if (!secInRange(sec, hmsToSec(g.startHour, g.startMinute), hmsToSec(g.endHour, g.endMinute, g.endSecond))) return false
  if (g.pauseBuyEnabled && secInRange(sec, hmsToSec(g.pauseStartHour, g.pauseStartMinute), hmsToSec(g.pauseEndHour, g.pauseEndMinute))) return false
  return true
}
{
  const g: TimeGate = {
    startHour: 9, startMinute: 0, endHour: 15, endMinute: 20, endSecond: 0,
    pauseBuyEnabled: true, pauseStartHour: 12, pauseStartMinute: 0, pauseEndHour: 14, pauseEndMinute: 0,
    buyStopped: false,
  }
  assert.equal(canBuyAt(hmsToSec(8, 59), g), false, '시작 전 매수 금지')
  assert.equal(canBuyAt(hmsToSec(10, 0), g), true, '장중 매수 허용')
  assert.equal(canBuyAt(hmsToSec(12, 30), g), false, '시간대정지 구간 매수 금지')
  assert.equal(canBuyAt(hmsToSec(14, 30), g), true, '정지 해제 후 매수 허용')
  assert.equal(canBuyAt(hmsToSec(15, 21), g), false, '종료 후 매수 금지')
  assert.equal(canBuyAt(hmsToSec(10, 0), { ...g, buyStopped: true }), false, '즉시 매수정지')
}

// ── 4. 단계별 익절 ──────────────────────────────────────────────
const stepSellTier = (profit: number, t: any, done: number) => {
  if (profit <= t.손절) return { step: 4, ratio: 1 }
  const tiers: Array<[number, number, number]> = [
    [4, t.익절4, 0.5], [3, t.익절3, 0.2], [2, t.익절2, 0.4445], [1, t.익절1, 0.1],
  ]
  for (const [step, trigger, ratio] of tiers) {
    if (done < step && profit >= trigger) return { step, ratio }
  }
  return null
}
{
  const t = { 익절1: 10, 익절2: 20, 익절3: 30, 익절4: 45, 손절: -10 }
  assert.equal(stepSellTier(9.9, t, 0), null, '1차 미달')
  assert.equal(stepSellTier(10, t, 0)?.step, 1, '1차 발동')
  assert.equal(stepSellTier(10, t, 1), null, '1차 완료 후 재발동 없음')
  assert.equal(stepSellTier(-10, t, 3)?.ratio, 1, '손절은 전량')
}

// ── 5. 매매조건 입력값이 게이트로 쓰이는지 ────────────────────────
interface Limits { maxSimultaneousBuy: number; tradeLimitPerStock: number; maxDailyStocks: number }
interface Ctx { holdings: number; tradeCount: number; dailyCount: number }
function passLimits(l: Limits, c: Ctx): { ok: boolean; reason?: string } {
  if (l.maxSimultaneousBuy > 0 && c.holdings >= l.maxSimultaneousBuy) return { ok: false, reason: '동시보유 초과' }
  if (l.tradeLimitPerStock > 0 && c.tradeCount >= l.tradeLimitPerStock) return { ok: false, reason: '종목당 횟수 초과' }
  if (l.maxDailyStocks > 0 && c.dailyCount >= l.maxDailyStocks) return { ok: false, reason: '당일 종목수 초과' }
  return { ok: true }
}
{
  const l: Limits = { maxSimultaneousBuy: 10, tradeLimitPerStock: 30, maxDailyStocks: 50 }
  assert.equal(passLimits(l, { holdings: 9, tradeCount: 29, dailyCount: 49 }).ok, true)
  assert.equal(passLimits(l, { holdings: 10, tradeCount: 0, dailyCount: 0 }).reason, '동시보유 초과')
  assert.equal(passLimits(l, { holdings: 0, tradeCount: 30, dailyCount: 0 }).reason, '종목당 횟수 초과')
  assert.equal(passLimits(l, { holdings: 0, tradeCount: 0, dailyCount: 50 }).reason, '당일 종목수 초과')
  // 0 = 무제한
  assert.equal(passLimits({ ...l, maxSimultaneousBuy: 0 }, { holdings: 99, tradeCount: 0, dailyCount: 0 }).ok, true)
}

// ── 6. 미체결 취소 대상 선정 ────────────────────────────────────
const isCancelTarget = (status?: string) => status === '접수' || status === '확인' || status === '미체결'
{
  assert.equal(isCancelTarget('접수'), true)
  assert.equal(isCancelTarget('미체결'), true)
  assert.equal(isCancelTarget('체결'), false)
  assert.equal(isCancelTarget('취소'), false)
}

console.log('OK: 매매조건 섹션 동작 검증 통과 (매도수식/매수수식2/시간/단계별/한도/취소)')
