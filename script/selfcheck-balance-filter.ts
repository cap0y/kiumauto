// 잔고 필터 셀프체크: npx tsx script/selfcheck-balance-filter.ts
// 증상: 잔고 0주인데 "현재 보유 종목"에 계속 표시됨
// 원인 1) 표가 displayHoldingOrders 대신 buildDisplayOrders(orderLogs)를 직접 사용
// 원인 2) getBalance() 응답({stocks:[...]})을 Array.isArray로만 판정해 항상 빈 배열
import assert from 'assert'

interface BalanceRow { code: string; name: string; quantity: number }

/** AutoTrading.tsx 의 normalizeBalanceRows 와 동일 규칙 */
function normalizeBalanceRows(balance: any): any[] {
  if (Array.isArray(balance)) return balance
  if (Array.isArray(balance?.stocks)) return balance.stocks
  return []
}

/** 잔고 기준 필터 (quantity > 0 만 남긴다) */
function filterHoldings(rows: BalanceRow[]): BalanceRow[] {
  return rows.filter((b) => b.code && b.quantity > 0)
}

// 1. 서버 실제 응답 형태 { stocks: [...] } 를 정상 파싱해야 한다
{
  const apiResponse = {
    stocks: [
      { code: '004540', name: '깨끗한나라', quantity: 18 },
      { code: '999999', name: '유령종목', quantity: 0 },
    ],
  }
  const rows = normalizeBalanceRows(apiResponse)
  assert.equal(rows.length, 2, 'stocks 배열을 읽어야 한다')

  const holdings = filterHoldings(rows)
  assert.deepEqual(holdings.map((h) => h.code), ['004540'], '잔고 0주는 제외')
}

// 2. 배열 응답도 그대로 처리
{
  const rows = normalizeBalanceRows([{ code: 'A', name: 'a', quantity: 3 }])
  assert.equal(rows.length, 1)
}

// 3. 알 수 없는 형태는 빈 배열 (로그 기준 유지 판단에 쓰임)
{
  assert.deepEqual(normalizeBalanceRows(null), [])
  assert.deepEqual(normalizeBalanceRows(undefined), [])
  assert.deepEqual(normalizeBalanceRows({ error: 'x' }), [])
}

// 4. 잔고에 없는 종목은 표에서 제거되어야 한다 (유령 종목 회귀 방지)
{
  const logRows = [
    { stockCode: '004540', stockName: '깨끗한나라', type: 'buy' as const },
    { stockCode: '999999', stockName: '유령종목', type: 'buy' as const },
  ]
  const balance = filterHoldings(normalizeBalanceRows({
    stocks: [{ code: '004540', name: '깨끗한나라', quantity: 18 }],
  }))
  const liveCodes = new Set(balance.map((b) => b.code))
  const displayed = logRows.filter((r) => liveCodes.has(r.stockCode))
  assert.deepEqual(displayed.map((d) => d.stockCode), ['004540'], '유령 종목은 표시되지 않아야 한다')
}

// 5. 잔고 조회 실패(error 포함) 시에는 필터하지 않고 로그 유지
{
  const apiResponse = { stocks: [], error: '키움증권 API에 연결되지 않았습니다', warning: true }
  const rows = normalizeBalanceRows(apiResponse)
  const shouldTrustBalance = rows.length > 0 && !(apiResponse as any).error
  assert.equal(shouldTrustBalance, false, '에러 응답은 신뢰하지 않는다')
}

console.log('OK: 잔고 필터/유령 종목 제거 셀프체크 통과')
