// 시가%/고가% 계산 셀프체크: npx tsx script/selfcheck-openhigh.ts
import assert from 'assert'

/** AutoTrading.tsx 의 pricePercentFromPrevClose 와 동일 */
const pricePercentFromPrevClose = (target?: number, prevClose?: number): number | null => {
  if (!target || target <= 0 || !prevClose || prevClose <= 0) return null
  return ((target - prevClose) / prevClose) * 100
}

const fmt = (target?: number, prevClose?: number) => {
  const v = pricePercentFromPrevClose(target, prevClose)
  return v === null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`
}

// 1. 전일종가 10,000 / 시가 10,200 / 고가 10,700
assert.equal(fmt(10200, 10000), '+2.00%')
assert.equal(fmt(10700, 10000), '+7.00%')

// 2. 음수(갭 하락)도 부호 포함
assert.equal(fmt(9800, 10000), '-2.00%')

// 3. 데이터 없으면 '-' (기존 동작과 동일)
assert.equal(fmt(undefined, 10000), '-')
assert.equal(fmt(10200, undefined), '-')
assert.equal(fmt(0, 10000), '-')

// 4. 소수점 반올림
assert.equal(fmt(10005, 10000), '+0.05%')

console.log('OK: 시가%/고가% 계산 셀프체크 통과')
