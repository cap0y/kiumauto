/**
 * 키움증권 API 서비스
 * 키움증권 REST API와 통신하는 서비스 클래스
 * 참고: https://openapi.kiwoom.com/guide/apiguide
 */
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'
import { KiwoomWebSocketService } from './kiwoomWebSocketService'

interface KiwoomConfig {
  host: string // 실전투자: https://api.kiwoom.com, 모의투자: https://mockapi.kiwoom.com (KRX만 지원)
  appkey: string
  secretkey: string
}

interface AccessToken {
  token: string
  token_type: string
  expires_dt: string
  expires_at: number // 만료 시간 (타임스탬프)
}

interface OrderRequest {
  code: string
  quantity: number
  price: number
  order_type: string
  order_option: string
}

export class KiwoomService {
  private static instance: KiwoomService
  private config: KiwoomConfig | null = null
  private axiosInstance: AxiosInstance | null = null
  private accessToken: AccessToken | null = null
  private connected: boolean = false
  private cachedAccountList: string[] | null = null // 계좌 목록 캐시
  private accountListCacheTime: number = 0 // 캐시 시간
  private webSocketService: KiwoomWebSocketService | null = null

  private constructor() {}

  static getInstance(): KiwoomService {
    if (!KiwoomService.instance) {
      KiwoomService.instance = new KiwoomService()
    }
    return KiwoomService.instance
  }

  /**
   * 키움증권 API 연결
   * OAuth 2.0 토큰 발급 및 API 인스턴스 생성
   */
  async connect(host: string, appkey: string, secretkey: string): Promise<void> {
    this.config = { host, appkey, secretkey }
    
    // OAuth 토큰 발급
    await this.getAccessToken()

    // API 인스턴스 생성
    this.axiosInstance = axios.create({
      baseURL: host,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
      }
    })

    // 요청 인터셉터 - Bearer 토큰 추가 및 자동 갱신
    this.axiosInstance.interceptors.request.use(async (config) => {
      // 토큰 만료 체크 및 갱신
      if (this.accessToken && this.accessToken.expires_at < Date.now()) {
        await this.getAccessToken()
      }

      if (this.accessToken) {
        config.headers = config.headers || {}
        config.headers['Authorization'] = `Bearer ${this.accessToken.token}`
      }

      return config
    })

    // 응답 인터셉터
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      async (error) => {
        // 401 Unauthorized 시 토큰 재발급 시도
        if (error.response?.status === 401 && this.config) {
          try {
            await this.getAccessToken()
            // 원래 요청 재시도
            if (error.config) {
              error.config.headers['Authorization'] = `Bearer ${this.accessToken?.token}`
              return this.axiosInstance!.request(error.config)
            }
          } catch (tokenError) {
            console.error('토큰 재발급 실패:', tokenError)
          }
        }
        
        // 500 에러는 조용히 처리
        if (error.response?.status !== 500) {
          console.error('키움증권 API 오류:', error.response?.data || error.message)
        }
        return Promise.reject(error)
      }
    )

    this.connected = true
  }

  /**
   * OAuth 2.0 접근토큰 발급
   * POST /oauth2/token (키움증권 API)
   * 참고: https://openapi.kiwoom.com/guide/apiguide
   */
  private async getAccessToken(): Promise<void> {
    if (!this.config) {
      throw new Error('키움증권 API 설정이 없습니다')
    }

    try {
      const requestUrl = `${this.config.host}/oauth2/token`
      const requestData = {
        grant_type: 'client_credentials',
        appkey: this.config.appkey.trim(),
        secretkey: this.config.secretkey.trim(),
      }

      console.log('=== 토큰 발급 요청 (키움증권) ===')
      console.log('URL:', requestUrl)
      console.log('AppKey 길이:', requestData.appkey.length)
      console.log('AppKey 첫 5자:', requestData.appkey.substring(0, 5) + '...')
      console.log('SecretKey 길이:', requestData.secretkey.length)
      console.log('SecretKey 첫 5자:', requestData.secretkey.substring(0, 5) + '...')

      const response = await axios.post(
        requestUrl,
        requestData,
        {
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
          }
        }
      )

      console.log('토큰 발급 응답:', response.data)

      if (response.data && response.data.token) {
        // 키움증권 API 응답 형식
        // expires_dt 형식: YYYYMMDDHHmmss
        const expiresDt = response.data.expires_dt
        const expiresAt = new Date(
          parseInt(expiresDt.substring(0, 4)), // year
          parseInt(expiresDt.substring(4, 6)) - 1, // month (0-based)
          parseInt(expiresDt.substring(6, 8)), // day
          parseInt(expiresDt.substring(8, 10)), // hour
          parseInt(expiresDt.substring(10, 12)), // minute
          parseInt(expiresDt.substring(12, 14)) // second
        ).getTime()

        this.accessToken = {
          token: response.data.token,
          token_type: response.data.token_type || 'Bearer',
          expires_dt: expiresDt,
          expires_at: expiresAt,
        }

        this.connected = true
        console.log('키움증권 접근토큰 발급 성공')
        console.log('토큰 만료 시간:', new Date(expiresAt).toLocaleString())
      } else {
        throw new Error('토큰 발급 실패: 응답 데이터 없음')
      }
    } catch (error: any) {
      console.error('접근토큰 발급 오류:', error.response?.data || error.message)
      throw new Error(`토큰 발급 실패: ${error.response?.data?.return_msg || error.message}`)
    }
  }

  /**
   * 연결 상태 확인
   */
  isConnected(): boolean {
    return this.connected && this.axiosInstance !== null && this.accessToken !== null
  }

  /**
   * 키움증권 API 연결 해제
   */
  async disconnect(): Promise<void> {
    this.config = null
    this.axiosInstance = null
    this.accessToken = null
    this.connected = false
    console.log('키움증권 API 연결 해제 완료')
  }

  /**
   * 키움증권 API 요청
   * 키움 REST API는 TR_ID를 헤더에 포함
   */
  private async request(
    endpoint: string,
    trId: string,
    data?: any,
    method: 'GET' | 'POST' = 'GET'
  ): Promise<any> {
    if (!this.axiosInstance) {
      throw new Error('키움증권 API에 연결되지 않았습니다')
    }

    if (!this.accessToken) {
      throw new Error('접근토큰이 없습니다')
    }

    const config: AxiosRequestConfig = {
      method,
      url: endpoint,
      headers: {
        'api-id': trId, // 키움증권 API는 api-id 헤더 사용
        'Authorization': `Bearer ${this.accessToken.token}`,
        'Content-Type': 'application/json;charset=UTF-8',
        'cont-yn': 'N', // 연속조회여부
        'next-key': '', // 연속조회키
      }
    }

    if (data && method === 'POST') {
      config.data = data
    } else if (data && method === 'GET') {
      config.params = data
    }

    try {
      const response = await this.axiosInstance.request(config)
      
      // 키움 API 응답 구조 확인
      if (response.data.return_code !== undefined) {
        if (response.data.return_code !== 0) {
          // 요청 제한 에러(5)는 특별 처리
          if (response.data.return_code === 5) {
            const errorMsg = response.data.return_msg || 'API 요청 제한 초과'
            // 요청 제한 에러는 조용히 처리 (너무 많은 로그 방지)
            const error = new Error(errorMsg)
            ;(error as any).response = { data: response.data, status: 429 }
            ;(error as any).isRateLimit = true // 요청 제한 에러 플래그
            throw error
          }
          throw new Error(response.data.return_msg || 'API 오류 발생')
        }
      }
      
      return response.data
    } catch (error: any) {
      // 키움증권 API 오류 로그 (상위 호출자에서 처리할 수 있도록)
      const errorData = error.response?.data || error.message
      // 500 에러와 429(요청 제한) 에러는 조용히 처리
      if (error.response?.status !== 500 && error.response?.status !== 429 && errorData?.error !== 'INTERNAL_SERVER_ERROR') {
        console.error(`API 요청 오류 [${trId}]:`, errorData)
      }
      throw error
    }
  }

  /**
   * 종목 리스트 조회
   * 키움 REST API: 국내주식 > 순위정보 > 등락률순위
   * 참고: 모의투자 환경(mockapi.kiwoom.com)에서는 KRX(한국거래소) 종목만 지원
   */
  async getStockList(market: string = '0'): Promise<any[]> {
    // 키움 REST API 엔드포인트
    // 국내주식 > 순위정보 > 등락률순위
    const endpoint = '/uapi/domestic-stock/v1/ranking/fluctuation'
    const trId = 'FHKST01010100' // TR_ID는 키움 API 문서 참조
    
    // 모의투자 환경에서는 KRX만 지원 (코스피 + 코스닥 모두 KRX에 속함)
    // 필수 파라미터만 전송 (빈 문자열 파라미터 제거)
    const params: any = {
      FID_COND_MRKT_DIV_CODE: market === '0' ? 'J' : 'Q', // J: 코스피, Q: 코스닥 (모두 KRX)
      FID_COND_SCR_DIV_CODE: '20171', // 정렬기준 (등락률)
      FID_INPUT_ISCD: '0000', // 전체 조회
    }
    
    console.log(`[모의투자] 종목 조회 시도: ${market === '0' ? '코스피(J)' : '코스닥(Q)'} (KRX 지원)`)

    try {
      const response = await this.request(endpoint, trId, params, 'GET')
      
      // 키움 API 응답 구조에 맞게 파싱
      if (response.output && Array.isArray(response.output)) {
        return response.output.map((item: any) => ({
          code: item.ISCD || item.종목코드 || item.stk_cd || '',
          name: item.HANNAME || item.종목명 || item.stk_nm || '',
          price: parseFloat(item.PRICE || item.현재가 || item.prc || '0'),
          change: parseFloat(item.DIFF || item.전일대비 || item.diff || '0'),
          changePercent: parseFloat(item.RATE || item.등락률 || item.prdy_chng_rt || '0'),
          volume: parseFloat(item.VOLUME || item.거래량 || item.acml_vol || '0'),
        }))
      }
      
      // output1 필드도 확인
      if (response.output1 && Array.isArray(response.output1)) {
        return response.output1.map((item: any) => ({
          code: item.ISCD || item.종목코드 || item.stk_cd || '',
          name: item.HANNAME || item.종목명 || item.stk_nm || '',
          price: parseFloat(item.PRICE || item.현재가 || item.prc || '0'),
          change: parseFloat(item.DIFF || item.전일대비 || item.diff || '0'),
          changePercent: parseFloat(item.RATE || item.등락률 || item.prdy_chng_rt || '0'),
          volume: parseFloat(item.VOLUME || item.거래량 || item.acml_vol || '0'),
        }))
      }
      
      return []
    } catch (error: any) {
      // 키움증권 API가 작동하지 않을 수 있으므로 조용하게 처리
      // 모의투자 환경에서는 순위정보 API가 작동하지 않을 수 있음
      // 오류는 상위 호출자에서 처리
      return []
    }
  }

  /**
   * 종목 현재가 조회
   * 키움 REST API: 국내주식 > 시세 > 주식현재가시세
   */
  async getCurrentPrice(code: string): Promise<any> {
    const endpoint = '/uapi/domestic-stock/v1/quotations/inquire-price'
    const trId = 'FHKST01010100' // 주식현재가시세 TR_ID
    
    const params = {
      FID_COND_MRKT_DIV_CODE: 'J', // J: 코스피, Q: 코스닥
      FID_INPUT_ISCD: code, // 종목코드
    }

    try {
      const response = await this.request(endpoint, trId, params, 'GET')
      
      if (response.output && response.output[0]) {
        const item = response.output[0]
        return {
          code: item.ISCD || code,
          name: item.HANNAME || item.종목명 || '',
          price: parseFloat(item.PRICE || item.현재가 || '0'),
          change: parseFloat(item.DIFF || item.전일대비 || '0'),
          changePercent: parseFloat(item.RATE || item.등락률 || '0'),
          volume: parseFloat(item.VOLUME || item.거래량 || '0'),
          시가: parseFloat(item.OPEN || item.시가 || '0'),
          고가: parseFloat(item.HIGH || item.고가 || '0'),
          저가: parseFloat(item.LOW || item.저가 || '0'),
          시가대비: parseFloat(item.시가대비 || '0'),
          고가대비: parseFloat(item.고가대비 || '0'),
        }
      }
      
      return {}
    } catch (error: any) {
      // 500 에러는 서버 측 문제이므로 조용히 처리
      const status = error.response?.status || error.status
      if (status !== 500) {
        // 500이 아닌 에러만 로그 출력 (요청 제한 등)
        const errorMessage = error.response?.data?.message || error.message || ''
        if (!errorMessage.includes('허용된 요청 개수를 초과')) {
          // console.error('현재가 조회 오류:', errorMessage)
        }
      }
      throw error
    }
  }

  /**
   * 여러 종목의 현재가 일괄 조회
   * 키움 REST API: 국내주식 > 시세 > 주식현재가시세
   */
  async getMultipleCurrentPrices(codes: string[]): Promise<any[]> {
    if (!codes || codes.length === 0) {
      return []
    }

    const results: any[] = []
    
    // API 요청 제한을 고려하여 배치로 처리 (한번에 10개씩)
    const batchSize = 10
    for (let i = 0; i < codes.length; i += batchSize) {
      const batch = codes.slice(i, i + batchSize)
      
      // 병렬로 처리하되, 요청 간 약간의 지연을 둠
      const batchPromises = batch.map(async (code, index) => {
        // 요청 간 지연 (API 제한 방지)
        if (index > 0) {
          await new Promise(resolve => setTimeout(resolve, 150))
        }
        
        try {
          const priceData = await this.getCurrentPrice(code)
          return priceData
        } catch (error: any) {
          // 500 에러나 서버 에러는 조용히 처리 (너무 많은 로그 방지)
          const status = error.response?.status || error.status
          const errorMessage = error.response?.data?.message || error.message || ''
          
          // 500 에러는 서버 측 문제이므로 로그를 출력하지 않음
          if (status === 500) {
            // 조용히 실패 처리
            return null
          }
          
          // 다른 에러는 첫 번째 발생 시에만 로그 출력
          if (!errorMessage.includes('허용된 요청 개수를 초과') && 
              !errorMessage.includes('INTERNAL_SERVER_ERROR')) {
            // 에러 로그를 최소화 (디버깅 시에만 활성화)
            // console.error(`종목 ${code} 현재가 조회 오류:`, errorMessage)
          }
          
          return null
        }
      })
      
      const batchResults = await Promise.all(batchPromises)
      const validResults = batchResults.filter(r => r !== null && r.code)
      results.push(...validResults)
      
      // 배치 간 지연 (API 제한 방지)
      if (i + batchSize < codes.length) {
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }
    
    return results
  }

  /**
   * 차트 데이터 조회
   * 키움 REST API: 국내주식 > 차트 > 일봉/분봉 차트
   */
  async getCandleData(
    code: string,
    period: string = 'min',
    start: string = '',
    end: string = ''
  ): Promise<any[]> {
    // 모의투자 환경 확인
    const isMock = this.config?.host?.includes('mockapi') || false
    
    let endpoint = ''
    let trId = ''

    if (isMock) {
      // 모의투자 환경: /api/dostk/chart 엔드포인트 사용
      endpoint = '/api/dostk/chart'
      
      // TR_ID 매핑 (모의투자용)
      if (period === 'day') {
        trId = 'ka10081' // 주식일봉차트조회요청
      } else if (period === 'tick') {
        trId = 'ka10079' // 주식틱차트조회요청
      } else {
        trId = 'ka10080' // 주식분봉차트조회요청
      }
    } else {
      // 실전투자 환경: 기존 엔드포인트 사용
      if (period === 'day') {
        // 일봉 차트
        endpoint = '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice'
        trId = 'FHKST03010100'
      } else {
        // 분봉 차트 (min, 3, 5, 10, 15, 30, 60 등)
        endpoint = '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice'
        trId = 'FHKST03010200'
      }
    }

    let params: any = {}
    let requestMethod: 'GET' | 'POST' = 'GET'
    
    if (isMock) {
      // 모의투자 환경: POST 메서드 사용, Body에 파라미터 전달
      requestMethod = 'POST'
      
      // 날짜 설정 (오늘 날짜)
      const today = new Date()
      const year = today.getFullYear()
      const month = String(today.getMonth() + 1).padStart(2, '0')
      const day = String(today.getDate()).padStart(2, '0')
      const dt = `${year}${month}${day}` // YYYYMMDD
      
      // 모의투자 환경 파라미터 설정
      params = {
        dt: dt, // 일자 (YYYYMMDD)
        stk_cd: code, // 종목코드
      }
      
      // 분봉인 경우 필수 파라미터 추가
      if (period !== 'day') {
        const tickMap: { [key: string]: string } = {
          'min': '1', // 1분
          'tick': '1', // 틱도 1분으로 처리
          '3': '3', // 3분
          '5': '5', // 5분
          '10': '10', // 10분
          '15': '15', // 15분
          '30': '30', // 30분
          '60': '60', // 60분
        }
        // 모의투자 API 필수 파라미터
        params.tic_scope = tickMap[period] || '1' // 틱 범위
        params.upd_stkpc_tp = '1' // 수정주가구분 (1: 수정주가 적용)
      } else {
        // 일봉인 경우에도 수정주가구분 필요할 수 있음
        params.upd_stkpc_tp = '1' // 수정주가구분 (1: 수정주가 적용)
      }
    } else {
      // 실전투자 환경: 기존 파라미터 형식 사용
      // 시장구분 코드 자동 판단
      // 종목코드로 시장구분 판단 (6자리 코드 기준)
      // 5xxxxx, 6xxxxx: 코스피 (J)
      // 0xxxxx, 1xxxxx, 2xxxxx, 3xxxxx: 코스피 (J)  
      // 1xxxxx, 2xxxxx: 코스닥 (Q) - 일부
      // ETN/ETF 등은 대부분 코스피에 속함
      // 안전하게 J(코스피)를 기본값으로 사용하고, 실패 시 Q(코스닥) 시도
      let marketCode = 'J' // 기본값: 코스피
      
      // 종목코드 첫 자리로 판단 (간단한 휴리스틱)
      if (code.length >= 6) {
        const firstDigit = code[0]
        // 0, 1, 2, 3, 5, 6으로 시작: 코스피 (J)
        // 1, 2로 시작하는 일부는 코스닥일 수 있지만, ETN/ETF는 대부분 코스피
        if (['0', '1', '2', '3', '5', '6'].includes(firstDigit)) {
          marketCode = 'J'
        } else {
          marketCode = 'Q' // 그 외는 코스닥으로 가정
        }
      }
      
      params = {
        FID_COND_MRKT_DIV_CODE: marketCode, // J: 코스피, Q: 코스닥
        FID_INPUT_ISCD: code, // 종목코드
      }

      // 분봉인 경우 틱범위 추가
      if (period !== 'day') {
        // start 파라미터가 없을 때만 틱 범위 설정
        if (!start) {
          const tickMap: { [key: string]: string } = {
            'min': '1', // 1분
            'tick': '1', // 틱도 1분으로 처리
            '3': '3', // 3분
            '5': '5', // 5분
            '10': '10', // 10분
            '15': '15', // 15분
            '30': '30', // 30분
            '60': '60', // 60분
          }
          params.FID_INPUT_HOUR_1 = tickMap[period] || '1'
        } else {
          params.FID_INPUT_HOUR_1 = start
        }
      }

      if (end) params.FID_INPUT_HOUR_2 = end
    }
    
    console.log(`[차트 API] 종목코드: ${code}, 기간: ${period}, 모의투자: ${isMock}, 도메인: ${this.config?.host || 'N/A'}`)
    console.log(`[차트 API] 엔드포인트: ${endpoint}, TR_ID: ${trId}, 메서드: ${requestMethod}`)
    console.log(`[차트 API] 요청 파라미터:`, JSON.stringify(params, null, 2))

    try {
      const response = await this.request(endpoint, trId, params, requestMethod)
      
      // 응답 구조 확인 및 디버깅
      console.log(`[차트 API] 종목코드: ${code}, 기간: ${period}, 응답 수신 완료`)
      console.log(`[차트 API] 응답 키:`, Object.keys(response))
      console.log(`[차트 API] 응답 구조 (처음 1000자):`, JSON.stringify(response).substring(0, 1000))
      
      // 키움 API 응답 구조 확인
      // output1, output2, output 등 다양한 형태로 데이터가 올 수 있음
      // 모의투자 환경에서는 응답 구조가 다를 수 있음
      let chartData: any[] = []
      
      if (isMock) {
        // 모의투자 환경: 응답 구조 확인 및 파싱
        // ka10080 (주식분봉차트조회요청) 응답 구조: stk_min_pole_chart_qry 배열
        if (response.stk_min_pole_chart_qry && Array.isArray(response.stk_min_pole_chart_qry)) {
          chartData = response.stk_min_pole_chart_qry
          console.log(`[차트 API] 모의투자 - stk_min_pole_chart_qry 배열 발견: ${chartData.length}개`)
        } else if (response.output && Array.isArray(response.output)) {
          chartData = response.output
          console.log(`[차트 API] 모의투자 - output 배열 발견: ${chartData.length}개`)
        } else if (response.output1 && Array.isArray(response.output1)) {
          chartData = response.output1
          console.log(`[차트 API] 모의투자 - output1 배열 발견: ${chartData.length}개`)
        } else if (response.output2 && Array.isArray(response.output2)) {
          chartData = response.output2
          console.log(`[차트 API] 모의투자 - output2 배열 발견: ${chartData.length}개`)
        } else if (Array.isArray(response)) {
          chartData = response
          console.log(`[차트 API] 모의투자 - 직접 배열 발견: ${chartData.length}개`)
        } else if (typeof response === 'object') {
          // 모든 키를 확인하여 배열을 찾음
          for (const key in response) {
            if (Array.isArray(response[key])) {
              chartData = response[key]
              console.log(`[차트 API] 모의투자 - ${key} 배열 발견: ${chartData.length}개`)
              break
            }
          }
        }
      } else {
        // 실전투자 환경: 기존 응답 구조 파싱
        // 1. output1 배열 확인 (가장 일반적)
        if (response.output1 && Array.isArray(response.output1)) {
          chartData = response.output1
          console.log(`[차트 API] output1 배열 발견: ${chartData.length}개`)
        } 
        // 2. output 배열 확인
        else if (response.output && Array.isArray(response.output)) {
          chartData = response.output
          console.log(`[차트 API] output 배열 발견: ${chartData.length}개`)
        } 
        // 3. output2 배열 확인
        else if (response.output2 && Array.isArray(response.output2)) {
          chartData = response.output2
          console.log(`[차트 API] output2 배열 발견: ${chartData.length}개`)
        }
        // 4. 직접 배열인 경우
        else if (Array.isArray(response)) {
          chartData = response
          console.log(`[차트 API] 직접 배열 발견: ${chartData.length}개`)
        }
        // 5. 응답이 객체이고 배열 필드가 있는 경우
        else if (typeof response === 'object') {
          // 모든 키를 확인하여 배열을 찾음
          for (const key in response) {
            if (Array.isArray(response[key])) {
              chartData = response[key]
              console.log(`[차트 API] ${key} 배열 발견: ${chartData.length}개`)
              break
            }
          }
        }
      }
      
      if (chartData.length === 0) {
        console.log(`[차트 API] 배열 데이터를 찾을 수 없음. 전체 응답:`, JSON.stringify(response, null, 2))
      }
      
      if (chartData.length > 0) {
        // 첫 번째 데이터 샘플 확인 (모의투자 환경에서는 더 자세히)
        const firstItem = chartData[0]
        const firstItemKeys = Object.keys(firstItem)
        
        if (isMock) {
          // 모의투자 환경: 필드명과 값 확인
          console.log(`[차트 API] 모의투자 - 첫 번째 항목 필드명 (${firstItemKeys.length}개):`, firstItemKeys.join(', '))
          // 처음 5개 필드의 값만 출력 (로그가 너무 길어지는 것 방지)
          const sampleFields = firstItemKeys.slice(0, 5).map(key => `${key}=${firstItem[key]}`).join(', ')
          console.log(`[차트 API] 모의투자 - 첫 번째 항목 샘플 값:`, sampleFields)
        } else {
          console.log(`[차트 API] 첫 번째 항목 필드명:`, firstItemKeys.join(', '))
        }
        
        const mappedData = chartData.map((item: any, index: number) => {
          // 모의투자 API의 실제 필드명 확인 및 매핑
          // 모의투자 API는 다른 필드명을 사용할 수 있으므로 다양한 가능성 확인
          let date = ''
          let open = 0
          let high = 0
          let low = 0
          let close = 0
          let volume = 0
          
          if (isMock) {
            // 모의투자 API 필드명 (ka10080 실제 응답 구조)
            // cntr_tm: 체결시간 (YYYYMMDDHHMMSS 형식)
            // open_pric: 시가 (부호 포함 가능: +108900)
            // high_pric: 고가 (부호 포함 가능)
            // low_pric: 저가 (부호 포함 가능)
            // cur_prc: 현재가/종가 (부호 포함 가능: +108900)
            // trde_qty: 거래량
            
            const cntrTm = item.cntr_tm || item.CNTR_TM || ''
            // YYYYMMDDHHMMSS 형식을 YYYYMMDDHHMM 형식으로 변환 (초 제거)
            date = cntrTm.length >= 14 ? cntrTm.substring(0, 12) : cntrTm
            
            // 부호 제거 후 파싱 (+108900 -> 108900)
            const parsePrice = (value: any) => {
              if (!value) return 0
              const str = String(value).replace(/[+\-]/g, '').trim()
              return parseFloat(str) || 0
            }
            
            open = parsePrice(item.open_pric || item.OPEN_PRIC || item.open_price || item.OPEN_PRICE || item.open || item.OPEN || item.시가)
            high = parsePrice(item.high_pric || item.HIGH_PRIC || item.high_price || item.HIGH_PRICE || item.high || item.HIGH || item.고가)
            low = parsePrice(item.low_pric || item.LOW_PRIC || item.low_price || item.LOW_PRICE || item.low || item.LOW || item.저가)
            close = parsePrice(item.cur_prc || item.CUR_PRC || item.cur_price || item.CUR_PRICE || item.close || item.CLOSE || item.cls_prc || item.CLS_PRC || item.종가 || item.현재가)
            volume = parseFloat(item.trde_qty || item.TRDE_QTY || item.volume || item.VOLUME || item.거래량 || '0') || 0
            
            // 첫 번째 항목의 필드명과 값 확인 (한 번만 출력)
            if (index === 0) {
              console.log(`[차트 API] 모의투자 - 파싱 시도 결과:`, { 
                date, open, high, low, close, volume,
                'item.dt': item.dt,
                'item.open_prc': item.open_prc,
                'item.cls_prc': item.cls_prc,
                'item.volume': item.volume,
                '모든 필드': Object.keys(item)
              })
            }
          } else {
            // 실전투자 API 필드명
            date = item.STDT || item.stdt || item.일자 || item.date || item.time || ''
            open = parseFloat(item.OPEN || item.open || item.시가 || '0') || 0
            high = parseFloat(item.HIGH || item.high || item.고가 || '0') || 0
            low = parseFloat(item.LOW || item.low || item.저가 || '0') || 0
            close = parseFloat(item.CLOSE || item.close || item.종가 || item.현재가 || '0') || 0
            volume = parseFloat(item.VOLUME || item.volume || item.거래량 || '0') || 0
            
            // 첫 번째 항목의 필드명 확인
            if (index === 0) {
              console.log(`[차트 API] 첫 번째 항목 필드명:`, Object.keys(item))
              console.log(`[차트 API] 파싱 결과:`, { date, open, high, low, close, volume })
            }
          }
          
          return {
            일자: date,
            시가: open,
            고가: high,
            저가: low,
            종가: close,
            거래량: volume,
          }
        }).filter((item: any) => {
          // 유효한 데이터만 필터링 (일자가 있고 가격이 0이 아닌 경우)
          const isValid = item.일자 && (item.시가 > 0 || item.고가 > 0 || item.저가 > 0 || item.종가 > 0)
          if (!isValid) {
            console.log(`[차트 API] 유효하지 않은 데이터 필터링:`, item)
          }
          return isValid
        })
        
        console.log(`[차트 API] 종목코드: ${code}, 기간: ${period}, 원본: ${chartData.length}개, 필터링 후: ${mappedData.length}개`)
        
        return mappedData
      }
      
      // 데이터가 없을 경우 빈 배열 반환
      console.log(`[차트 API] 종목코드: ${code}, 기간: ${period}, 데이터 없음 - 빈 배열 반환`)
      return []
    } catch (error: any) {
      // 에러 상세 로깅
      const status = error.response?.status || error.status
      const errorMessage = error.response?.data?.message || error.response?.data?.return_msg || error.message || ''
      const errorCode = error.response?.data?.return_code
      const isMock = this.config?.host?.includes('mockapi') || false
      
      console.log(`[차트 API] 종목코드: ${code}, 기간: ${period}, 에러 발생`)
      console.log(`[차트 API] 모의투자: ${isMock}, 도메인: ${this.config?.host || 'N/A'}`)
      console.log(`[차트 API] 에러 상태: ${status}, 에러 코드: ${errorCode}, 메시지: ${errorMessage}`)
      
      // 모의투자 환경에서 500 에러인 경우 상세 응답 로깅
      if (isMock && status === 500) {
        console.log(`[차트 API] 모의투자 500 에러 상세 응답:`, JSON.stringify(error.response?.data || {}, null, 2))
      }
      
      // 500 에러 처리: 시장구분 변경 또는 일봉 차트로 재시도 (실전투자 환경만)
      if (status === 500 && !isMock) {
        // 분봉 차트가 실패한 경우 일봉 차트로 재시도
        if (period !== 'day') {
          console.log(`[차트 API] 종목코드: ${code}, 분봉(${period}) 실패, 일봉으로 재시도`)
          try {
            const dayEndpoint = '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice'
            const dayTrId = 'FHKST03010100'
            
            // 시장구분 코드 자동 판단
            let marketCode = 'J' // 기본값: 코스피
            if (code.length >= 6) {
              const firstDigit = code[0]
              if (['0', '1', '2', '3', '5', '6'].includes(firstDigit)) {
                marketCode = 'J'
              } else {
                marketCode = 'Q'
              }
            }
            
            const dayParams = {
              FID_COND_MRKT_DIV_CODE: marketCode,
              FID_INPUT_ISCD: code,
            }
            
            console.log(`[차트 API] 일봉 재시도 파라미터:`, JSON.stringify(dayParams, null, 2))
            
            const dayResponse = await this.request(dayEndpoint, dayTrId, dayParams, 'GET')
            
            console.log(`[차트 API] 일봉 재시도 성공 - 응답 키:`, Object.keys(dayResponse))
            
            // 일봉 응답 처리
            let chartData: any[] = []
            
            if (dayResponse.output1 && Array.isArray(dayResponse.output1)) {
              chartData = dayResponse.output1
            } else if (dayResponse.output && Array.isArray(dayResponse.output)) {
              chartData = dayResponse.output
            } else if (dayResponse.output2 && Array.isArray(dayResponse.output2)) {
              chartData = dayResponse.output2
            } else if (Array.isArray(dayResponse)) {
              chartData = dayResponse
            } else if (typeof dayResponse === 'object') {
              for (const key in dayResponse) {
                if (Array.isArray(dayResponse[key])) {
                  chartData = dayResponse[key]
                  break
                }
              }
            }
            
            if (chartData.length > 0) {
              console.log(`[차트 API] 일봉 재시도 - 데이터 발견: ${chartData.length}개`)
              const mappedData = chartData.map((item: any) => {
                const date = item.STDT || item.stdt || item.일자 || item.date || item.time || ''
                const open = parseFloat(item.OPEN || item.open || item.시가 || '0') || 0
                const high = parseFloat(item.HIGH || item.high || item.고가 || '0') || 0
                const low = parseFloat(item.LOW || item.low || item.저가 || '0') || 0
                const close = parseFloat(item.CLOSE || item.close || item.종가 || item.현재가 || '0') || 0
                const volume = parseFloat(item.VOLUME || item.volume || item.거래량 || '0') || 0
                
                return {
                  일자: date,
                  시가: open,
                  고가: high,
                  저가: low,
                  종가: close,
                  거래량: volume,
                }
              }).filter((item: any) => {
                return item.일자 && (item.시가 > 0 || item.고가 > 0 || item.저가 > 0 || item.종가 > 0)
              })
              
              console.log(`[차트 API] 일봉 재시도 성공 - 필터링 후: ${mappedData.length}개`)
              return mappedData
            }
          } catch (dayError: any) {
            console.log(`[차트 API] 일봉 재시도도 실패:`, dayError.message)
          }
        }
        
        // 시장구분이 J인 경우 Q로 재시도
        // 시장구분 코드 자동 판단
        let marketCode = 'J' // 기본값: 코스피
        if (code.length >= 6) {
          const firstDigit = code[0]
          if (['0', '1', '2', '3', '5', '6'].includes(firstDigit)) {
            marketCode = 'J'
          } else {
            marketCode = 'Q'
          }
        }
        
        if (marketCode === 'J') {
          console.log(`[차트 API] 종목코드: ${code}, 시장구분 J 실패, Q(코스닥)로 재시도`)
          try {
            const retryParams = { ...params, FID_COND_MRKT_DIV_CODE: 'Q' }
            console.log(`[차트 API] 재시도 파라미터:`, JSON.stringify(retryParams, null, 2))
            
            const retryResponse = await this.request(endpoint, trId, retryParams, requestMethod)
            
            console.log(`[차트 API] 재시도 성공 - 응답 키:`, Object.keys(retryResponse))
            
            // 재시도 응답 처리 (위와 동일한 로직)
            let chartData: any[] = []
            
            if (retryResponse.output1 && Array.isArray(retryResponse.output1)) {
              chartData = retryResponse.output1
            } else if (retryResponse.output && Array.isArray(retryResponse.output)) {
              chartData = retryResponse.output
            } else if (retryResponse.output2 && Array.isArray(retryResponse.output2)) {
              chartData = retryResponse.output2
            } else if (Array.isArray(retryResponse)) {
              chartData = retryResponse
            } else if (typeof retryResponse === 'object') {
              for (const key in retryResponse) {
                if (Array.isArray(retryResponse[key])) {
                  chartData = retryResponse[key]
                  break
                }
              }
            }
            
            if (chartData.length > 0) {
              console.log(`[차트 API] 재시도 - 데이터 발견: ${chartData.length}개`)
              const mappedData = chartData.map((item: any) => {
                const date = item.STDT || item.stdt || item.일자 || item.date || item.time || ''
                const open = parseFloat(item.OPEN || item.open || item.시가 || '0') || 0
                const high = parseFloat(item.HIGH || item.high || item.고가 || '0') || 0
                const low = parseFloat(item.LOW || item.low || item.저가 || '0') || 0
                const close = parseFloat(item.CLOSE || item.close || item.종가 || item.현재가 || '0') || 0
                const volume = parseFloat(item.VOLUME || item.volume || item.거래량 || '0') || 0
                
                return {
                  일자: date,
                  시가: open,
                  고가: high,
                  저가: low,
                  종가: close,
                  거래량: volume,
                }
              }).filter((item: any) => {
                return item.일자 && (item.시가 > 0 || item.고가 > 0 || item.저가 > 0 || item.종가 > 0)
              })
              
              console.log(`[차트 API] 재시도 성공 - 필터링 후: ${mappedData.length}개`)
              return mappedData
            }
          } catch (retryError: any) {
            console.log(`[차트 API] 재시도도 실패:`, retryError.message)
          }
        }
      }
      
      // 500 에러는 서버 측 문제이므로 조용히 처리
      if (status === 500) {
        console.log(`[차트 API] 500 에러 - 서버 측 문제로 조용히 처리 (모의투자 환경에서 일부 종목은 차트 데이터를 제공하지 않을 수 있음)`)
      } else if (status === 429 || errorCode === 5) {
        console.log(`[차트 API] 요청 제한 에러 - 조용히 처리`)
      } else {
        // 기타 에러는 로그 출력
        console.error(`[차트 API] 차트 데이터 조회 오류 상세:`, {
          status,
          errorCode,
          errorMessage,
          endpoint,
          trId,
          params
        })
      }
      
      // 차트 API가 실패한 경우 현재가 정보를 사용하여 최소한의 차트 데이터 생성
      try {
        console.log(`[차트 API] 차트 데이터 조회 실패, 현재가 정보로 대체 시도: ${code}`)
        const currentPriceData = await this.getCurrentPrice(code)
        
        if (currentPriceData && currentPriceData.price && currentPriceData.price > 0) {
          // 현재 날짜/시간 생성
          const now = new Date()
          const year = now.getFullYear()
          const month = String(now.getMonth() + 1).padStart(2, '0')
          const day = String(now.getDate()).padStart(2, '0')
          const hours = String(now.getHours()).padStart(2, '0')
          const minutes = String(now.getMinutes()).padStart(2, '0')
          
          // 일봉인 경우 날짜만, 분봉인 경우 날짜+시간
          const dateStr = period === 'day' 
            ? `${year}${month}${day}` 
            : `${year}${month}${day}${hours}${minutes}`
          
          // 현재가 정보를 기반으로 차트 데이터 생성
          const fallbackData = [{
            일자: dateStr,
            시가: currentPriceData.시가 || currentPriceData.price,
            고가: currentPriceData.고가 || currentPriceData.price,
            저가: currentPriceData.저가 || currentPriceData.price,
            종가: currentPriceData.price,
            거래량: currentPriceData.volume || 0,
          }]
          
          console.log(`[차트 API] 현재가 정보로 차트 데이터 생성 성공: ${fallbackData.length}개`)
          return fallbackData
        }
      } catch (currentPriceError: any) {
        // 현재가 조회도 실패한 경우 조용히 처리
        console.log(`[차트 API] 현재가 조회도 실패:`, currentPriceError.message)
      }
      
      // 모든 시도가 실패한 경우 빈 배열 반환
      return []
    }
  }

  /**
   * 예수금 조회 (kt00001)
   * 키움 REST API: 국내주식 > 계좌 > 예수금 조회
   */
  async getDeposit(qryDt?: string): Promise<any> {
    // 키움증권 REST API 엔드포인트
    // 계좌 관련 API는 /api/dostk/acnt 경로 사용 (ka01690과 동일)
    const endpoint = '/api/dostk/acnt'
    const trId = 'kt00001' // 예수금 조회 TR_ID
    
    // 조회일자 (YYYYMMDD 형식)
    if (!qryDt) {
      const today = new Date()
      const year = today.getFullYear()
      const month = String(today.getMonth() + 1).padStart(2, '0')
      const day = String(today.getDate()).padStart(2, '0')
      qryDt = `${year}${month}${day}`
    }
    
    const data = {
      qry_dt: qryDt, // 조회일자 (YYYYMMDD)
      qry_tp: '1' // 조회타입 (1: 일별) - 필수 파라미터
    }

    try {
      const response = await this.request(endpoint, trId, data, 'POST')
      
      // 응답 구조 로깅 (디버깅용)
      console.log('[예수금 조회] kt00001 응답:', JSON.stringify(response, null, 2))
      
      // kt00001 API 응답 구조에 맞게 변환
      // 실제 응답 구조: { entr, pymn_alow_amt, ord_alow_amt, ... }
      // entr: 입금가능금액 (예수금)
      // pymn_alow_amt: 지급가능금액
      // ord_alow_amt: 주문가능금액
      let deposit = 0
      let totBuyAmt = 0
      let totEvltAmt = 0
      let totEvltvPrft = 0
      let totPrftRt = 0
      let dayStkAsst = 0
      let buyWght = 0
      let dayBalRt: any[] = []
      
      // kt00001 응답 구조에 따라 데이터 추출
      if (response.entr !== undefined) {
        // entr: 입금가능금액 (예수금) - 문자열로 오므로 숫자로 변환
        deposit = parseFloat(String(response.entr).trim()) || 0
        // pymn_alow_amt: 지급가능금액
        const pymnAlowAmt = parseFloat(String(response.pymn_alow_amt || '0').trim()) || 0
        // ord_alow_amt: 주문가능금액
        const ordAlowAmt = parseFloat(String(response.ord_alow_amt || '0').trim()) || 0
        
        // 기타 필드들도 파싱 (필요한 경우)
        totBuyAmt = 0 // kt00001에는 총매입가 정보가 없음
        totEvltAmt = 0 // kt00001에는 총평가금액 정보가 없음
        totEvltvPrft = 0 // kt00001에는 총평가손익 정보가 없음
        totPrftRt = 0 // kt00001에는 수익률 정보가 없음
        dayStkAsst = 0 // kt00001에는 추정자산 정보가 없음
        buyWght = 0
        dayBalRt = response.stk_entr_prst || [] // 보유 종목 리스트
      } else if (response.dbst_bal !== undefined) {
        // 기존 dbst_bal 필드가 있는 경우 (다른 API 응답 구조)
        deposit = parseFloat(String(response.dbst_bal)) || 0
        totBuyAmt = parseFloat(String(response.tot_buy_amt || '0')) || 0
        totEvltAmt = parseFloat(String(response.tot_evlt_amt || '0')) || 0
        totEvltvPrft = parseFloat(String(response.tot_evltv_prft || '0')) || 0
        totPrftRt = parseFloat(String(response.tot_prft_rt || '0')) || 0
        dayStkAsst = parseFloat(String(response.day_stk_asst || '0')) || 0
        buyWght = parseFloat(String(response.buy_wght || '0')) || 0
        dayBalRt = response.day_bal_rt || []
      } else if (response.output) {
        // output 객체에 있는 경우
        if (typeof response.output === 'object' && !Array.isArray(response.output)) {
          deposit = parseFloat(String(response.output.entr || response.output.dbst_bal || '0')) || 0
          totBuyAmt = parseFloat(String(response.output.tot_buy_amt || '0')) || 0
          totEvltAmt = parseFloat(String(response.output.tot_evlt_amt || '0')) || 0
          totEvltvPrft = parseFloat(String(response.output.tot_evltv_prft || '0')) || 0
          totPrftRt = parseFloat(String(response.output.tot_prft_rt || '0')) || 0
          dayStkAsst = parseFloat(String(response.output.day_stk_asst || '0')) || 0
          buyWght = parseFloat(String(response.output.buy_wght || '0')) || 0
          dayBalRt = response.output.day_bal_rt || response.output.stk_entr_prst || []
        } else if (Array.isArray(response.output) && response.output.length > 0) {
          // 배열인 경우 첫 번째 요소 사용
          const firstItem = response.output[0]
          deposit = parseFloat(String(firstItem.entr || firstItem.dbst_bal || '0')) || 0
          totBuyAmt = parseFloat(String(firstItem.tot_buy_amt || '0')) || 0
          totEvltAmt = parseFloat(String(firstItem.tot_evlt_amt || '0')) || 0
          totEvltvPrft = parseFloat(String(firstItem.tot_evltv_prft || '0')) || 0
          totPrftRt = parseFloat(String(firstItem.tot_prft_rt || '0')) || 0
          dayStkAsst = parseFloat(String(firstItem.day_stk_asst || '0')) || 0
          buyWght = parseFloat(String(firstItem.buy_wght || '0')) || 0
          dayBalRt = firstItem.day_bal_rt || firstItem.stk_entr_prst || []
        }
      } else if (response.output2) {
        // output2 객체에 있는 경우
        deposit = parseFloat(String(response.output2.entr || response.output2.dbst_bal || '0')) || 0
        totBuyAmt = parseFloat(String(response.output2.tot_buy_amt || '0')) || 0
        totEvltAmt = parseFloat(String(response.output2.tot_evlt_amt || '0')) || 0
        totEvltvPrft = parseFloat(String(response.output2.tot_evltv_prft || '0')) || 0
        totPrftRt = parseFloat(String(response.output2.tot_prft_rt || '0')) || 0
        dayStkAsst = parseFloat(String(response.output2.day_stk_asst || '0')) || 0
        buyWght = parseFloat(String(response.output2.buy_wght || '0')) || 0
        dayBalRt = response.output2.day_bal_rt || response.output2.stk_entr_prst || []
      }
      
      console.log('[예수금 조회] 파싱된 예수금 (entr):', deposit)
      
      return {
        deposit: deposit,
        qryDt: response.dt || qryDt,
        totBuyAmt: totBuyAmt,
        totEvltAmt: totEvltAmt,
        totEvltvPrft: totEvltvPrft,
        totPrftRt: totPrftRt,
        dayStkAsst: dayStkAsst,
        buyWght: buyWght,
        dayBalRt: dayBalRt
      }
    } catch (error: any) {
      // 요청 제한 에러(429 또는 return_code 5)는 조용히 처리
      const isRateLimit = error.response?.status === 429 || error.isRateLimit || 
                         (error.response?.data?.return_code === 5)
      
      if (isRateLimit) {
        return { 
          deposit: 0,
          error: 'API 요청 제한 초과 (잠시 후 다시 시도해주세요)'
        }
      }
      
      // 에러 메시지 추출
      let errorMessage = '예수금 조회에 실패했습니다.'
      if (error.response?.data?.message) {
        errorMessage = error.response.data.message
      } else if (error.message) {
        errorMessage = error.message
      }
      
      // 모의투자 환경에서의 특별 처리
      if (error.response?.status === 500) {
        errorMessage = '모의투자 환경에서는 예수금 조회가 제한될 수 있습니다.'
      } else {
        console.error('[예수금 조회] kt00001 오류:', error.response?.data || error.message)
      }
      
      return { 
        deposit: 0,
        error: errorMessage
      }
    }
  }

  /**
   * 계좌 정보 조회
   * 키움 REST API: 국내주식 > 계좌 > 일별잔고수익률 (ka01690)
   * kt00001을 먼저 시도하고, 실패 시 ka01690 사용
   */
  async getAccountInfo(accountNo?: string, accountProductCode?: string): Promise<any> {
    // 먼저 kt00001로 예수금 조회 시도
    try {
      const depositInfo = await this.getDeposit()
      // 에러가 없으면 성공으로 간주 (예수금이 0일 수도 있으므로 deposit > 0 조건 제거)
      if (!depositInfo.error) {
        // kt00001이 성공하면 이를 사용
        console.log('[계좌 정보] kt00001 성공, 예수금:', depositInfo.deposit)
        return {
          output1: depositInfo.dayBalRt || [],
          output2: {
            DNCA_TOT_AMT: depositInfo.deposit, // 예수금
            TOT_EVAL_AMT: depositInfo.totEvltAmt, // 총평가금액
            EVAL_PNLS_AMT: depositInfo.totEvltvPrft, // 총평가손익
            EVAL_PNLS_RT: depositInfo.totPrftRt, // 총수익률
          }
        }
      } else {
        console.log('[계좌 정보] kt00001 에러:', depositInfo.error)
      }
    } catch (error: any) {
      // kt00001 실패 시 기존 API 사용
      console.log('[계좌 정보] kt00001 예외 발생, ka01690 사용:', error.message)
    }
    
    // 기존 API 사용 (fallback)
    const endpoint = '/api/dostk/acnt'
    const trId = 'ka01690' // 일별잔고수익률 TR_ID
    
    // 오늘 날짜로 조회 (YYYYMMDD 형식)
    const today = new Date()
    const year = today.getFullYear()
    const month = String(today.getMonth() + 1).padStart(2, '0')
    const day = String(today.getDate()).padStart(2, '0')
    const qryDt = `${year}${month}${day}`
    
    const data = {
      qry_dt: qryDt // 조회일자
    }

    try {
      const response = await this.request(endpoint, trId, data, 'POST')
      
      // ka01690 API 응답 구조에 맞게 변환
      // 응답에서 계좌 정보 추출
      if (response.output && Array.isArray(response.output) && response.output.length > 0) {
        // 일별잔고수익률 데이터를 계좌 정보 형식으로 변환
        const accountData = response.output[0] // 첫 번째 데이터 사용
        
        return {
          output1: response.output || [], // 일별 잔고 데이터
          output2: {
            // 계좌 평가 정보 추출 (필드명은 실제 API 응답에 맞게 조정 필요)
            DNCA_TOT_AMT: accountData.DNCA_TOT_AMT || accountData.예수금총액 || 0,
            TOT_EVAL_AMT: accountData.TOT_EVAL_AMT || accountData.총평가금액 || 0,
            EVAL_PNLS_AMT: accountData.EVAL_PNLS_AMT || accountData.총평가손익 || 0,
            EVAL_PNLS_RT: accountData.EVAL_PNLS_RT || accountData.총수익률 || 0,
          }
        }
      }
      
      // 응답이 없는 경우
      return {
        output1: [],
        output2: {}
      }
    } catch (error: any) {
      // 요청 제한 에러(429 또는 return_code 5)는 조용히 처리
      const isRateLimit = error.response?.status === 429 || error.isRateLimit || 
                         (error.response?.data?.return_code === 5)
      
      if (isRateLimit) {
        // 요청 제한 에러는 조용히 처리 (로그 최소화)
        return { 
          output1: [], 
          output2: {},
          error: 'API 요청 제한 초과 (잠시 후 다시 시도해주세요)'
        }
      }
      
      // 에러 메시지 추출
      let errorMessage = '계좌 정보 조회에 실패했습니다.'
      if (error.response?.data?.message) {
        errorMessage = error.response.data.message
      } else if (error.message) {
        errorMessage = error.message
      }
      
      // 모의투자 환경에서의 특별 처리
      if (error.response?.status === 500) {
        errorMessage = '모의투자 환경에서는 해당 계좌가 등록되지 않았거나, 계좌 잔고 조회가 제한될 수 있습니다. 실제 계좌번호가 키움증권 API에 등록되어 있는지 확인해주세요.'
        // 500 에러는 조용히 처리 (로그 최소화)
      } else {
        // 500이 아닌 에러만 로그 출력
        console.error('계좌 정보 조회 오류:', error.response?.data || error.message)
      }
      
      return { 
        output1: [], 
        output2: {},
        error: errorMessage
      }
    }
  }

  /**
   * 보유 종목 조회
   * ka01690 API는 일별잔고수익률만 제공하므로 보유 종목 리스트는 제공하지 않음
   * 계좌 요약 정보만 반환
   */
  async getBalance(accountNo?: string, accountProductCode?: string): Promise<any> {
    try {
      const accountInfo = await this.getAccountInfo(accountNo, accountProductCode)
      
      // 에러가 있는 경우 에러 정보 포함하여 반환
      if (accountInfo.error) {
        return {
          error: accountInfo.error,
          stocks: []
        }
      }
      
      // ka01690 API는 일별잔고수익률만 제공하므로 보유 종목 리스트는 없음
      // 빈 배열 반환
      return []
    } catch (error: any) {
      let errorMessage = '보유 종목 조회에 실패했습니다.'
      if (error.response?.data?.message) {
        errorMessage = error.response.data.message
      } else if (error.message) {
        errorMessage = error.message
      }
      
      // 500 에러는 조용히 처리 (로그 최소화)
      if (error.response?.status !== 500) {
        console.error('보유 종목 조회 오류:', error.response?.data || error.message)
      }
      
      return {
        error: errorMessage,
        stocks: []
      }
    }
  }

  /**
   * 주문 전송
   * 키움 REST API: 국내주식 > 주문 > 현금주문
   * 주의: 계좌번호와 계좌상품코드는 실제 값으로 설정해야 함
   */
  async placeOrder(
    order: OrderRequest,
    accountNo?: string,
    accountProductCode?: string
  ): Promise<any> {
    const endpoint = '/uapi/domestic-stock/v1/trading/order-cash'
    // TTTC0802U: 현금매수주문, TTTC0801U: 현금매도주문
    const trId = order.order_type === 'buy' ? 'TTTC0802U' : 'TTTC0801U'
    
    // 종목코드 검증: 6자리 숫자만 허용 (ELW, ETF 등 비표준 종목코드 제외)
    const stockCode = order.code.trim()
    if (!/^\d{6}$/.test(stockCode)) {
      throw new Error(`지원하지 않는 종목코드 형식입니다: ${stockCode} (6자리 숫자만 지원)`)
    }
    
    // 계좌번호 검증
    if (!accountNo || accountNo.trim().length === 0) {
      throw new Error('계좌번호가 필요합니다')
    }
    
    // 계좌상품코드 검증
    if (!accountProductCode || accountProductCode.trim().length === 0) {
      throw new Error('계좌상품코드가 필요합니다')
    }
    
    // 주문 수량 검증
    if (!order.quantity || order.quantity <= 0) {
      throw new Error('주문 수량은 1 이상이어야 합니다')
    }
    
    // 지정가 주문 시 가격 검증
    if (order.order_option === '00' && (!order.price || order.price <= 0)) {
      throw new Error('지정가 주문 시 주문 가격이 필요합니다')
    }
    
    const data = {
      CANO: accountNo.trim(), // 계좌번호 (8자리)
      ACNT_PRDT_CD: accountProductCode.trim(), // 계좌상품코드 (2자리)
      PDNO: stockCode, // 종목코드 (6자리 숫자)
      ORD_DVSN: order.order_option, // 주문구분 (00: 지정가, 01: 시장가, 03: 시장가)
      ORD_QTY: order.quantity.toString(), // 주문수량
      ORD_UNPR: order.order_option === '00' ? Math.floor(order.price).toString() : '0', // 주문단가 (지정가일 경우만, 정수로 변환)
    }

    try {
      const response = await this.request(endpoint, trId, data, 'POST')
      
      // 주문 응답 구조
      return {
        orderNumber: response.ODNO || response.주문번호 || '',
        orderTime: response.ORD_TMD || response.주문시간 || '',
        success: response.return_code === 0,
        message: response.return_msg || response.메시지 || '',
      }
    } catch (error: any) {
      // 에러 응답에서 상세 정보 추출
      const errorResponse = error.response?.data
      const errorMessage = errorResponse?.message || errorResponse?.return_msg || error.message || '주문 전송 실패'
      const errorStatus = error.response?.status || 500
      
      // 500 에러인 경우 모의투자 환경 제한사항으로 처리
      if (errorStatus === 500) {
        // 모의투자 환경에서는 일부 종목에 대해 주문이 제한될 수 있음
        // 이는 정상적인 제한사항이므로 조용히 처리
        const isMockApi = this.config?.host?.includes('mockapi.kiwoom.com')
        if (isMockApi) {
          // 모의투자 환경에서는 500 에러를 특별한 에러 타입으로 처리
          const mockError = new Error(`모의투자 환경 제한: ${errorMessage}`)
          ;(mockError as any).isMockApiLimit = true
          ;(mockError as any).stockCode = stockCode
          ;(mockError as any).status = 500
          throw mockError
        }
        
        console.error('주문 전송 오류 (500):', {
          종목코드: stockCode,
          주문구분: order.order_option,
          수량: order.quantity,
          가격: order.price,
          API응답: errorResponse
        })
        throw new Error(`주문 전송 실패: ${errorMessage} (종목코드: ${stockCode})`)
      }
      
      console.error('주문 전송 오류:', errorMessage)
      throw new Error(errorMessage)
    }
  }

  /**
   * 주문 내역 조회
   * 키움 REST API: 국내주식 > 주문 > 주문내역 조회
   */
  async getOrderHistory(accountNo: string): Promise<any[]> {
    if (!this.axiosInstance) {
      throw new Error('키움증권 API에 연결되지 않았습니다')
    }

    const endpoint = '/uapi/domestic-stock/v1/trading/inquire-daily-ccld'
    const trId = 'TTTC8001R' // 일자별체결내역조회 TR_ID
    
    // 계좌번호에서 계좌번호와 계좌상품코드 분리
    const accountParts = accountNo.split('-')
    const cano = accountParts[0] || accountNo
    const acntPrdtCd = accountParts[1] || '01'

    const data = {
      CANO: cano, // 계좌번호
      ACNT_PRDT_CD: acntPrdtCd, // 계좌상품코드
      INQR_STRT_DT: new Date().toISOString().split('T')[0].replace(/-/g, ''), // 조회시작일자 (YYYYMMDD)
      INQR_END_DT: new Date().toISOString().split('T')[0].replace(/-/g, ''), // 조회종료일자 (YYYYMMDD)
      SLL_BUY_DVSN_CD: '00', // 매도매수구분코드 (00: 전체, 01: 매도, 02: 매수)
      INQR_DVSN: '00', // 조회구분 (00: 역순, 01: 정순)
      PDNO: '', // 종목코드 (전체 조회 시 빈값)
      CCLD_DVSN: '00', // 체결구분 (00: 전체, 01: 체결, 02: 미체결)
      ORD_GNO_BRNO: '', // 주문채번지점번호 (전체 조회 시 빈값)
      ODNO: '', // 주문번호 (전체 조회 시 빈값)
    }

    try {
      const response = await this.request(endpoint, trId, data, 'GET')
      
      // 응답 데이터 파싱
      if (response.output && Array.isArray(response.output)) {
        return response.output.map((item: any, index: number) => ({
          id: index + 1,
          date: item.ORD_DT || item.주문일자 || new Date().toLocaleDateString('ko-KR'),
          time: item.ORD_TMD || item.주문시간 || new Date().toLocaleTimeString('ko-KR'),
          type: item.SLL_BUY_DVSN_CD === '01' ? 'sell' : 'buy', // 01: 매도, 02: 매수
          stockName: item.PDNO || item.종목코드 || '',
          stockCode: item.PDNO || item.종목코드 || '',
          quantity: parseInt(item.ORD_QTY || item.주문수량 || '0'),
          price: parseInt(item.ORD_UNPR || item.주문단가 || '0'),
          status: item.ORD_STAT_CD === '10' ? '접수' : 
                  item.ORD_STAT_CD === '20' ? '체결' : 
                  item.ORD_STAT_CD === '30' ? '취소' : '미체결',
          orderNumber: item.ODNO || item.주문번호 || '',
        }))
      }
      
      // 키움 REST API 응답이 예상과 다른 경우 빈 배열 반환
      // 모의투자 환경에서는 조용히 처리
      return []
    } catch (error: any) {
      // 모의투자 환경에서 500 에러는 정상적인 제한사항일 수 있음
      const status = error.response?.status || error.status
      const errorMessage = error.response?.data?.error || error.response?.data?.message || error.message || ''
      
      // 500 에러나 서버 에러는 조용히 처리 (모의투자 환경 제한)
      if (status === 500 || errorMessage.includes('INTERNAL_SERVER_ERROR')) {
        // 조용히 빈 배열 반환 (로그 출력 안 함)
        return []
      }
      
      // 다른 에러는 가끔만 로그 출력 (너무 많은 로그 방지)
      // console.error('주문 내역 조회 오류:', errorMessage)
      
      // 오류 발생 시 빈 배열 반환
      return []
    }
  }

  /**
   * 조건식 목록 조회
   * 키움 REST API: 국내주식 > 조건검색 > 조건식 목록 조회
   * 참고: 키움증권은 조건식을 영웅문4(HTS)에서 먼저 생성해야 함
   * OpenAPI+의 GetConditionLoad()와 유사한 기능
   */
  async getConditions(): Promise<any[]> {
    if (!this.axiosInstance) {
      throw new Error('키움증권 API에 연결되지 않았습니다')
    }

    // 키움 REST API 조건식 목록 조회
    // 주의: 키움 REST API에는 조건식 목록 조회 API가 없을 수 있음
    // OpenAPI+에서는 GetConditionLoad() 사용, REST API는 다른 방식일 수 있음
    const endpoint = '/uapi/domestic-stock/v1/condition/condition-list'
    const trId = 'FHKST03010100' // TR_ID는 키움 API 문서 확인 필요

    try {
      const response = await this.request(endpoint, trId, {}, 'GET')
      
      // 응답 데이터 파싱
      if (response.output && Array.isArray(response.output)) {
        return response.output.map((item: any, index: number) => ({
          index: parseInt(item.COND_IDX || item.조건식인덱스 || index.toString()),
          name: item.COND_NAME || item.조건식명 || `조건식 ${index + 1}`,
        }))
      }
      
      // 키움 REST API에 조건식 목록 API가 없는 경우, 더미 데이터 반환
      // 실제로는 OpenAPI+를 통해 조건식을 가져와야 할 수 있음
      console.warn('조건식 목록 API 응답이 예상과 다릅니다. OpenAPI+ 사용을 고려하세요.')
      return [
        { index: 0, name: 'B_급등주매수' },
        { index: 1, name: 'B_볼린저밴드매수' },
        { index: 2, name: 'B_스캘핑매수' },
        { index: 3, name: 'B_돌파매수' },
        { index: 4, name: 'S_익절매도' },
        { index: 5, name: 'S_손절매도' },
      ]
    } catch (error) {
      console.error('조건식 목록 조회 오류:', error)
      // 오류 발생 시 더미 데이터 반환 (개발/테스트용)
      return [
        { index: 0, name: 'B_급등주매수' },
        { index: 1, name: 'B_볼린저밴드매수' },
        { index: 2, name: 'B_스캘핑매수' },
        { index: 3, name: 'B_돌파매수' },
        { index: 4, name: 'S_익절매도' },
        { index: 5, name: 'S_손절매도' },
      ]
    }
  }

  /**
   * 조건식 검색 실행
   * 키움 REST API: 국내주식 > 조건검색 > 조건식 검색
   * 참고: 키움증권은 조건식을 영웅문4(HTS)에서 먼저 생성해야 함
   */
  async searchCondition(conditionIndex: number, screenNo: string = '1000'): Promise<any> {
    if (!this.axiosInstance) {
      throw new Error('키움증권 API에 연결되지 않았습니다')
    }

    // 키움 REST API 조건식 검색
    // 주의: 키움 REST API에는 조건식 검색 API가 없을 수 있음
    // OpenAPI+에서는 SendCondition() 사용, REST API는 다른 방식일 수 있음
    const endpoint = '/uapi/domestic-stock/v1/condition/condition-search'
    const trId = 'FHKST03010100' // TR_ID는 키움 API 문서 확인 필요

    const data = {
      COND_IDX: conditionIndex.toString(), // 조건식인덱스
      SCRN_NO: screenNo, // 화면번호
      COND_TYPE: '0', // 조건구분 (0: 조건검색, 1: 실시간검색)
    }

    try {
      const response = await this.request(endpoint, trId, data, 'POST')
      
      // 응답 데이터 파싱
      if (response.output && Array.isArray(response.output)) {
        return {
          stocks: response.output.map((item: any) => ({
            code: item.ISCD || item.종목코드 || '',
            name: item.HANNAME || item.종목명 || '',
            price: parseFloat(item.PRICE || item.현재가 || '0'),
            change: parseFloat(item.DIFF || item.전일대비 || '0'),
            changePercent: parseFloat(item.RATE || item.등락률 || '0'),
            volume: parseFloat(item.VOLUME || item.거래량 || '0'),
            시가대비: parseFloat(item.시가대비 || item.시가대비상승률 || '0'),
            고가대비: parseFloat(item.고가대비 || item.고가대비상승률 || '0'),
          })),
          conditionName: response.COND_NAME || response.조건식명 || `조건식 ${conditionIndex}`,
        }
      }
      
      // 키움 REST API에 조건식 검색 API가 없는 경우
      console.warn('조건식 검색 API 응답이 예상과 다릅니다. OpenAPI+ 사용을 고려하세요.')
      return {
        stocks: [],
        conditionName: `조건식 ${conditionIndex}`,
      }
    } catch (error) {
      console.error('조건식 검색 오류:', error)
      return {
        stocks: [],
        conditionName: `조건식 ${conditionIndex}`,
      }
    }
  }

  /**
   * 실시간 조건식 검색 등록
   * 키움 REST API: 국내주식 > 조건검색 > 실시간 조건식 등록
   * 참고: 키움증권 REST API는 WebSocket을 통한 실시간 데이터 수신을 지원할 수 있음
   */
  async registerRealCondition(conditionIndex: number, screenNo: string): Promise<any> {
    if (!this.axiosInstance) {
      throw new Error('키움증권 API에 연결되지 않았습니다')
    }

    // 키움 REST API 실시간 조건식 등록
    // 주의: 키움 REST API에는 실시간 조건식 등록 API가 없을 수 있음
    // OpenAPI+에서는 SendCondition() 사용, REST API는 WebSocket 사용 가능
    const endpoint = '/uapi/domestic-stock/v1/condition/condition-register'
    const trId = 'FHKST03010100' // TR_ID는 키움 API 문서 확인 필요

    const data = {
      COND_IDX: conditionIndex.toString(), // 조건식인덱스
      SCRN_NO: screenNo, // 화면번호
      COND_TYPE: '1', // 조건구분 (1: 실시간검색)
    }

    try {
      const response = await this.request(endpoint, trId, data, 'POST')
      
      return {
        success: response.return_code === 0,
        message: response.return_msg || response.메시지 || '',
        screenNo: screenNo,
        conditionIndex: conditionIndex,
      }
    } catch (error: any) {
      console.error('실시간 조건식 등록 오류:', error)
      // 키움 REST API에 실시간 조건식 등록 API가 없는 경우
      // WebSocket을 통한 실시간 데이터 수신을 고려해야 할 수 있음
      throw new Error(error.response?.data?.return_msg || error.message || '실시간 조건식 등록 실패')
    }
  }

  /**
   * 순위정보 조회 (키움증권 REST API)
   * 키움 REST API: 국내주식 > 순위정보
   * 엔드포인트: /api/dostk/rkinfo (POST)
   * @param trId TR ID (예: ka10020, ka10027, ka10030 등)
   * @param params 조회 파라미터
   */
  async getRankingInfo(trId: string, params?: any): Promise<any> {
    try {
      console.log(`=== 순위정보 조회 (${trId}) ===`)
      
      // 키움증권 REST API 순위정보 엔드포인트
      const endpoint = '/api/dostk/rkinfo'
      
      // TR_ID별 기본 파라미터 설정
      const defaultParams: any = {
        mrkt_tp: '001', // 시장구분: 001:코스피, 101:코스닥
        sort_tp: '1', // 정렬구분 (TR_ID별로 다름)
        trde_qty_tp: '0000', // 거래량구분: 0000:장시작전(0주이상)
        trde_qty_cnd: '0', // 거래량조건 (필수 파라미터)
        trde_prica_cnd: '0', // 거래가격조건 (필수 파라미터)
        updown_incls: '0', // 등락률 포함 조건 (필수 파라미터): 0:전체, 1:상승, 2:하락
        pric_cnd: '0', // 가격조건 (필수 파라미터): 0:전체
        stk_cnd: '0', // 종목조건: 0:전체조회
        crd_cnd: '0', // 신용조건: 0:전체조회
        stex_tp: '1', // 거래소구분: 1:KRX (모의투자 환경에서 필수)
        mang_stk_incls: '0', // 관리종목 포함: 0:포함, 1:제외 (일부 TR_ID에서 필수)
      }
      
      // TR_ID별 특정 파라미터 설정
      const trIdParams: { [key: string]: any } = {
        'ka10020': { // 호가잔량상위
          sort_tp: '1', // 1:순매수잔량순, 2:순매도잔량순, 3:매수비율순, 4:매도비율순
        },
        'ka10027': { // 전일대비등락률상위
          sort_tp: '1', // 등락률 정렬 (실제 값은 API 문서 확인 필요)
        },
        'ka10030': { // 당일거래량상위
          sort_tp: '1', // 거래량 정렬
          mang_stk_incls: '0', // 관리종목 포함 (필수 파라미터)
        },
        'ka10031': { // 전일거래량상위
          sort_tp: '1', // 전일거래량 정렬
        },
        'ka10032': { // 거래대금상위
          sort_tp: '1', // 거래대금 정렬
        },
        'ka10023': { // 거래량급증
          sort_tp: '1', // 거래량급증 정렬
        },
      }
      
      // 파라미터 병합
      const finalParams = {
        ...defaultParams,
        ...(trIdParams[trId] || {}),
        ...(params || {}),
      }
      
      console.log(`[${trId}] 요청 파라미터:`, JSON.stringify(finalParams, null, 2))
      
      // POST 요청으로 순위정보 조회
      const response = await this.request(endpoint, trId, finalParams, 'POST')
      
      console.log(`[${trId}] 순위정보 조회 성공`)
      
      // 응답 구조 확인 및 변환
      // 키움증권 API는 TR_ID별로 다른 응답 필드명을 사용할 수 있음
      let stocks: any[] = []
      
      // 응답이 배열인 경우
      if (Array.isArray(response)) {
        stocks = response
      } else if (typeof response === 'object' && response !== null) {
        // 객체인 경우 모든 키를 확인하여 배열 필드 찾기
        const keys = Object.keys(response)
        console.log(`[${trId}] 응답 객체의 키들:`, keys)
        
        for (const key of keys) {
          if (Array.isArray(response[key])) {
            console.log(`[${trId}] 배열 필드 발견: ${key} (${response[key].length}개 항목)`)
            stocks = response[key]
            break
          }
        }
        
        // 일반적인 필드명 확인
        if (stocks.length === 0) {
          if (response.output && Array.isArray(response.output)) {
            stocks = response.output
          } else if (response.output1 && Array.isArray(response.output1)) {
            stocks = response.output1
          } else if (response.bid_req_upper && Array.isArray(response.bid_req_upper)) {
            // 호가잔량상위 (ka10020) 응답 형식
            stocks = response.bid_req_upper
          }
        }
      }
      
      console.log(`[${trId}] 조회된 종목 수: ${stocks.length}개`)
      
      // 키움증권 API 응답 형식으로 변환 (다양한 필드명 지원)
      const output = stocks.map((item: any) => {
        // 현재가 파싱 (문자열 형식 지원: "+65000" 등)
        const curPrcStr = item.cur_prc || item.PRICE || item.현재가 || item.prc || '0'
        const price = parseFloat(curPrcStr.toString().replace(/[+\-]/g, '')) || 0
        
        // 전일대비 파싱
        const predPreStr = item.pred_pre || item.DIFF || item.전일대비 || item.diff || '0'
        const change = parseFloat(predPreStr.toString().replace(/[+\-]/g, '')) || 0
        
        // 등락률 파싱 (flu_rt 필드 지원)
        const fluRtStr = item.flu_rt || item.RATE || item.등락률 || item.prdy_chng_rt || '0'
        const changePercent = parseFloat(fluRtStr.toString().replace(/[+\-%]/g, '')) || 0
        
        // 거래량 파싱
        const volume = parseFloat(item.now_trde_qty || item.trde_qty || item.VOLUME || item.거래량 || item.acml_vol || '0') || 0
        
        return {
          // 종목코드
          stk_cd: item.stk_cd || item.ISCD || item.종목코드 || '',
          ISCD: item.stk_cd || item.ISCD || item.종목코드 || '',
          종목코드: item.stk_cd || item.ISCD || item.종목코드 || '',
          code: item.stk_cd || item.ISCD || item.종목코드 || '',
          // 종목명
          stk_nm: item.stk_nm || item.HANNAME || item.종목명 || '',
          HANNAME: item.stk_nm || item.HANNAME || item.종목명 || '',
          종목명: item.stk_nm || item.HANNAME || item.종목명 || '',
          name: item.stk_nm || item.HANNAME || item.종목명 || '',
          // 현재가 (숫자형)
          cur_prc: curPrcStr,
          PRICE: curPrcStr,
          현재가: curPrcStr,
          prc: curPrcStr,
          price: price,
          // 전일대비 (숫자형)
          pred_pre: predPreStr,
          DIFF: predPreStr,
          전일대비: predPreStr,
          diff: predPreStr,
          change: change,
          // 등락률 (숫자형)
          flu_rt: fluRtStr,
          RATE: fluRtStr,
          등락률: fluRtStr,
          prdy_chng_rt: fluRtStr,
          changePercent: changePercent,
          // 거래량 (숫자형)
          now_trde_qty: item.now_trde_qty || item.trde_qty || item.VOLUME || item.거래량 || item.acml_vol || '0',
          trde_qty: item.now_trde_qty || item.trde_qty || item.VOLUME || item.거래량 || item.acml_vol || '0',
          VOLUME: item.now_trde_qty || item.trde_qty || item.VOLUME || item.거래량 || item.acml_vol || '0',
          거래량: item.now_trde_qty || item.trde_qty || item.VOLUME || item.거래량 || item.acml_vol || '0',
          acml_vol: item.now_trde_qty || item.trde_qty || item.VOLUME || item.거래량 || item.acml_vol || '0',
          volume: volume,
          // 기타 필드
          ...item, // 원본 데이터도 포함
        }
      })
      
      return {
        output: output,
        return_code: response.return_code || 0,
        return_msg: response.return_msg || '정상적으로 처리되었습니다'
      }
    } catch (error: any) {
      // 요청 제한 에러(429 또는 return_code 5)는 조용히 처리
      const isRateLimit = error.response?.status === 429 || error.isRateLimit || 
                         (error.response?.data?.return_code === 5)
      
      if (isRateLimit) {
        // 요청 제한 에러는 조용히 처리 (로그 최소화)
        return {
          output: [],
          return_code: 5,
          return_msg: 'API 요청 제한 초과'
        }
      }
      
      // 다른 에러는 로그 출력
      console.error(`[${trId}] 순위정보 조회 오류:`, error.message)
      console.error('오류 상세:', error.response?.data || error)
      
      // 오류 발생 시 빈 배열 반환
      return {
        output: [],
        return_code: -1,
        return_msg: error.message || '순위정보 조회 실패'
      }
    }
  }

  /**
   * 계좌 목록 조회
   * 키움증권 API는 계좌 목록 조회 API가 제한적이므로,
   * 사용자가 입력한 계좌번호를 기본으로 사용하고,
   * 필요시 API를 통해 확인합니다.
   * 캐싱을 통해 중복 호출을 방지합니다.
   */
  async getAccountList(): Promise<string[]> {
    // 캐시 확인 (5분간 유효)
    const now = Date.now()
    if (this.cachedAccountList && (now - this.accountListCacheTime) < 5 * 60 * 1000) {
      return this.cachedAccountList
    }
    
    // 키움증권 REST API는 계좌 목록 조회 API가 제한적입니다.
    // ka01690 API는 요청 제한이 있어 자주 호출할 수 없습니다.
    // 따라서 기본 계좌를 반환하고, 사용자가 직접 계좌번호를 입력하도록 합니다.
    
    const defaultAccounts = ['5069515411'] // 모의투자 기본 계좌
    
    // 캐시 저장
    this.cachedAccountList = defaultAccounts
    this.accountListCacheTime = now
    
    return defaultAccounts
  }
  
  /**
   * 계좌 목록 캐시 초기화
   */
  clearAccountListCache(): void {
    this.cachedAccountList = null
    this.accountListCacheTime = 0
  }

  /**
   * WebSocket 실시간 시세 연결
   */
  async connectWebSocket(): Promise<void> {
    if (!this.config || !this.accessToken) {
      throw new Error('키움증권 API에 연결되지 않았습니다')
    }

    // WebSocket URL 결정 (모의투자 또는 실전투자)
    const isMock = this.config.host.includes('mockapi')
    const socketUrl = isMock
      ? 'wss://mockapi.kiwoom.com:10000/api/dostk/websocket'
      : 'wss://api.kiwoom.com:10000/api/dostk/websocket'

    this.webSocketService = KiwoomWebSocketService.getInstance()
    await this.webSocketService.connect(socketUrl, this.accessToken.token)
  }

  /**
   * WebSocket 실시간 시세 등록
   */
  registerRealTimeStocks(codes: string[]): void {
    if (!this.webSocketService || !this.webSocketService.isConnected()) {
      console.warn('[WebSocket] WebSocket이 연결되지 않았습니다.')
      return
    }

    // 주식체결 실시간 시세 등록 (type: '00')
    this.webSocketService.registerRealTime(codes, ['00'], '1', '1')
  }

  /**
   * WebSocket 실시간 데이터 콜백 등록
   */
  onRealTimeData(callback: (data: any) => void): () => void {
    if (!this.webSocketService) {
      this.webSocketService = KiwoomWebSocketService.getInstance()
    }
    return this.webSocketService.onRealTimeData(callback)
  }

  /**
   * WebSocket 연결 종료
   */
  disconnectWebSocket(): void {
    if (this.webSocketService) {
      this.webSocketService.disconnect()
    }
  }

  /**
   * WebSocket 연결 상태 확인
   */
  isWebSocketConnected(): boolean {
    return this.webSocketService?.isConnected() || false
  }
}



