/**
 * 키움증권 REST API 서비스
 * 공식 가이드: https://openapi.kiwoom.com/guide/apiguide
 *
 * 키움 REST는 모든 조회/주문이 POST + `api-id` 헤더로 TR을 구분한다.
 *   /oauth2/token        접근토큰 발급
 *   /api/dostk/stkinfo   ka10001 종목기본정보(현재가)
 *   /api/dostk/chart     ka10079 틱 / ka10080 분봉 / ka10081 일봉
 *   /api/dostk/rkinfo    ka10023·ka10027·ka10030·ka10031·ka10032 순위정보
 *   /api/dostk/acnt      ka00001 계좌 / kt00001 예수금 / kt00018 잔고 / kt00007 주문내역
 *   /api/dostk/ordr      kt10000 매수 / kt10001 매도
 *
 * 주의: 주문·잔고·차트는 계좌번호를 파라미터로 받지 않는다(토큰 계좌 기준).
 *       모의투자(mockapi)는 KRX만 지원하므로 dmst_stex_tp/stex_tp는 KRX로 고정한다.
 */
import axios, { AxiosInstance } from 'axios'
import { KiwoomWebSocketService } from './kiwoomWebSocketService'

interface KiwoomConfig {
  host: string // 실전: https://api.kiwoom.com, 모의: https://mockapi.kiwoom.com
  appkey: string
  secretkey: string
}

interface AccessToken {
  token: string
  expires_at: number
}

interface OrderRequest {
  code: string
  quantity: number
  price: number
  order_type: string
  order_option: string // '00': 지정가, '03': 시장가
}

// 차트 TR: URL은 같고 api-id와 응답 배열 키만 다르다
const CHART_TR: Record<string, { trId: string; key: string; timeField: string }> = {
  tick: { trId: 'ka10079', key: 'stk_tic_chart_qry', timeField: 'cntr_tm' },
  min: { trId: 'ka10080', key: 'stk_min_pole_chart_qry', timeField: 'cntr_tm' },
  day: { trId: 'ka10081', key: 'stk_dt_pole_chart_qry', timeField: 'dt' },
}

// 분봉 주기 (ka10080은 분 단위, ka10079는 틱 단위)
const MINUTE_SCOPE: Record<string, string> = {
  min: '1', '1': '1', '3': '3', '5': '5', '10': '10',
  '15': '15', '30': '30', '45': '45', '60': '60',
}

// 순위정보 TR별 필수 파라미터 (TR마다 요구 항목이 다르다)
const RANKING_PARAMS: Record<string, Record<string, string>> = {
  ka10020: { mrkt_tp: '001', sort_tp: '1', trde_qty_tp: '0000', stk_cnd: '0', crd_cnd: '0', stex_tp: '1' },
  ka10021: { mrkt_tp: '001', trde_tp: '1', sort_tp: '1', tm_tp: '30', trde_qty_tp: '1', stk_cnd: '0', stex_tp: '1' },
  ka10022: { mrkt_tp: '001', rt_tp: '1', tm_tp: '1', trde_qty_tp: '5', stk_cnd: '0', stex_tp: '1' },
  ka10023: { mrkt_tp: '000', sort_tp: '1', tm_tp: '2', trde_qty_tp: '5', tm: '', stk_cnd: '0', pric_tp: '0', stex_tp: '1' },
  ka10027: { mrkt_tp: '000', sort_tp: '1', trde_qty_cnd: '0000', stk_cnd: '0', crd_cnd: '0', updown_incls: '1', pric_cnd: '0', trde_prica_cnd: '0', stex_tp: '1' },
  ka10030: { mrkt_tp: '000', sort_tp: '1', mang_stk_incls: '0', crd_tp: '0', trde_qty_tp: '0', pric_tp: '0', trde_prica_tp: '0', mrkt_open_tp: '0', stex_tp: '1' },
  ka10031: { mrkt_tp: '000', qry_tp: '1', rank_strt: '0', rank_end: '50', stex_tp: '1' },
  ka10032: { mrkt_tp: '000', mang_stk_incls: '1', stex_tp: '1' },
}

export class KiwoomService {
  private config: KiwoomConfig | null = null
  private axiosInstance: AxiosInstance | null = null
  private accessToken: AccessToken | null = null
  private connected: boolean = false
  private cachedAccountList: string[] | null = null
  private accountListCacheTime: number = 0
  private webSocketService: KiwoomWebSocketService | null = null
  // 실시간 등록한 종목을 누적 추적한다. 매 등록마다 전체 목록을 다시 보내야
  // refresh='0'(기존 해지)으로 인해 이전 종목 시세가 끊기지 않는다.
  private registeredRealtimeCodes: Set<string> = new Set()
  // TR별 마지막 호출 시각과 큐. 모의투자는 ka10080 같은 TR의 유량이 1(초당 1회)이라
  // 같은 TR의 병렬 호출을 직렬화해야 429가 나지 않는다. 다른 TR은 서로 막지 않는다.
  private trLastCall: Map<string, number> = new Map()
  private trQueues: Map<string, Promise<any>> = new Map()

  // TR별 최소 호출 간격 (ms). 모의투자 기준값.
  private trInterval(trId: string): number {
    const isMock = this.isMockApi()
    // 차트 3종은 모의투자에서 유량 1로 확인됨 (429 응답: 유량=1, API ID=ka10080)
    if (trId === 'ka10079' || trId === 'ka10080' || trId === 'ka10081') {
      return isMock ? 1100 : 250
    }
    // 계좌 계열(kt00001/kt00018/kt00007/ka00001)은 문서상 초당 1회
    if (trId.startsWith('kt') || trId === 'ka00001') {
      return 1100
    }
    return isMock ? 400 : 220
  }
  // 잔고/예수금은 TR 호출 한도가 초당 1회라 잠시 캐시해서 중복 호출을 막는다
  private portfolioCache: { at: number; data: any } | null = null

  constructor() {}

  /** 키움 응답의 부호/0-padding 문자열을 숫자로 변환 ("+000000012345" → 12345) */
  private num(value: any): number {
    if (value === null || value === undefined || value === '') return 0
    const parsed = parseFloat(String(value).replace(/[,\s]/g, ''))
    return Number.isFinite(parsed) ? parsed : 0
  }

  private today(): string {
    const now = new Date()
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    return `${now.getFullYear()}${month}${day}`
  }

  // ───────────────────────────── 연결 ─────────────────────────────

  async connect(host: string, appkey: string, secretkey: string): Promise<void> {
    this.config = { host: host.replace(/\/$/, ''), appkey, secretkey }

    this.axiosInstance = axios.create({
      baseURL: this.config.host,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    })

    try {
      await this.getAccessToken()
    } catch (error) {
      // 토큰 발급 실패 시 config를 남기면 identity()가 살아 있어
      // 다른 사용자가 같은 계정으로 연결하지 못한다 (유령 점유).
      this.config = null
      this.axiosInstance = null
      this.connected = false
      throw error
    }
    this.connected = true
  }

  /** 이 서비스가 어떤 appkey로 연결돼 있는지 (중복 연결 판별용) */
  getAppKey(): string | null {
    return this.config?.appkey?.trim() || null
  }

  /** 어떤 계좌(host+appkey)에 실제로 연결돼 있는지 식별자 (미연결이면 null) */
  identity(): string | null {
    if (!this.config || !this.connected) return null
    return `${this.config.host}::${this.config.appkey.trim()}`
  }

  /** OAuth 2.0 접근토큰 발급 (POST /oauth2/token) */
  private async getAccessToken(): Promise<void> {
    if (!this.config) throw new Error('키움증권 API 설정이 없습니다')

    try {
      const response = await axios.post(
        `${this.config.host}/oauth2/token`,
        {
          grant_type: 'client_credentials',
          appkey: this.config.appkey.trim(),
          secretkey: this.config.secretkey.trim(),
        },
        { headers: { 'Content-Type': 'application/json;charset=UTF-8' } }
      )

      if (!response.data?.token) {
        throw new Error(response.data?.return_msg || '토큰 발급 실패: 응답에 token 없음')
      }

      // expires_dt: YYYYMMDDHHmmss
      const expiresDt = String(response.data.expires_dt || '')
      const expiresAt = expiresDt.length >= 14
        ? new Date(
            Number(expiresDt.slice(0, 4)),
            Number(expiresDt.slice(4, 6)) - 1,
            Number(expiresDt.slice(6, 8)),
            Number(expiresDt.slice(8, 10)),
            Number(expiresDt.slice(10, 12)),
            Number(expiresDt.slice(12, 14))
          ).getTime()
        : Date.now() + 12 * 60 * 60 * 1000

      this.accessToken = { token: response.data.token, expires_at: expiresAt }
      console.log('키움증권 접근토큰 발급 성공 (만료:', new Date(expiresAt).toLocaleString(), ')')
    } catch (error: any) {
      const detail = error.response?.data?.return_msg || error.response?.data?.error_description || error.message
      console.error('접근토큰 발급 오류:', detail)
      throw new Error(`토큰 발급 실패: ${detail}`)
    }
  }

  isConnected(): boolean {
    return this.connected && this.axiosInstance !== null && this.accessToken !== null
  }

  isMockApi(): boolean {
    return this.config?.host?.includes('mockapi') || false
  }

  async disconnect(): Promise<void> {
    this.disconnectWebSocket()
    this.config = null
    this.axiosInstance = null
    this.accessToken = null
    this.connected = false
    this.cachedAccountList = null
    this.portfolioCache = null
    console.log('키움증권 API 연결 해제 완료')
  }

  // ───────────────────────────── 공통 요청 ─────────────────────────────

  /**
   * TR별 최소 호출 간격을 보장하며 요청을 직렬화한다.
   * 같은 TR은 순서대로, 간격을 지켜 실행하고 다른 TR은 서로 막지 않는다.
   */
  private async request(
    endpoint: string,
    trId: string,
    body: any = {},
    method: 'GET' | 'POST' = 'POST'
  ): Promise<any> {
    const minInterval = this.trInterval(trId)
    const run = async (): Promise<any> => {
      const last = this.trLastCall.get(trId) || 0
      const wait = minInterval - (Date.now() - last)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      this.trLastCall.set(trId, Date.now())

      return this.sendRequest(endpoint, trId, body, method)
    }

    const previous = this.trQueues.get(trId) || Promise.resolve()
    const queued = previous.then(run, run)
    // 실패해도 체인이 끊기지 않게
    this.trQueues.set(trId, queued.catch(() => undefined))
    return queued
  }

  private async sendRequest(
    endpoint: string,
    trId: string,
    body: any,
    method: 'GET' | 'POST'
  ): Promise<any> {
    if (!this.axiosInstance) throw new Error('키움증권 API에 연결되지 않았습니다')

    // 토큰 만료 임박 시 재발급 (30초 여유)
    if (!this.accessToken || this.accessToken.expires_at - 30000 < Date.now()) {
      await this.getAccessToken()
    }

    try {
      const response = await this.axiosInstance.request({
        method,
        url: endpoint,
        data: method === 'POST' ? body : undefined,
        params: method === 'GET' ? body : undefined,
        headers: {
          'api-id': trId,
          authorization: `Bearer ${this.accessToken!.token}`,
          'Content-Type': 'application/json;charset=UTF-8',
          'cont-yn': 'N',
          'next-key': '',
        },
      })

      const data = response.data
      // 키움은 업무 오류도 HTTP 200으로 내려준다 → return_code를 반드시 확인
      if (data && data.return_code !== undefined && data.return_code !== 0) {
        const error: any = new Error(data.return_msg || `API 오류 (return_code: ${data.return_code})`)
        error.return_code = data.return_code
        error.response = { data, status: 400 }
        throw error
      }
      return data
    } catch (error: any) {
      if (error.return_code === undefined && error.response?.status === 401) {
        await this.getAccessToken()
        throw new Error('토큰이 만료되었습니다. 다시 시도해주세요.')
      }
      // 429(요청 한도 초과)는 다음 호출이 밀리지 않도록 간격을 더 벌린다
      if (error.response?.status === 429) {
        this.trLastCall.set(trId, Date.now() + 1000)
        const rateError: any = new Error('키움 API 요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.')
        rateError.isRateLimit = true
        rateError.return_code = 5
        throw rateError
      }
      throw error
    }
  }

  // ───────────────────────────── 시세 ─────────────────────────────

  /**
   * 종목 리스트 조회 (전일대비등락률 상위, ka10027)
   * @param market '0': 코스피, '10': 코스닥, 그 외: 전체
   */
  async getStockList(market: string = '0'): Promise<any[]> {
    const mrktTp = market === '0' ? '001' : market === '10' ? '101' : '000'

    try {
      const data = await this.request('/api/dostk/rkinfo', 'ka10027', { ...RANKING_PARAMS.ka10027, mrkt_tp: mrktTp })
      const rows: any[] = data?.pred_pre_flu_rt_upper || []

      return rows.map((item: any) => ({
        code: String(item.stk_cd || '').trim(),
        name: item.stk_nm || '',
        price: Math.abs(this.num(item.cur_prc)),
        change: this.num(item.pred_pre),
        changePercent: this.num(item.flu_rt),
        volume: this.num(item.now_trde_qty),
      })).filter((s) => s.code)
    } catch (error: any) {
      console.error('[종목 리스트] 조회 실패:', error.message)
      return []
    }
  }

  /**
   * 종목명/코드 검색 (ka10099 주식종목정보 — 전종목 목록을 받아 필터)
   * 전종목 목록은 자주 바뀌지 않으므로 10분 캐시한다.
   */
  private stockMasterCache: { at: number; list: { code: string; name: string }[] } | null = null

  private async getStockMaster(): Promise<{ code: string; name: string }[]> {
    if (this.stockMasterCache && Date.now() - this.stockMasterCache.at < 10 * 60 * 1000) {
      return this.stockMasterCache.list
    }

    const list: { code: string; name: string }[] = []
    for (const mrkt of ['0', '10']) {
      try {
        const data = await this.request('/api/dostk/stkinfo', 'ka10099', { mrkt_tp: mrkt })
        const rows: any[] = data?.list || []
        for (const item of rows) {
          const code = String(item.stk_cd || item.code || '').trim()
          const name = String(item.stk_nm || item.name || '').trim()
          if (code && name) list.push({ code, name })
        }
      } catch (error: any) {
        console.error(`[종목 검색] 시장 ${mrkt} 목록 조회 실패:`, error.message)
      }
    }
    if (list.length > 0) this.stockMasterCache = { at: Date.now(), list }
    return list
  }

  async searchStocks(keyword: string, limit = 30): Promise<{ code: string; name: string }[]> {
    const q = keyword.trim().toUpperCase()
    if (!q) return []

    const source = await this.getStockMaster()
    return source
      .filter((s) => s.name.toUpperCase().includes(q) || s.code.includes(q))
      .slice(0, limit)
  }

  /** 종목 현재가 조회 (ka10001 주식기본정보) */
  async getCurrentPrice(code: string): Promise<any> {
    const data = await this.request('/api/dostk/stkinfo', 'ka10001', { stk_cd: code })

    return {
      code: data.stk_cd || code,
      name: data.stk_nm || '',
      price: Math.abs(this.num(data.cur_prc)),
      change: this.num(data.pred_pre),
      changePercent: this.num(data.flu_rt),
      volume: this.num(data.trde_qty),
      시가: Math.abs(this.num(data.open_pric)),
      고가: Math.abs(this.num(data.high_pric)),
      저가: Math.abs(this.num(data.low_pric)),
      상한가: Math.abs(this.num(data.upl_pric)),
      하한가: Math.abs(this.num(data.lst_pric)), // lst_pric은 하한가다 (last price 아님)
    }
  }

  /** 여러 종목 현재가 조회 (ka10095 배치 — 1회 호출로 최대 수십 종목) */
  async getMultipleCurrentPrices(codes: string[]): Promise<any[]> {
    if (!codes || codes.length === 0) return []

    const results: any[] = []
    // ka10095는 종목코드를 '|'로 구분해 한 번에 조회한다.
    // 종목별로 ka10001을 반복하면 큐 간격 때문에 수십 초가 걸려 타임아웃된다.
    const batchSize = 30
    for (let i = 0; i < codes.length; i += batchSize) {
      const batch = codes.slice(i, i + batchSize)
      try {
        const data = await this.request('/api/dostk/stkinfo', 'ka10095', {
          stk_cd: batch.join('|'),
        })
        const rows: any[] = data?.atn_stk_infr || []

        for (const item of rows) {
          const code = String(item.stk_cd || '').trim()
          if (!code) continue
          results.push({
            code,
            name: item.stk_nm || '',
            price: Math.abs(this.num(item.cur_prc)),
            change: this.num(item.pred_pre),
            changePercent: this.num(item.flu_rt),
            volume: this.num(item.trde_qty),
            시가: Math.abs(this.num(item.open_pric)),
            고가: Math.abs(this.num(item.high_pric)),
            저가: Math.abs(this.num(item.low_pric)),
            openPrice: Math.abs(this.num(item.open_pric)),
            highPrice: Math.abs(this.num(item.high_pric)),
            prevClose: Math.abs(this.num(item.cur_prc)) - this.num(item.pred_pre),
          })
        }
      } catch (error: any) {
        console.error(`[다종목 현재가] ${batch.length}개 조회 실패:`, error.message)
      }
    }
    return results
  }

  /**
   * 차트 데이터 조회
   * @param period 'day' | 'tick' | 'min' | '3' | '5' | '15' | '30' | '45' | '60'
   * @returns 최신 봉이 앞에 오는 배열 [{ 일자, 시가, 고가, 저가, 종가, 거래량 }]
   */
  async getCandleData(
    code: string,
    period: string = 'min',
    start: string = '',
    end: string = ''
  ): Promise<any[]> {
    const kind = period === 'day' ? 'day' : period === 'tick' ? 'tick' : 'min'
    const spec = CHART_TR[kind]

    const body: any = { stk_cd: code, upd_stkpc_tp: '1' }
    if (kind === 'tick') {
      body.tic_scope = '1'
    } else {
      if (kind === 'min') body.tic_scope = MINUTE_SCOPE[period] || '1'
      // 일봉은 base_dt 필수, 분봉은 선택
      const baseDt = String(end || start || '').replace(/[^0-9]/g, '').slice(0, 8) || this.today()
      body.base_dt = baseDt
    }

    // 호출 간격은 request()의 TR별 큐가 보장한다 (모의투자는 초당 1회)
    const data = await this.request('/api/dostk/chart', spec.trId, body)
    const rows: any[] = data?.[spec.key] || []

    // 키움은 최신 봉을 앞에 준다. 전략 함수들이 candles[0]을 최신 봉으로 쓰므로 이 순서를 유지한다.
    // 차트 렌더링 쪽에서만 reverse()로 과거→최신으로 뒤집는다.
    return rows
      .map((item: any) => ({
        일자: String(item[spec.timeField] || ''),
        시가: Math.abs(this.num(item.open_pric)),
        고가: Math.abs(this.num(item.high_pric)),
        저가: Math.abs(this.num(item.low_pric)),
        종가: Math.abs(this.num(item.cur_prc)),
        거래량: this.num(item.trde_qty),
      }))
      .filter((candle) => candle.일자 && candle.종가 > 0)
  }

  // ───────────────────────────── 계좌 ─────────────────────────────

  /** 계좌번호 조회 (ka00001) */
  async getAccountList(): Promise<string[]> {
    if (this.cachedAccountList && Date.now() - this.accountListCacheTime < 5 * 60 * 1000) {
      return this.cachedAccountList
    }

    try {
      const data = await this.request('/api/dostk/acnt', 'ka00001', {})
      const acctNo = String(data?.acctNo || '').trim()
      this.cachedAccountList = acctNo ? [acctNo] : []
      this.accountListCacheTime = Date.now()
      return this.cachedAccountList
    } catch (error: any) {
      console.error('[계좌번호 조회] 실패:', error.message)
      return []
    }
  }

  clearAccountListCache(): void {
    this.cachedAccountList = null
    this.accountListCacheTime = 0
  }

  /**
   * 예수금/잔고/보유종목을 한 번에 조회 (kt00001 + kt00018)
   * 두 TR 모두 초당 1회 제한이라 3초 캐시로 중복 호출을 막는다.
   */
  private async getPortfolio(): Promise<any> {
    if (this.portfolioCache && Date.now() - this.portfolioCache.at < 3000) {
      return this.portfolioCache.data
    }

    const [depositRes, balanceRes] = await Promise.all([
      this.request('/api/dostk/acnt', 'kt00001', { qry_tp: '3' }).catch((error: any) => {
        console.error('[예수금 조회] 실패:', error.message)
        return null
      }),
      this.request('/api/dostk/acnt', 'kt00018', { qry_tp: '1', dmst_stex_tp: 'KRX' }).catch((error: any) => {
        console.error('[잔고 조회] 실패:', error.message)
        return null
      }),
    ])

    const deposit = this.num(depositRes?.entr)
    const orderable = this.num(depositRes?.ord_alow_amt)
    const rawHoldings: any[] = balanceRes?.acnt_evlt_remn_indv_tot || []

    // 같은 종목이 신용구분별로 여러 줄로 올 수 있으므로 종목코드 기준으로 합산
    const merged = new Map<string, any>()
    for (const row of rawHoldings) {
      // 키움은 종목코드 앞에 시장 구분 문자를 붙여 내려준다 (A001527, A36328K ...).
      // 알파벳을 하나만 떼면 'K' 같은 잔여 문자가 남아 같은 종목이 다른 코드로 갈라진다.
      // 숫자 6자리만 남겨 정규화한다 (예: 'A001527' → '001527', 'A36328K' → '36328K')
      const rawCode = String(row.stk_cd || '').trim()
      const code = rawCode.replace(/^[A-Za-z]+/, '').replace(/\s/g, '')
      const quantity = this.num(row.rmnd_qty)
      if (!code || quantity <= 0) continue

      // trde_able_qty = 매도가능수량 (미체결 매도 주문이 잡아둔 수량은 제외된 값)
      const sellable = this.num(row.trde_able_qty)

      const purchaseAmount = this.num(row.pur_pric) * quantity
      const existing = merged.get(code)
      if (existing) {
        existing.quantity += quantity
        existing.sellableQuantity += sellable
        existing.purchaseAmount += purchaseAmount
        existing.evaluation += this.num(row.evlt_amt)
      } else {
        merged.set(code, {
          code,
          name: row.stk_nm || code,
          quantity,
          sellableQuantity: sellable,
          purchaseAmount,
          evaluation: this.num(row.evlt_amt),
          currentPrice: Math.abs(this.num(row.cur_prc)),
        })
      }
    }

    const holdings = Array.from(merged.values()).map((h: any) => {
      // 평균단가를 반올림하면 수량을 곱할 때 오차가 커진다.
      // 화면 표시용으로만 반올림하고, 매입금액은 원본 값을 그대로 함께 내려준다.
      const rawPurchasePrice = h.quantity > 0 ? h.purchaseAmount / h.quantity : 0
      const purchasePrice = Math.round(rawPurchasePrice)
      const profit = h.currentPrice * h.quantity - h.purchaseAmount
      return {
        code: h.code,
        name: h.name,
        quantity: h.quantity,
        // 매도가능수량: 미체결 매도 주문이 잡아둔 수량이 차감된 실제 주문 가능 수량.
        // 이 값으로 매도 수량을 제한하지 않으면 800033(매도가능수량 부족)으로 거부된다.
        sellableQuantity: h.sellableQuantity,
        purchasePrice,
        purchaseAmount: Math.round(h.purchaseAmount), // 정확한 매입금액 (합계 검증용)
        avgPrice: purchasePrice,
        currentPrice: h.currentPrice,
        evaluation: h.evaluation,
        profit: Math.round(profit),
        profitPercent: h.purchaseAmount > 0 ? Number(((profit / h.purchaseAmount) * 100).toFixed(2)) : 0,
      }
    })

    // 같은 종목이 코드만 다르게(신용/현금, 구코드/신코드) 내려오는 경우가 있어
    // 종목명 기준으로 한 번 더 병합한다. 표에 같은 이름이 여러 줄로 보이는 것을 막는다.
    const byName = new Map<string, any>()
    for (const h of holdings) {
      const key = (h.name || h.code).replace(/\s/g, '')      const existing = byName.get(key)
      if (!existing) {
        byName.set(key, { ...h })
        continue
      }
      const totalQty = existing.quantity + h.quantity
      const totalPurchase = existing.purchaseAmount + h.purchaseAmount
      existing.quantity = totalQty
      existing.sellableQuantity += h.sellableQuantity
      existing.purchaseAmount = totalPurchase
      existing.evaluation += h.evaluation
      existing.purchasePrice = totalQty > 0 ? Math.round(totalPurchase / totalQty) : existing.purchasePrice
      existing.avgPrice = existing.purchasePrice
      existing.profit = existing.evaluation - totalPurchase
      existing.profitPercent = totalPurchase > 0
        ? Number(((existing.profit / totalPurchase) * 100).toFixed(2))
        : 0
    }
    const mergedByName = Array.from(byName.values())
    if (mergedByName.length !== holdings.length) {
      console.log(`[잔고] 같은 종목명 병합: ${holdings.length}개 → ${mergedByName.length}개`)
      // 어떤 코드가 하나로 합쳐졌는지 남긴다 (중복 원인 추적용)
      const codeGroups = new Map<string, string[]>()
      for (const h of holdings) {
        const nameKey = (h.name || h.code).replace(/\s/g, '')
        const list = codeGroups.get(nameKey) || []
        list.push(`${h.code}(${h.quantity}주)`)
        codeGroups.set(nameKey, list)
      }
      for (const [name, codes] of codeGroups) {
        if (codes.length > 1) console.log(`[잔고] 중복 병합 — ${name}: ${codes.join(' + ')}`)
      }
    }
    const finalHoldings = mergedByName

    // kt00018 응답에는 종목별 합계 필드가 없는 경우가 있다(모의투자).
    // 그럴 때는 방금 합산한 보유종목 값으로 계산해 화면 합계와 반드시 일치시킨다.
    const sumPurchaseAmount = finalHoldings.reduce((sum: number, h: any) => sum + (h.purchaseAmount || 0), 0)
    const sumEvaluation = finalHoldings.reduce((sum: number, h: any) => sum + (h.evaluation || 0), 0)
    const sumProfit = finalHoldings.reduce((sum: number, h: any) => sum + (h.profit || 0), 0)

    const apiPurchase = this.num(balanceRes?.tot_pur_amt)
    const apiStockValue = this.num(balanceRes?.tot_evlt_amt)

    const totalPurchase = apiPurchase > 0 ? apiPurchase : sumPurchaseAmount
    const totalStockValue = apiStockValue > 0 ? apiStockValue : sumEvaluation
    // 손익은 종목별 합계를 신뢰한다.
    // (kt00018의 tot_evlt_pl은 수수료·세금 반영 등으로 종목 합과 어긋나
    //  화면의 총매입금액·총평가금액과 앞뒤가 맞지 않게 된다)
    const totalProfit = sumProfit

    const data = {
      deposit,
      orderable,
      holdings: finalHoldings,
      totalPurchase,
      totalStockValue,
      totalAsset: deposit + totalStockValue,
      totalProfit,
      totalProfitRate: totalPurchase > 0 ? Number(((totalProfit / totalPurchase) * 100).toFixed(2)) : 0,
      depositError: depositRes ? undefined : '예수금 조회에 실패했습니다',
      balanceError: balanceRes ? undefined : '잔고 조회에 실패했습니다',
    }

    this.portfolioCache = { at: Date.now(), data }
    return data
  }

  /** 예수금 조회 */
  async getDeposit(): Promise<any> {
    const portfolio = await this.getPortfolio()
    return {
      deposit: portfolio.deposit,
      orderable: portfolio.orderable,
      error: portfolio.depositError,
    }
  }

  /** 계좌 정보 조회 (기존 응답 형식 유지) */
  async getAccountInfo(_accountNo?: string, _accountProductCode?: string): Promise<any> {
    const portfolio = await this.getPortfolio()

    return {
      output1: portfolio.holdings,
      output2: {
        DNCA_TOT_AMT: portfolio.deposit, // 예수금
        TOT_EVAL_AMT: portfolio.totalAsset, // 추정예탁자산
        EVAL_PNLS_AMT: portfolio.totalProfit, // 총평가손익
        EVAL_PNLS_RT: portfolio.totalProfitRate, // 총수익률
      },
      error: portfolio.depositError && portfolio.balanceError
        ? `${portfolio.depositError} / ${portfolio.balanceError}`
        : undefined,
    }
  }

  /** 보유 종목 조회 (kt00018) */
  async getBalance(): Promise<any> {
    const portfolio = await this.getPortfolio()
    if (portfolio.balanceError) {
      return { error: portfolio.balanceError, stocks: [] }
    }
    // 종목 목록 + 합계를 함께 반환한다.
    // 배열만 반환하면 라우트에서 totalPurchase/totalProfit 을 꺼낼 수 없어
    // 화면 합계가 0이 되거나 종목별 재계산과 어긋난다.
    return {
      stocks: portfolio.holdings,
      totalPurchase: portfolio.totalPurchase,
      totalStockValue: portfolio.totalStockValue,
      totalAsset: portfolio.totalAsset,
      totalProfit: portfolio.totalProfit,
      totalProfitRate: portfolio.totalProfitRate,
      deposit: portfolio.deposit,
      orderable: portfolio.orderable,
    }
  }

  // ───────────────────────────── 주문 ─────────────────────────────

  /**
   * 주문 전송 (kt10000 매수 / kt10001 매도)
   * 모의투자는 KRX만 지원하므로 dmst_stex_tp는 항상 KRX.
   * 지정가는 trde_tp='0' + ord_uv 가격, 시장가는 trde_tp='3' + ord_uv 빈값.
   */
  async placeOrder(order: OrderRequest, _accountNo?: string, _accountProductCode?: string): Promise<any> {
    const stockCode = String(order.code).trim()
    if (!/^\d{6}$/.test(stockCode)) {
      throw new Error(`지원하지 않는 종목코드 형식입니다: ${stockCode} (6자리 숫자만 지원)`)
    }

    const quantity = Math.floor(Number(order.quantity))
    if (!quantity || quantity <= 0) {
      throw new Error('주문 수량은 1 이상이어야 합니다')
    }

    const isLimit = order.order_option === '00'
    const price = Math.floor(Number(order.price) || 0)
    if (isLimit && price <= 0) {
      throw new Error('지정가 주문 시 주문 가격이 필요합니다')
    }

    const trId = order.order_type === 'buy' ? 'kt10000' : 'kt10001'
    const body = {
      dmst_stex_tp: 'KRX',
      stk_cd: stockCode,
      ord_qty: String(quantity),
      ord_uv: isLimit ? String(price) : '',
      trde_tp: isLimit ? '0' : '3', // 0: 보통(지정가), 3: 시장가
      cond_uv: '',
    }

    console.log(`[주문] ${trId} ${stockCode} ${quantity}주 ${isLimit ? `지정가 ${price}원` : '시장가'}`)

    try {
      const data = await this.request('/api/dostk/ordr', trId, body)
      const orderNumber = String(data?.ord_no || '')
      if (!orderNumber) {
        throw new Error(data?.return_msg || '주문번호를 받지 못했습니다')
      }

      console.log(`[주문] 접수 완료 - 주문번호: ${orderNumber}`)
      return {
        orderNumber,
        orderTime: new Date().toLocaleTimeString('ko-KR'),
        success: true,
        message: data?.return_msg || '주문이 접수되었습니다',
      }
    } catch (error: any) {
      const message = error.message || '주문 전송 실패'
      // 원인 파악이 가능하도록 Kiwoom 응답 코드/메시지를 그대로 남긴다
      console.error(`[주문] 실패 - ${stockCode}: ${message} (return_code=${error.return_code ?? 'N/A'})`)

      const wrapped: any = new Error(message)
      wrapped.returnCode = error.return_code
      wrapped.stockCode = stockCode
      // 원본 응답(상태코드/본문)을 보존해야 라우트가 500으로 뭉개지 않는다
      wrapped.response = error.response
      wrapped.status = error.status
      wrapped.isRateLimit = error.isRateLimit
      wrapped.isTradingRestricted = message.includes('매매제한') || message.includes('RC4007')
      if (wrapped.isTradingRestricted) {
        wrapped.isMockApiLimit = true
      }
      throw wrapped
    }
  }

  /**
   * 주문 취소 (kt10003)
   * @param orderNumber 원주문번호
   * @param stockCode 종목코드
   * @param quantity 취소수량 (원주문 수량)
   */
  async cancelOrder(orderNumber: string, stockCode: string, quantity: number): Promise<any> {
    const ordNo = String(orderNumber || '').trim()
    const code = String(stockCode || '').trim()
    if (!ordNo) throw new Error('취소할 원주문번호가 없습니다')
    if (!/^\d{6}$/.test(code)) throw new Error(`지원하지 않는 종목코드 형식입니다: ${code}`)
    const qty = Math.floor(Number(quantity) || 0)
    if (qty <= 0) throw new Error('취소 수량은 1 이상이어야 합니다')

    const body = {
      dmst_stex_tp: 'KRX',
      orig_ord_no: ordNo,
      stk_cd: code,
      cncl_qty: String(qty),
    }

    console.log(`[주문취소] kt10003 ${code} ${qty}주 (원주문: ${ordNo})`)

    try {
      const data = await this.request('/api/dostk/ordr', 'kt10003', body)
      const cancelNumber = String(data?.cncl_ord_no || data?.ord_no || '')
      if (!cancelNumber) {
        throw new Error(data?.return_msg || '취소주문번호를 받지 못했습니다')
      }
      console.log(`[주문취소] 접수 완료 - 취소주문번호: ${cancelNumber}`)
      return {
        success: true,
        cancelOrderNumber: cancelNumber,
        message: data?.return_msg || '취소 주문이 접수되었습니다',
      }
    } catch (error: any) {
      const message = error.message || '주문 취소 실패'
      console.error(`[주문취소] 실패 - ${code} (원주문 ${ordNo}): ${message} (return_code=${error.return_code ?? 'N/A'})`)
      const wrapped: any = new Error(message)
      wrapped.returnCode = error.return_code
      wrapped.stockCode = code
      wrapped.response = error.response
      throw wrapped
    }
  }

  /** 주문 내역 조회 (kt00007 계좌별주문체결내역상세) */
  async getOrderHistory(_accountNo?: string): Promise<any[]> {
    const body = {
      ord_dt: '',
      qry_tp: '2', // 2: 역순
      stk_bond_tp: '0', // 0: 전체
      sell_tp: '0', // 0: 전체
      stk_cd: '',
      fr_ord_no: '',
      dmst_stex_tp: '%', // 전체
    }

    try {
      const data = await this.request('/api/dostk/acnt', 'kt00007', body)
      const rows: any[] = data?.acnt_ord_cntr_prps_dtl || []
      const today = new Date().toLocaleDateString('ko-KR')

      return rows.map((item: any, index: number) => {
        const quantity = this.num(item.ord_qty)
        const filled = this.num(item.cntr_qty)
        const remaining = this.num(item.ord_remnq)
        const mdfy = String(item.mdfy_cncl || '')
        // mdfy_cncl에는 '취소' 외에 '정정', '취소확인' 등이 올 수 있으므로 포함 여부로 판정
        const isCancelled = mdfy.includes('취소')

        // 체결 0 + 잔량 0 은 더 이상 취소할 수량이 없는 종료된 주문이다.
        // 이걸 '접수'로 두면 자동취소가 계속 RC4033(취소할 수량 없음)으로 실패한다.
        const status = isCancelled
          ? '취소'
          : filled > 0 && remaining === 0
            ? '체결'
            : filled > 0
              ? '부분체결'
              : remaining > 0
                ? '접수'
                : '종료'

        return {
          id: index + 1,
          date: today,
          time: item.ord_tm || '',
          type: status === '취소' ? 'cancel' : String(item.io_tp_nm || '').includes('매도') ? 'sell' : 'buy',
          stockName: item.stk_nm || '',
          stockCode: String(item.stk_cd || '').replace(/^[A-Za-z]+/, '').replace(/\s/g, ''),
          quantity,
          price: filled > 0 ? this.num(item.cntr_uv) : this.num(item.ord_uv),
          orderPrice: this.num(item.ord_uv),
          filledQuantity: filled,
          unfilledQuantity: remaining,
          status,
          isExecuted: status === '체결' || status === '부분체결',
          orderNumber: item.ord_no || '',
        }
      })
    } catch (error: any) {
      console.error('[주문 내역] 조회 실패:', error.message)
      return []
    }
  }

  // ───────────────────────────── 순위정보 (조건검색) ─────────────────────────────

  /**
   * 순위정보 조회
   * @param trId ka10023(거래량급증) / ka10027(등락률상위) / ka10030(당일거래량상위)
   *             / ka10031(전일거래량상위) / ka10032(거래대금상위)
   */
  async getRankingInfo(trId: string, params?: any): Promise<any> {
    const baseParams = RANKING_PARAMS[trId]
    if (!baseParams) {
      return { output: [], return_code: -1, return_msg: `지원하지 않는 TR입니다: ${trId}` }
    }

    try {
      const data = await this.request('/api/dostk/rkinfo', trId, { ...baseParams, ...(params || {}) })

      // TR마다 응답 배열 키가 다르므로 첫 번째 배열을 사용
      const rows: any[] = Object.values(data || {}).find((value) => Array.isArray(value)) || []

      const output = rows.map((item: any) => {
        const code = String(item.stk_cd || '').trim()
        const price = Math.abs(this.num(item.cur_prc))
        const change = this.num(item.pred_pre)
        // ka10020/21/22/31/32는 등락률(flu_rt)을 주지 않으므로 전일대비로 계산
        const prevPrice = price - change
        const changePercent = item.flu_rt !== undefined
          ? this.num(item.flu_rt)
          : prevPrice > 0
            ? Number(((change / prevPrice) * 100).toFixed(2))
            : 0
        const volume = this.num(item.now_trde_qty || item.trde_qty || item.now)

        return {
          stk_cd: code,
          stk_nm: item.stk_nm || '',
          // 기존 클라이언트가 참조하는 별칭 유지
          code,
          name: item.stk_nm || '',
          prc: String(price),
          price,
          pred_pre: change,
          prdy_chng_rt: String(changePercent),
          changePercent,
          acml_vol: String(volume),
          volume,
          // 시가/고가(없는 TR도 있어 클라이언트에서 보강한다)
          openPrice: item.open_pric !== undefined ? Math.abs(this.num(item.open_pric)) : undefined,
          highPrice: item.high_pric !== undefined ? Math.abs(this.num(item.high_pric)) : undefined,
          lowPrice: item.low_pric !== undefined ? Math.abs(this.num(item.low_pric)) : undefined,
        }
      }).filter((item) => item.stk_cd)

      return { output, return_code: 0, return_msg: data?.return_msg || '정상적으로 처리되었습니다' }
    } catch (error: any) {
      console.error(`[${trId}] 순위정보 조회 실패:`, error.message)
      return { output: [], return_code: -1, return_msg: error.message }
    }
  }

  // ───────────────────────────── 실시간 (WebSocket) ─────────────────────────────

  async connectWebSocket(): Promise<void> {
    if (!this.config) {
      throw new Error('키움증권 API에 연결되지 않았습니다')
    }

    // 재연결 시 만료된 토큰을 그대로 쓰면 로그인이 계속 실패한다
    if (!this.accessToken || this.accessToken.expires_at - 60000 < Date.now()) {
      await this.getAccessToken()
    }

    const isMock = this.config.host.includes('mockapi')
    const socketBase = isMock ? 'wss://mockapi.kiwoom.com:10000' : 'wss://api.kiwoom.com:10000'

    // ⚠️ 여기서 new로 새 인스턴스를 만들면 이미 등록된 실시간 콜백이 죽은 인스턴스에 남는다.
    //    (onRealTimeData가 먼저 호출되는 경우가 일반적이다)
    if (!this.webSocketService) {
      this.webSocketService = new KiwoomWebSocketService()
    }

    // 이미 연결·로그인돼 있으면 새로 붙이지 않는다
    if (this.webSocketService.isConnected()) {
      return
    }

    // 공식 가이드는 /api/websocket, 구버전 문서는 /api/dostk/websocket → 순차 시도
    const paths = ['/api/websocket', '/api/dostk/websocket']
    let lastError: any = null
    for (const path of paths) {
      try {
        await this.webSocketService.connect(
          `${socketBase}${path}`,
          this.accessToken!.token,
          // 재연결 시 항상 유효한 토큰을 받도록 공급자 주입
          async () => {
            if (!this.accessToken || this.accessToken.expires_at - 60000 < Date.now()) {
              await this.getAccessToken()
            }
            return this.accessToken!.token
          }
        )
        // 계좌 주문체결(00)은 종목코드 없이 계좌 전체 수신 (grp_no 9는 시세 그룹과 겹치지 않게)
        this.webSocketService.registerRealTime([''], ['00'], '9', '0')
        return
      } catch (error: any) {
        lastError = error
      }
    }
    throw lastError
  }

  /** 실시간 시세 등록 (0B 주식체결, 100종목/그룹) */
  registerRealTimeStocks(codes: string[]): void {
    if (!this.webSocketService || !this.webSocketService.isConnected()) {
      console.warn('[WebSocket] WebSocket이 연결되지 않았습니다.')
      return
    }

    // refresh='0'은 해당 그룹의 기존 등록을 해지한다.
    // 신규 종목만 보내면서 '0'을 쓰면 이전 종목 시세가 끊기므로,
    // 누적 목록 전체를 다시 등록한다.
    codes.filter(Boolean).forEach((code) => this.registeredRealtimeCodes.add(code))
    const all = Array.from(this.registeredRealtimeCodes)
    if (all.length === 0) return

    // 키움 실시간 등록 한도는 200종목. 초과분은 오래된 것부터 버린다.
    const MAX_TOTAL = 200
    while (all.length > MAX_TOTAL) {
      const oldest = all.shift()!
      this.registeredRealtimeCodes.delete(oldest)
    }

    const MAX_ITEMS_PER_GROUP = 100
    for (let i = 0; i < all.length; i += MAX_ITEMS_PER_GROUP) {
      const groupCodes = all.slice(i, i + MAX_ITEMS_PER_GROUP)
      const groupNo = String(Math.floor(i / MAX_ITEMS_PER_GROUP) + 1)
      // 첫 그룹만 '0'(초기화), 이후 그룹은 '1'(누적)
      this.webSocketService.registerRealTime(groupCodes, ['0B'], groupNo, i === 0 ? '0' : '1')
    }

    // refresh='0'은 그룹 1의 기존 등록을 해지하므로, 누적 목록 전체를 다시 보낸다.
    // (그룹 9 계좌 주문체결 등록은 그룹이 달라 영향받지 않는다)
  }

  onRealTimeData(callback: (data: any) => void): () => void {
    if (!this.webSocketService) {
      this.webSocketService = new KiwoomWebSocketService()
    }
    return this.webSocketService.onRealTimeData(callback)
  }

  disconnectWebSocket(): void {
    this.webSocketService?.disconnect()
    // 끊기면 서버측 등록 상태도 초기화된다 (재연결 시 replay는 WS 서비스가 담당)
    this.registeredRealtimeCodes.clear()
  }

  isWebSocketConnected(): boolean {
    return this.webSocketService?.isConnected() || false
  }
}
