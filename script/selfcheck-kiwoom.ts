/**
 * 키움 파싱 로직 자체 점검 (외부 호출 없음)
 * 실행: npx tsx script/selfcheck-kiwoom.ts
 *
 * 실제 키움 응답 형태(부호 포함 문자열, 0-padding, 종목별 중복 행)를 그대로 넣어
 * 차트/잔고/주문 파싱이 깨지면 실패한다.
 */
import { KiwoomService } from '../server/services/kiwoomService'
import { KiwoomWebSocketService } from '../server/services/kiwoomWebSocketService'

const service = KiwoomService.getInstance() as any
const failures: string[] = []
const check = (name: string, actual: any, expected: any) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures.push(`${name}: 기대 ${JSON.stringify(expected)} / 실제 ${JSON.stringify(actual)}`)
}

// OAuth 없이 내부 상태만 준비하고 request를 가짜 응답으로 교체
service.connected = true
service.accessToken = { token: 'fake', expires_at: Date.now() + 3600_000 }
service.axiosInstance = {}

const setResponse = (handler: (trId: string, body: any) => any) => {
  service.request = async (_endpoint: string, trId: string, body: any) => handler(trId, body)
}

// ── 1. 일봉 차트: 부호/0-padding 제거 + 응답 키 stk_dt_pole_chart_qry
setResponse((trId) => ({
  stk_cd: '005930',
  stk_dt_pole_chart_qry: [
    { cur_prc: '70100', trde_qty: '9263135', dt: '20250908', open_pric: '69800', high_pric: '70500', low_pric: '69600' },
    { cur_prc: '-69500', trde_qty: '11526724', dt: '20250905', open_pric: '-70300', high_pric: '-70400', low_pric: '-69500' },
  ],
  return_code: 0,
}))
check('일봉 파싱', await service.getCandleData('005930', 'day'), [
  { 일자: '20250908', 시가: 69800, 고가: 70500, 저가: 69600, 종가: 70100, 거래량: 9263135 },
  { 일자: '20250905', 시가: 70300, 고가: 70400, 저가: 69500, 종가: 69500, 거래량: 11526724 },
])

// ── 2. 분봉: cntr_tm(14자리) → 앞 12자리, 계좌 TR과 응답 키가 다름
setResponse(() => ({
  stk_min_pole_chart_qry: [
    { cur_prc: '-78800', cntr_tm: '20250917132000', open_pric: '-78850', high_pric: '-78900', low_pric: '-78800', trde_qty: '7913' },
  ],
  return_code: 0,
}))
check('분봉 파싱', await service.getCandleData('005930', '5'), [
  { 일자: '20250917132000', 시가: 78850, 고가: 78900, 저가: 78800, 종가: 78800, 거래량: 7913 },
])

// ── 3. 잔고: 0-padding 문자열 + 같은 종목 중복 행 합산
setResponse((trId) => {
  if (trId === 'kt00001') return { entr: '000000000017534', ord_alow_amt: '000000000085341', return_code: 0 }
  return {
    tot_pur_amt: '000000017598258',
    tot_evlt_amt: '000000025789890',
    tot_evlt_pl: '-00000000196888',
    tot_prft_rt: '46.25',
    prsm_dpst_aset_amt: '000001012632507',
    acnt_evlt_remn_indv_tot: [
      { stk_cd: 'A005930', stk_nm: '삼성전자', pur_pric: '000000000124500', rmnd_qty: '000000000000003', cur_prc: '000000059000', evlt_amt: '000000000177000' },
      { stk_cd: 'A005930', stk_nm: '삼성전자', pur_pric: '000000000209178', rmnd_qty: '000000000000008', cur_prc: '000000085000', evlt_amt: '000000000680000' },
    ],
    return_code: 0,
  }
})
service.portfolioCache = null
const portfolio = await service.getPortfolio()
check('예수금 파싱', portfolio.deposit, 17534)
check('총평가손익 부호', portfolio.totalProfit, -196888)
check('보유종목 합산 수량', portfolio.holdings[0].quantity, 11)
check('보유종목 접두어 제거', portfolio.holdings[0].code, '005930')
check('보유종목 평균단가', portfolio.holdings[0].purchasePrice, 186084) // (124500*3 + 209178*8) / 11

// ── 4. 주문 바디: 지정가는 trde_tp=0 + ord_uv, 시장가는 trde_tp=3 + ord_uv 빈값
let captured: any = null
setResponse((trId, body) => {
  captured = { trId, body }
  return { ord_no: '00024', return_code: 0, return_msg: '정상적으로 처리되었습니다' }
})
await service.placeOrder({ code: '005930', quantity: 3, price: 72000, order_type: 'buy', order_option: '00' })
check('지정가 매수 TR', captured.trId, 'kt10000')
check('지정가 매수 바디', captured.body, {
  dmst_stex_tp: 'KRX', stk_cd: '005930', ord_qty: '3', ord_uv: '72000', trde_tp: '0', cond_uv: '',
})

await service.placeOrder({ code: '005930', quantity: 1, price: 0, order_type: 'sell', order_option: '03' })
check('시장가 매도 TR', captured.trId, 'kt10001')
check('시장가 매도 바디', captured.body, {
  dmst_stex_tp: 'KRX', stk_cd: '005930', ord_qty: '1', ord_uv: '', trde_tp: '3', cond_uv: '',
})

// ── 5. 순위정보: 등락률 없는 TR은 전일대비로 계산, 응답 키가 TR마다 다름
setResponse(() => ({
  bid_req_upper: [
    { stk_cd: '005930', stk_nm: '삼성전자', cur_prc: '+65000', pred_pre: '+6300', trde_qty: '214670' },
  ],
  return_code: 0,
}))
const ranking = await service.getRankingInfo('ka10020')
check('순위정보 현재가', ranking.output[0].price, 65000)
check('순위정보 등락률 계산', ranking.output[0].changePercent, 10.73) // 6300 / 58700

// ── 6. 주문내역: 체결수량/잔량으로 상태 판정
setResponse(() => ({
  acnt_ord_cntr_prps_dtl: [
    { ord_no: '0000050', stk_cd: 'A069500', stk_nm: 'KODEX 200', io_tp_nm: '현금매수', ord_qty: '0000000005', ord_uv: '00000004900', cntr_qty: '0000000005', cntr_uv: '00000004950', ord_remnq: '0000000000', ord_tm: '13:05:43', mdfy_cncl: '' },
    { ord_no: '0000051', stk_cd: 'A005930', stk_nm: '삼성전자', io_tp_nm: '현금매도', ord_qty: '0000000002', ord_uv: '00000070000', cntr_qty: '0000000000', cntr_uv: '00000000000', ord_remnq: '0000000002', ord_tm: '13:06:00', mdfy_cncl: '' },
  ],
  return_code: 0,
}))
const history = await service.getOrderHistory()
check('주문내역 건수', history.length, 2)
check('전량체결 상태', history[0].status, '체결')
check('체결 주문 매수가(체결단가)', history[0].price, 4950)
check('체결 주문 매수 구분', history[0].type, 'buy')
check('미체결 주문 상태', history[1].status, '접수')
check('미체결 주문 매도 구분', history[1].type, 'sell')
check('미체결 잔량', history[1].unfilledQuantity, 2)

// ── 7. 요청 한도(429): 같은 TR 병렬 호출이 직렬화되는지
// 모의투자 ka10080은 유량 1(초당 1회)이라 병렬 호출 시 429가 났던 회귀 방지.
// 앞 단계에서 서비스 인스턴스의 request를 가짜로 바꿨으므로 원래 구현으로 되돌린다.
delete (service as any).request
service.isMockApi = () => true
const callTimes: number[] = []
let inFlight = 0
let maxConcurrent = 0

service.sendRequest = async () => {
  inFlight++
  maxConcurrent = Math.max(maxConcurrent, inFlight)
  callTimes.push(Date.now())
  await new Promise((resolve) => setTimeout(resolve, 20))
  inFlight--
  return { return_code: 0 }
}

const startAt = Date.now()
await Promise.all([
  service.request('/api/dostk/chart', 'ka10080', {}),
  service.request('/api/dostk/chart', 'ka10080', {}),
  service.request('/api/dostk/chart', 'ka10080', {}),
])
const elapsed = Date.now() - startAt

check('같은 TR 동시 실행 없음', maxConcurrent, 1)
check('TR 간격 준수(>=2.2초)', elapsed >= 2200, true)
check('호출 시각 간격(>=1.1초)', callTimes[1] - callTimes[0] >= 1100, true)

// 다른 TR은 서로 막지 않는지
const otherStart = Date.now()
await Promise.all([
  service.request('/api/dostk/chart', 'ka10080', {}),
  service.request('/api/dostk/stkinfo', 'ka10001', {}),
])
check('다른 TR은 동시 진행(3초 이내)', Date.now() - otherStart < 3000, true)

// ── 7-b. 다종목 현재가 배치(ka10095): 종목별 반복 호출 대신 1회로 처리
// 종목별 ka10001 반복은 큐 간격 때문에 수십 초가 걸려 30초 타임아웃이 났던 회귀 방지.
const batchCalls: any[] = []
service.request = async (_endpoint: string, trId: string, body: any) => {
  batchCalls.push({ trId, body })
  return {
    atn_stk_infr: String(body.stk_cd).split('|').map((code: string) => ({
      stk_cd: code,
      stk_nm: `종목${code}`,
      cur_prc: '+65000',
      pred_pre: '+6300',
      flu_rt: '+10.73',
      trde_qty: '214670',
      open_pric: '59000',
      high_pric: '66000',
      low_pric: '58500',
    })),
    return_code: 0,
  }
}

const manyCodes = Array.from({ length: 30 }, (_, i) => String(100000 + i))
const batchPrices = await service.getMultipleCurrentPrices(manyCodes)

check('배치 TR 사용', batchCalls[0].trId, 'ka10095')
check('배치 1회 호출(30종목)', batchCalls.length, 1)
check('배치 파이프 구분', batchCalls[0].body.stk_cd.split('|').length, 30)
check('배치 응답 건수', batchPrices.length, 30)
check('배치 현재가 파싱', batchPrices[0].price, 65000)
check('배치 등락률 파싱', batchPrices[0].changePercent, 10.73)

batchCalls.length = 0
await service.getMultipleCurrentPrices(Array.from({ length: 60 }, (_, i) => String(200000 + i)))
check('60종목은 2회 호출', batchCalls.length, 2)

// ── 8. WebSocket 재연결 시 실시간 등록 복구
// (서버 재시작·네트워크 단절 후 재연결하면 등록이 사라져 시세가 영구히 멈추던 문제)
const wsService = KiwoomWebSocketService.getInstance() as any
delete (wsService as any).request

const sent: any[] = []
wsService.sendMessage = (message: any) => sent.push(message)
wsService.loggedIn = true

// 시세 그룹 등록
wsService.registerRealTime(['005930', '000660'], ['0B'], '1', '0')
// 계좌 주문체결 그룹 등록
wsService.registerRealTime([''], ['00'], '9', '0')
sent.length = 0

// 재연결 후 로그인 성공 시점을 모사
wsService.replayRegistrations()

const replayGroups = sent.map((m) => m.grp_no).sort()
check('등록 복구 그룹', replayGroups, ['1', '9'])

const priceGroup = sent.find((m) => m.grp_no === '1')
check('등록 복구 refresh=0', priceGroup.refresh, '0')
check('등록 복구 종목', priceGroup.data[0].item.sort(), ['000660', '005930'])
check('등록 복구 type', priceGroup.data[0].type, ['0B'])

const accountGroup = sent.find((m) => m.grp_no === '9')
check('계좌 주문체결 복구 type', accountGroup.data[0].type, ['00'])

// 로그인 전 등록은 보관만 하고 전송하지 않아야 재연결 시 복구된다
const sentBeforeLogin = sent.length
wsService.loggedIn = false
wsService.registerRealTime(['035420'], ['0B'], '1', '1')
check('로그인 전 등록은 전송 안 함', sent.length, sentBeforeLogin)
wsService.loggedIn = true
sent.length = 0
wsService.replayRegistrations()
const replayAfter = sent.find((m) => m.grp_no === '1')
check('로그인 전 등록도 복구됨', replayAfter.data[0].item.includes('035420'), true)

// ── 9. 조건검색 결과 상한 (50개)
// 전일대비등락률상위(ka10027)가 200건을 줘도 50건만 반환해야 한다.
// 검색 종목이 많으면 실시간 등록·가격 폴링이 한도를 넘겨 시세가 끊긴다.
const conditionRouter = (await import('../server/routes/condition')).default as any

// 라우터의 getRankingInfo를 200건 응답으로 대체
service.getRankingInfo = async () => ({
  output: Array.from({ length: 200 }, (_, i) => ({
    stk_cd: String(100000 + i),
    stk_nm: `종목${i}`,
    prc: '10000',
    prdy_chng_rt: '5.0',
    acml_vol: '1000',
  })),
  return_code: 0,
})
service.isConnected = () => true

const callSearch = () =>
  new Promise<any>((resolve) => {
    const req: any = { body: { conditions: [{ id: 'ka10027', name: '전일대비등락률상위', enabled: true }] } }
    const res: any = {
      status() { return this },
      json(payload: any) { resolve(payload); return this },
    }
    const stack = conditionRouter.stack.find((l: any) => l.route?.path === '/search')
    stack.route.stack[0].handle(req, res)
  })

const searchResult = await callSearch()
check('조건검색 50건 상한', searchResult.stocks.length, 50)
check('조건검색 count도 50', searchResult.count, 50)

if (failures.length > 0) {
  console.error(`\n실패 ${failures.length}건`)
  failures.forEach((f) => console.error(' -', f))
  process.exit(1)
}
console.log('키움 파싱 점검 통과 (차트·잔고·주문·순위·주문내역·요청한도·WS복구·검색50건)')
