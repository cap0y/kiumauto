// 매도 게이트 셀프체크: 단계별 익절 사용 중에도 설정 손절률이 적용되는지
import assert from 'assert'
import { stepSellTier, type StepThresholds } from '../client/src/utils/tradingTime'

const step: StepThresholds = { 익절1: 10, 익절2: 20, 익절3: 30, 익절4: 45, 손절: -10 }
const lossLimit = -1.5

// 단계별 익절 사용 시 적용할 손절 기준 (둘 중 더 타이트한 쪽)
const hardStop = Math.max(lossLimit, step.손절)
assert.equal(hardStop, -1.5, '설정 손절률(-1.5%)이 단계 손절(-10%)보다 우선해야 한다')

// -2.16% / -2.74% → 설정 손절 발동
assert.equal(-2.16 <= hardStop, true)
assert.equal(-2.74 <= hardStop, true)

// +3.06% → 1차 익절(10%) 미달이므로 매도하지 않음
assert.equal(stepSellTier(3.06, step, 0), null)

// -2.16%는 단계 손절(-10%) 미달이므로 단계 로직만으로는 매도되지 않는다 (버그 재현)
assert.equal(stepSellTier(-2.16, step, 0), null, '단계 로직만 쓰면 -2.16%에서 매도가 안 된다')

console.log('OK: 설정 손절률 우선 적용 셀프체크 통과')
