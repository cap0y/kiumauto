// 매매시간/단계별 익절 로직 셀프체크: npx tsx script/selfcheck-tradingTime.ts
import assert from 'assert'
import { hmsToSec, secInRange, pad2, stepSellTier, type StepThresholds } from '../client/src/utils/tradingTime'

const t: StepThresholds = { 익절1: 5, 익절2: 10, 익절3: 20, 익절4: 35, 손절: -5 }

// 1. 시간 구간 (시작 08:00:00 ~ 종료 20:00:59, 정지 12:00~14:00)
assert.equal(secInRange(hmsToSec(12, 0), hmsToSec(12, 0), hmsToSec(14, 0)), true)
assert.equal(secInRange(hmsToSec(13, 59, 59), hmsToSec(12, 0), hmsToSec(14, 0)), true)
assert.equal(secInRange(hmsToSec(14, 0), hmsToSec(12, 0), hmsToSec(14, 0)), false)
assert.equal(secInRange(hmsToSec(7, 59, 59), hmsToSec(8, 0), hmsToSec(20, 0, 59)), false)
// 자정 넘김 구간 (22:00 ~ 02:00)
assert.equal(secInRange(hmsToSec(23, 0), hmsToSec(22, 0), hmsToSec(2, 0)), true)
assert.equal(secInRange(hmsToSec(1, 0), hmsToSec(22, 0), hmsToSec(2, 0)), true)
assert.equal(secInRange(hmsToSec(12, 0), hmsToSec(22, 0), hmsToSec(2, 0)), false)
assert.equal(pad2(7), '07')

// 2. 단계별 익절: 임계값 판정만 검증 (수량 계산은 앱에서 Math.ceil(잔량*ratio))
assert.equal(stepSellTier(4.9, t, 0), null) // 1차 미달
assert.deepEqual(stepSellTier(5, t, 0), { step: 1, ratio: 0.1, reason: '단계별익절1' })
assert.equal(stepSellTier(5, t, 1), null) // 1차 완료 후 재발동 없음
assert.deepEqual(stepSellTier(10, t, 1), { step: 2, ratio: 0.4445, reason: '단계별익절2' })
// 급등으로 4차 구간 진입 시 4차만 발동 (상위 단계 우선)
assert.equal(stepSellTier(40, t, 0)?.step, 4)
// 손절은 전량
assert.deepEqual(stepSellTier(-5, t, 3), { step: 4, ratio: 1, reason: '단계별손절' })
assert.equal(stepSellTier(-4.9, t, 0), null)

// 3. 잔량 비율 누적 검증 (C# 주석: 총 80% 매도 / 20% 잔존 근사)
let qty = 100
const sold: number[] = []
for (const [profit, done] of [[5, 0], [10, 1], [20, 2], [35, 3]] as const) {
  const r = stepSellTier(profit, t, done)!
  const q = Math.min(Math.ceil(qty * r.ratio), qty)
  sold.push(q)
  qty -= q
}
assert.deepEqual(sold, [10, 41, 10, 20])
assert.equal(qty, 19)

console.log('OK: 매매시간/단계별 익절 로직 셀프체크 통과')
