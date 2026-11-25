// 계좌 요약 합계 일치 셀프체크: npx tsx script/selfcheck-account-totals.ts
// 증상: "총 매입금액과 보유 종목이 안 맞아"
// 원인 1) 서버 getBalance()가 holdings 배열만 반환 → 라우트에서 합계를 못 꺼냄(0)
// 원인 2) 클라이언트가 평균단가(반올림) × 수량으로 재계산 → 실제 매입금액과 오차
// 원인 3) kt00018의 tot_evlt_pl 을 우선 사용 → 종목별 손익 합과 불일치
import assert from 'assert'

interface Stock { code: string; quantity: number; purchasePrice: number; purchaseAmount: number; currentPrice: number; evaluation: number; profit: number }
interface Balance { stocks: Stock[]; totalPurchase: number; totalStockValue: number; totalProfit: number; totalProfitRate: number }

/** AutoTrading.tsx 의 accountTotals 규칙 */
function accountTotals(balance: Balance, holdings: any[]) {
  const serverPurchase = Number(balance.totalPurchase) || 0
  const serverValue = Number(balance.totalStockValue) || 0
  const serverProfit = Number(balance.totalProfit) || 0

  const localPurchase = holdings.reduce(
    (sum, s: any) => sum + (Number(s.purchaseAmount) || (s.purchasePrice || 0) * (s.quantity || 0)),
    0,
  )
  const localValue = holdings.reduce(
    (sum, s: any) => sum + (Number(s.evaluation) || (s.currentPrice || 0) * (s.quantity || 0)),
    0,
  )
  const localProfit = holdings.reduce((sum, s) => sum + (s.profit || 0), 0)

  const totalPurchase = serverPurchase > 0 ? serverPurchase : localPurchase
  const totalStockValue = serverValue > 0 ? serverValue : localValue
  const totalProfit = serverValue > 0 || totalPurchase > 0 ? serverProfit : localProfit
  const totalProfitRate = totalPurchase > 0 ? (totalProfit / totalPurchase) * 100 : 0
  return { totalPurchase, totalStockValue, totalProfit, totalProfitRate }
}

const stocks: Stock[] = [
  // 평균단가가 나누어떨어지지 않는 종목 (반올림 오차 발생 케이스)
  { code: 'A', quantity: 3, purchasePrice: 3333, purchaseAmount: 10000, currentPrice: 3400, evaluation: 10200, profit: 200 },
  { code: 'B', quantity: 7, purchasePrice: 1429, purchaseAmount: 10000, currentPrice: 1400, evaluation: 9800, profit: -200 },
]
const balance: Balance = {
  stocks,
  totalPurchase: stocks.reduce((s, x) => s + x.purchaseAmount, 0),
  totalStockValue: stocks.reduce((s, x) => s + x.evaluation, 0),
  totalProfit: stocks.reduce((s, x) => s + x.profit, 0),
  totalProfitRate: 0,
}

// 1. 서버 합계 == 종목별 합계
{
  assert.equal(balance.totalPurchase, 20000)
  assert.equal(balance.totalStockValue, 20000)
  assert.equal(balance.totalProfit, 0)
}

// 2. 클라이언트가 서버 합계를 그대로 쓰면 종목 합과 일치
{
  const t = accountTotals(balance, stocks)
  assert.equal(t.totalPurchase, stocks.reduce((s, x) => s + x.purchaseAmount, 0), '총매입금액 일치')
  assert.equal(t.totalStockValue, stocks.reduce((s, x) => s + x.evaluation, 0), '총평가금액 일치')
  assert.equal(t.totalProfit, stocks.reduce((s, x) => s + x.profit, 0), '총평가손익 일치')
}

// 3. 반올림 단가 × 수량은 실제 매입금액과 어긋난다 (왜 서버 합계를 써야 하는지)
{
  const naive = stocks.reduce((s, x) => s + x.purchasePrice * x.quantity, 0)
  const exact = stocks.reduce((s, x) => s + x.purchaseAmount, 0)
  assert.equal(naive, 9999 + 10003)  // 20002
  assert.notEqual(naive, exact, '반올림 재계산은 실제값과 다르다')
}

// 4. 서버 합계가 0(미제공)이면 purchaseAmount 기준으로 대체
{
  const zero: Balance = { ...balance, totalPurchase: 0, totalStockValue: 0, totalProfit: 0 }
  const t = accountTotals(zero, stocks)
  assert.equal(t.totalPurchase, 20000, 'purchaseAmount 로 대체')
  assert.equal(t.totalStockValue, 20000, 'evaluation 으로 대체')
  assert.equal(t.totalProfit, 0)
}

// 5. 수익률은 표시된 합계로 재계산 (앞뒤 일치)
{
  const t = accountTotals(balance, stocks)
  assert.equal(Number(t.totalProfitRate.toFixed(2)), 0)
  const profitBalance: Balance = { ...balance, totalProfit: 500 }
  const t2 = accountTotals(profitBalance, stocks)
  assert.equal(Number(t2.totalProfitRate.toFixed(2)), 2.5, '500/20000 = 2.5%')
}

console.log('OK: 계좌 요약 합계 일치 셀프체크 통과')
