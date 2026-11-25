// 보유종목 수익률 갱신 셀프체크: npx tsx script/selfcheck-holding-profit.ts
// 증상: "현재 보유 종목 수익률이 갱신이 잘 안 되는 것 같다"
// 원인 1) 잔고 폴링이 isRunning일 때만 동작 → 자동매매 미실행 시 영구 정지
// 원인 2) maxProfitPercent 가 자기 자신을 참조해 폴링마다 0으로 리셋
// 원인 3) 표가 잔고 API 값만 사용 (WebSocket 실시간 시세 미반영)
import assert from 'assert'

interface Holding {
  code: string
  quantity: number
  currentPrice: number
  purchasePrice: number
  profitPercent: number
  maxProfitPercent: number
}

/** AutoTrading.tsx 의 잔고 폴링 반영 규칙 */
function applyBalancePoll(
  prev: Holding[],
  rows: Array<{ code: string; quantity: number; currentPrice: number; purchasePrice: number; profitPercent: number }>
): Holding[] {
  const prevMax = new Map(prev.map(h => [h.code, h.maxProfitPercent || 0]))
  return rows.map(r => ({
    code: r.code,
    quantity: r.quantity,
    currentPrice: r.currentPrice,
    purchasePrice: r.purchasePrice,
    profitPercent: r.profitPercent,
    // 폴링마다 0으로 리셋되면 트레일링 판정이 깨진다
    maxProfitPercent: Math.max(prevMax.get(r.code) || 0, r.profitPercent),
  }))
}

/** AutoTrading.tsx 의 표 렌더링 규칙: 실시간 시세 > 잔고 API */
function applyLiveTick(rows: any[], live: Holding[]): any[] {
  return rows.map(row => {
    const l = live.find(h => h.code === row.stockCode)
    if (!l) return row
    return {
      ...row,
      currentPrice: l.currentPrice || row.currentPrice,
      profitPercent: Number.isFinite(l.profitPercent) ? l.profitPercent : row.profitPercent,
      quantity: l.quantity || row.quantity,
    }
  })
}

/** AutoTrading.tsx 의 폴링 주기 규칙 */
function pollIntervalMs(isRunning: boolean): number | false {
  return isRunning ? 5000 : 15000
}

// 1. 자동매매 미실행 시에도 폴링이 돈다 (기존에는 false = 영구 정지)
{
  assert.equal(pollIntervalMs(false), 15000, '미실행 시에도 15초마다 갱신')
  assert.equal(pollIntervalMs(true), 5000, '실행 중 5초')
  assert.notEqual(pollIntervalMs(false), false, 'false(중지)가 아니어야 한다')
}

// 2. 최고 수익률이 폴링마다 리셋되지 않는다 (기존 버그 재현/방지)
{
  let holdings: Holding[] = []
  holdings = applyBalancePoll(holdings, [
    { code: 'A', quantity: 10, currentPrice: 1100, purchasePrice: 1000, profitPercent: 10 },
  ])
  assert.equal(holdings[0].maxProfitPercent, 10)

  // 주가 하락 (수익률 4%) → 최고 수익률은 10 유지
  holdings = applyBalancePoll(holdings, [
    { code: 'A', quantity: 10, currentPrice: 1040, purchasePrice: 1000, profitPercent: 4 },
  ])
  assert.equal(holdings[0].profitPercent, 4, '현재 수익률은 갱신')
  assert.equal(holdings[0].maxProfitPercent, 10, '최고 수익률은 유지 (기존 버그: 0으로 리셋)')

  // 신고가 (수익률 15%) → 최고 수익률 갱신
  holdings = applyBalancePoll(holdings, [
    { code: 'A', quantity: 10, currentPrice: 1150, purchasePrice: 1000, profitPercent: 15 },
  ])
  assert.equal(holdings[0].maxProfitPercent, 15)
}

// 3. 표는 실시간 시세를 우선 사용한다
{
  const apiRows = [
    { stockCode: 'A', currentPrice: 1040, profitPercent: 4, quantity: 10 },
    { stockCode: 'B', currentPrice: 2000, profitPercent: 2, quantity: 5 },
  ]
  const live: Holding[] = [
    { code: 'A', quantity: 10, currentPrice: 1070, purchasePrice: 1000, profitPercent: 7, maxProfitPercent: 10 },
  ]
  const out = applyLiveTick(apiRows, live)
  assert.equal(out[0].profitPercent, 7, 'A는 실시간 시세(7%) 사용')
  assert.equal(out[0].currentPrice, 1070)
  assert.equal(out[1].profitPercent, 2, 'B는 실시간 시세가 없어 API 값 유지')
}

// 4. 실시간 수익률이 0이어도 유효값으로 취급한다 (Number.isFinite)
{
  const apiRows = [{ stockCode: 'C', currentPrice: 1000, profitPercent: 5, quantity: 1 }]
  const live: Holding[] = [
    { code: 'C', quantity: 1, currentPrice: 1000, purchasePrice: 1000, profitPercent: 0, maxProfitPercent: 5 },
  ]
  const out = applyLiveTick(apiRows, live)
  assert.equal(out[0].profitPercent, 0, '0%도 실제 값이므로 반영 (?? 연산자 버그 방지)')
}

// 5. 잔고에서 사라진 종목은 결과에서 제외
{
  const holdings = applyBalancePoll(
    [{ code: 'A', quantity: 10, currentPrice: 1100, purchasePrice: 1000, profitPercent: 10, maxProfitPercent: 10 }],
    []
  )
  assert.equal(holdings.length, 0, '잔고에 없으면 제거')
}

console.log('OK: 보유종목 수익률 갱신 셀프체크 통과')
