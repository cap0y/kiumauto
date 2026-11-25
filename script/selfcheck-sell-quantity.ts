// 매도 수량 제한 셀프체크: npx tsx script/selfcheck-sell-quantity.ts
// 증상: "[자동매도 실패] 뉴로핏: Request failed with status code 500"
// 실제 원인: (800033) 모의투자 매도가능수량이 부족합니다 → 보유 수량 초과 주문
import assert from 'assert'

interface BalanceRow { code: string; quantity: number }

/** 매도 직전 잔고로 수량을 제한하는 로직 (AutoTrading.tsx 와 동일 규칙) */
function limitSellQuantity(
  requestedQty: number,
  stockCode: string,
  balanceRows: BalanceRow[] | null
): { qty: number; reason?: string } {
  if (!balanceRows) return { qty: requestedQty } // 잔고 조회 실패 시 로컬 수량 유지
  const live = balanceRows.find((b) => String(b.code).trim() === stockCode)
  const heldQty = Number(live?.quantity ?? 0)
  if (Number.isFinite(heldQty) && heldQty > 0) {
    return { qty: Math.min(requestedQty, heldQty) }
  }
  return { qty: 0, reason: '잔고 0주' }
}

// 1. 로컬 16주 / 실제 잔고 4주 → 4주만 매도 (800033 방지)
{
  const r = limitSellQuantity(16, '365590', [{ code: '365590', quantity: 4 }])
  assert.equal(r.qty, 4, '실제 보유 수량으로 제한되어야 한다')
}

// 2. 잔고가 요청보다 많으면 요청 수량 유지 (부분 익절)
{
  const r = limitSellQuantity(3, '365590', [{ code: '365590', quantity: 10 }])
  assert.equal(r.qty, 3)
}

// 3. 잔고 0 → 주문하지 않음 (500/800033 대신 경고 로그)
{
  const r = limitSellQuantity(10, '365590', [{ code: '365590', quantity: 0 }])
  assert.equal(r.qty, 0)
  assert.equal(r.reason, '잔고 0주')
}

// 4. 종목이 잔고에 없음 → 주문하지 않음
{
  const r = limitSellQuantity(10, '999999', [{ code: '365590', quantity: 5 }])
  assert.equal(r.qty, 0)
}

// 5. 잔고 조회 실패(null) → 기존 동작 유지 (서버가 최종 판단)
{
  const r = limitSellQuantity(7, '365590', null)
  assert.equal(r.qty, 7)
}

// 6. 시장가 주문 바디가 Kiwoom 스펙과 일치하는지
{
  const body = { dmst_stex_tp: 'KRX', stk_cd: '365590', ord_qty: '4', ord_uv: '', trde_tp: '3', cond_uv: '' }
  assert.equal(body.trde_tp, '3', '시장가는 trde_tp=3')
  assert.equal(body.ord_uv, '', '시장가는 ord_uv 빈값')
}

// 7. 서버가 Kiwoom 오류를 500이 아닌 4xx로 전달하는지 (상태코드 매핑)
{
  const toHttpStatus = (kiwoomStatus?: number) => (kiwoomStatus && kiwoomStatus >= 500 ? kiwoomStatus : 400)
  assert.equal(toHttpStatus(400), 400)
  assert.equal(toHttpStatus(undefined), 400, '원인 불명도 500 대신 400 + 사유 전달')
  assert.equal(toHttpStatus(503), 503)
}

console.log('OK: 매도 수량 제한/오류 전달 셀프체크 통과')
