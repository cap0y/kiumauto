// 보유종목 일관성 셀프체크: npx tsx script/selfcheck-holdings-consistency.ts
// 증상: "현재 보유 종목이 로그인 할 때와 자꾸 달라지는데?"
// 원인 1) 로그인 직후 잔고 조회 전에는 로컬 주문 로그로 표를 그림 → 잔고 도착 후 교체(플리커)
// 원인 2) "보유종목 비었으면 로그로 생성" effect 가 잔고 결과를 덮어씀
import assert from 'assert'

interface State {
  isConnected: boolean
  selectedAccount: string
  balanceData: any | undefined
  balanceError: any
  orderLogs: Array<{ stockCode: string; type: string; status: string; isExecuted?: boolean; quantity: number }>
  holdingStocks: any[]
}

/** AutoTrading.tsx 의 표 데이터 소스 결정 규칙 */
function holdingsSource(s: State): 'balance' | 'loading' | 'logs' {
  if (!s.isConnected || !s.selectedAccount) return 'logs'
  if (s.balanceError) return 'logs'
  // 잔고 응답이 아직 없으면 로딩 (로그로 대체하지 않음)
  if (s.balanceData === undefined) return 'loading'
  const rows = Array.isArray(s.balanceData)
    ? s.balanceData
    : Array.isArray(s.balanceData?.stocks)
      ? s.balanceData.stocks
      : null
  if (!rows) return 'logs'
  return 'balance'
}

/** 로그 기반 보유종목 생성 effect 가 실행되어야 하는가 */
function shouldGenerateFromLogs(s: State): boolean {
  if (s.holdingStocks.length > 0) return false
  if (s.orderLogs.length === 0) return false
  if (!s.isConnected) return false
  // 잔고를 조회할 수 있는 상태면 로그로 만들지 않는다
  if (s.isConnected && !!s.selectedAccount && !s.balanceError) return false
  return true
}

const baseState: State = {
  isConnected: true,
  selectedAccount: '1234567890-01',
  balanceData: { stocks: [{ code: '219750', quantity: 11 }, { code: '335870', quantity: 11 }] },
  balanceError: null,
  orderLogs: [
    { stockCode: '219750', type: 'buy', status: '체결', isExecuted: true, quantity: 11 },
    // 로컬에만 남은 유령 종목
    { stockCode: '999999', type: 'buy', status: '체결', isExecuted: true, quantity: 50 },
  ],
  holdingStocks: [],
}

// 1. 잔고 도착 후에는 반드시 잔고가 소스 (로그의 유령 종목 무시)
{
  assert.equal(holdingsSource(baseState), 'balance')
}

// 2. 로그인 직후 잔고 조회 중 → 로그로 그리지 않고 로딩 유지 (플리커 방지)
{
  const loading: State = { ...baseState, balanceData: undefined }
  assert.equal(holdingsSource(loading), 'loading', '조회 중에는 로그로 대체하지 않는다')
}

// 3. 잔고 조회 실패 시에만 로그로 대체
{
  const failed: State = { ...baseState, balanceData: undefined, balanceError: new Error('fail') }
  assert.equal(holdingsSource(failed), 'logs')
}

// 4. 미연결 상태(로그인 전)는 로그 기준
{
  const disconnected: State = { ...baseState, isConnected: false, balanceData: undefined }
  assert.equal(holdingsSource(disconnected), 'logs')
}

// 5. "보유종목 비었으면 로그로 생성" effect 는 잔고가 살아있을 때 절대 실행되지 않는다
{
  assert.equal(shouldGenerateFromLogs(baseState), false, '잔고가 정상이면 로그로 생성 금지')
  const noBalance: State = { ...baseState, balanceData: undefined, balanceError: new Error('fail') }
  assert.equal(shouldGenerateFromLogs(noBalance), true, '잔고 실패 시에만 로그로 생성')
}

// 6. 시나리오: 로그인 → 잔고 도착 과정에서 소스가 balance 로 고정되는지
{
  const seq: string[] = []
  seq.push(holdingsSource({ ...baseState, balanceData: undefined }))   // 조회 중
  seq.push(holdingsSource(baseState))                                   // 잔고 도착
  seq.push(holdingsSource(baseState))                                   // 재조회
  assert.deepEqual(seq, ['loading', 'balance', 'balance'])
  // 'loading' 단계에서 로그(유령 포함)를 그리지 않으므로 목록이 바뀌어 보이지 않는다
}

// 7. 잔고 응답이 배열 형태여도 동일하게 동작 (이전 형식 호환)
{
  const arr: State = { ...baseState, balanceData: [{ code: 'A', quantity: 1 }] }
  assert.equal(holdingsSource(arr), 'balance')
}

console.log('OK: 보유종목 일관성 셀프체크 통과')
