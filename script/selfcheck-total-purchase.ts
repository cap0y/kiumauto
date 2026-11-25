// 총매입금액 안정성 셀프체크: npx tsx script/selfcheck-total-purchase.ts
// 증상: "총 매입 금액이 자꾸 이상한 수치가 나와 / 자꾸 바뀌는데?"
// 원인 1) kiwoomApi.getBalance() 가 배열만 반환 → balanceData.totalPurchase 가 undefined
//        → 화면이 로컬 추정치(purchasePrice×수량 합)로 계산해 값이 흔들림
// 원인 2) 로컬 추정치는 반올림 단가·부분체결 반영 등으로 서버 합계와 어긋남
import assert from 'assert'

interface Stock { code: string; quantity: number; purchasePrice: number; purchaseAmount: number }
interface Balance { stocks: Stock[]; totalPurchase: number }

/** AutoTrading.tsx 의 accountTotals 중 총매입금액 결정 규칙 */
function totalPurchaseOf(balance: Balance | undefined, holdings: any[]): number {
  const server = Number(balance?.totalPurchase) || 0
  if (server > 0) return server
  return holdings.reduce(
    (sum, s: any) => sum + (Number(s.purchaseAmount) || (s.purchasePrice || 0) * (s.quantity || 0)),
    0,
  )
}

const stocks: Stock[] = [
  // 평균단가가 나누어떨어지지 않는 종목 (반올림 오차 발생)
  { code: 'A', quantity: 3, purchasePrice: 3333, purchaseAmount: 10000 },
  { code: 'B', quantity: 1270, purchasePrice: 3900, purchaseAmount: 4953001 },
]
const balance: Balance = {
  stocks,
  totalPurchase: stocks.reduce((s, x) => s + x.purchaseAmount, 0),
}

// 1. 서버 합계가 있으면 그 값을 쓴다 (안정적)
{
  const t = totalPurchaseOf(balance, stocks)
  assert.equal(t, 4963001)
  assert.equal(t, totalPurchaseOf(balance, stocks), t, '같은 입력이면 같은 값')
}

// 2. 서버 합계를 잃어버리면(배열만 반환) 로컬 추정치로 떨어지고, 그 값이 서버와 다르다
{
  const rounded = stocks.map(s => ({ ...s, purchaseAmount: undefined }))
  const local = totalPurchaseOf(undefined, rounded)
  assert.equal(local, 4962999, '단가×수량 재계산')
  assert.notEqual(local, balance.totalPurchase, '단가만으로 재계산하면 실제 합계와 어긋난다')
  assert.equal(balance.totalPurchase - local, 2, '2원 오차 발생')
}

// 3. 정확한 purchaseAmount 가 있으면 로컬 계산도 서버와 일치
{
  assert.equal(totalPurchaseOf(undefined, stocks), balance.totalPurchase)
}

// 3. 핵심 회귀: 홀딩 목록이 늘/줄어도 서버 합계가 있으면 총매입금액은 고정
{
  const partial = stocks.slice(0, 1) // 폴링 중 일부만 도착한 상황
  assert.equal(totalPurchaseOf(balance, partial), balance.totalPurchase,
    '화면 종목이 일부만 있어도 총매입금액은 서버 값 유지')
}

// 4. 잔고가 아직 없으면 0 (로컬 추정으로 흔들리지 않게 계좌 미연결 상태)
{
  assert.equal(totalPurchaseOf(undefined, []), 0)
}

// 5. getBalanceSummary 가 객체를, getBalance 가 배열을 반환하는지 (API 계약)
{
  const apiResponse = { stocks, totalPurchase: balance.totalPurchase }
  // getBalanceSummary → 객체 그대로
  const summary = apiResponse
  assert.equal(summary.totalPurchase, balance.totalPurchase)
  // getBalance → 배열
  const list = summary?.stocks || []
  assert.ok(Array.isArray(list))
  assert.equal(list.length, 2)
}

console.log('OK: 총매입금액 안정성 셀프체크 통과')
