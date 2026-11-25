// 매도가능수량(미체결 반영) 셀프체크: npx tsx script/selfcheck-sellable-qty.ts
// 증상: "[오전 9:56:54] 한국비티비 매도 실패: Request failed with status code 400"
// 실제 원인: (800033) 매도가능수량 부족 — 보유 16주가 미체결 매도 16주에 이미 묶여 있음
import assert from 'assert'

/** AutoTrading.tsx 의 calcSellableQuantity 와 동일 규칙 */
const calcSellableQuantity = (heldQty: number, pendingSellQty: number): number =>
  Math.max(0, Math.floor(heldQty) - Math.max(0, Math.floor(pendingSellQty)))

/** AutoTrading.tsx 의 isPendingSellStatus 와 동일 규칙 */
const isPendingSellStatus = (status?: string): boolean =>
  status === '접수' || status === '확인' || status === '미체결'

/** AutoTrading.tsx 의 getOrderErrorInfo 와 동일 규칙 */
const getOrderErrorInfo = (error: any) => {
  const data = error?.response?.data
  const message = data?.detail || data?.returnMsg || data?.error || error?.message || '알 수 없는 오류'
  return { message, status: error?.response?.status, returnCode: data?.returnCode ?? data?.return_code }
}

// 1. 실제 상황 재현: 보유 16주 + 미체결 매도 16주 → 매도가능 0주 (800033 방지)
{
  assert.equal(calcSellableQuantity(16, 16), 0, '물량이 전부 묶여 있으면 매도 불가')
}

// 2. 미체결 주문이 없으면 전량 매도 가능
{
  assert.equal(calcSellableQuantity(16, 0), 16)
}

// 3. 일부만 미체결이면 남은 수량만 매도
{
  assert.equal(calcSellableQuantity(16, 10), 6)
}

// 4. 미체결이 보유보다 많아도 음수가 되지 않는다
{
  assert.equal(calcSellableQuantity(5, 20), 0)
}

// 5. 미체결 상태 판정
{
  assert.equal(isPendingSellStatus('접수'), true)
  assert.equal(isPendingSellStatus('미체결'), true)
  assert.equal(isPendingSellStatus('체결'), false)
  assert.equal(isPendingSellStatus('취소'), false)
  assert.equal(isPendingSellStatus('부분체결'), false)
}

// 6. 매도 수량은 요청량과 매도가능수량 중 작은 값
{
  const requested = 16
  const sellable = calcSellableQuantity(16, 4)
  assert.equal(Math.min(requested, sellable), 12)
}

// 7. 400 응답은 axios 문구가 아니라 서버 사유를 보여준다
{
  const axiosError = {
    message: 'Request failed with status code 400',
    response: {
      status: 400,
      data: {
        error: '주문 전송 실패',
        detail: '[2000](800033:모의투자 매도가능수량이 부족합니다.)',
        returnCode: 20,
        returnMsg: '[2000](800033:모의투자 매도가능수량이 부족합니다.)',
      },
    },
  }
  const info = getOrderErrorInfo(axiosError)
  assert.equal(info.message, '[2000](800033:모의투자 매도가능수량이 부족합니다.)')
  assert.equal(info.returnCode, 20)
  assert.notEqual(info.message, 'Request failed with status code 400')
}

// 8. 응답 본문이 없어도 최소한 원본 메시지는 유지
{
  const info = getOrderErrorInfo({ message: 'Network Error' })
  assert.equal(info.message, 'Network Error')
}

console.log('OK: 매도가능수량/오류 사유 셀프체크 통과')
