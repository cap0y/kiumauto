/**
 * 키움증권 WebSocket 실시간 시세 서비스
 * 키움증권 WebSocket API와 통신하는 서비스 클래스
 */
import WebSocket from 'ws'

interface WebSocketConfig {
  socketUrl: string // wss://api.kiwoom.com:10000/api/dostk/websocket 또는 wss://mockapi.kiwoom.com:10000/api/dostk/websocket
  accessToken: string
}

interface RealTimeData {
  trnm: string
  data?: Array<{
    values: Record<string, string>
    type: string
    name: string
    item: string
  }>
  return_code?: number
  return_msg?: string
}

type RealTimeDataCallback = (data: RealTimeData) => void

export class KiwoomWebSocketService {
  private websocket: WebSocket | null = null
  private config: WebSocketConfig | null = null
  private connected: boolean = false
  private loggedIn: boolean = false
  private pingInterval: NodeJS.Timeout | null = null
  private reconnectAttempts: number = 0
  private reconnectDelay: number = 3000
  private dataCallbacks: Set<RealTimeDataCallback> = new Set()
  // 재연결 시 최신 토큰을 받아오기 위한 공급자 (만료된 토큰으로 재시도하면 영구 실패)
  private tokenProvider: (() => Promise<string>) | null = null
  // 등록된 실시간 항목을 기억한다. 연결이 끊겼다 돌아오면 이걸로 다시 등록해야
  // 시세가 영구히 끊기지 않는다 (서버 재시작·네트워크 단절 후 복구용).
  private registrations: Map<string, { items: Set<string>; types: Set<string> }> = new Map()

  // 사용자(계좌)별로 독립 인스턴스를 만든다. 계정이 다르면 시세 등록도 분리돼야 한다.
  constructor() {}

  /**
   * WebSocket 연결
   */
  async connect(socketUrl: string, accessToken: string, tokenProvider?: () => Promise<string>): Promise<void> {
    if (this.websocket && this.connected) {
      console.log('[WebSocket] 이미 연결되어 있습니다.')
      // 토큰 갱신 수단은 항상 최신 것으로 교체
      if (tokenProvider) this.tokenProvider = tokenProvider
      return
    }

    if (tokenProvider) this.tokenProvider = tokenProvider
    this.config = { socketUrl, accessToken }

    return new Promise((resolve, reject) => {
      try {
        console.log(`[WebSocket] 연결 시도: ${socketUrl}`)
        this.websocket = new WebSocket(socketUrl)

        // 로그인 응답 전에는 등록 요청을 보낼 수 없으므로 LOGIN 응답에서 resolve
        const settle = { done: false }
        const failLogin = (message: string) => {
          if (settle.done) return
          settle.done = true
          reject(new Error(message))
        }

        // 연결 성공
        this.websocket.on('open', () => {
          console.log('[WebSocket] 서버와 연결되었습니다.')
          this.connected = true
          this.reconnectAttempts = 0

          // 로그인 패킷 전송
          console.log('[WebSocket] 로그인 패킷 전송')
          this.sendMessage({ trnm: 'LOGIN', token: accessToken })

          // PING 인터벌 시작 (30초마다)
          this.startPingInterval()
        })

        // 에러 발생
        this.websocket.on('error', (error) => {
          console.error('[WebSocket] 연결 오류:', error)
          this.connected = false
          this.loggedIn = false
          settle.done ? undefined : failLogin((error as any)?.message || 'WebSocket 연결 오류')
        })

        // 연결 종료
        this.websocket.on('close', () => {
          console.log('[WebSocket] 연결이 종료되었습니다.')
          this.connected = false
          this.loggedIn = false
          this.stopPingInterval()

          // 자동 재연결: 횟수 제한 없이 계속 시도한다.
          // 한 번 실패로 시세가 영구히 멈추면 실시간 기능 자체가 죽는다.
          if (!this.config) return
          // 재연결 지수 백오프 (최대 30초)
          const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000)
          this.reconnectAttempts++
          console.log(`[WebSocket] ${Math.round(delay / 1000)}초 후 재연결 시도 (${this.reconnectAttempts}회차)`)
          setTimeout(() => {
            if (!this.loggedIn && this.config) {
              // 재연결 전에 최신 토큰을 받아온다 (만료 토큰으로는 로그인 불가)
              const reconnect = async () => {
                if (this.tokenProvider) {
                  try {
                    this.config!.accessToken = await this.tokenProvider()
                  } catch (error: any) {
                    console.error('[WebSocket] 토큰 갱신 실패:', error.message)
                  }
                }
                await this.connect(this.config!.socketUrl, this.config!.accessToken)
              }
              reconnect().catch((error) => {
                console.error('[WebSocket] 재연결 실패:', error.message)
              })
            }
          }, delay)
        })

        // 메시지 수신
        this.websocket.on('message', (data: WebSocket.Data) => {
          try {
            const response: RealTimeData = JSON.parse(data.toString())

            // PING 처리
            if (response.trnm === 'PING') {
              this.sendMessage(response) // PONG 응답
              return
            }

            // LOGIN 응답 처리
            if (response.trnm === 'LOGIN') {
              if (response.return_code !== 0) {
                console.error('[WebSocket] 로그인 실패:', response.return_msg)
                failLogin(response.return_msg || '로그인 실패')
                this.disconnect()
              } else {
                console.log('[WebSocket] 로그인 성공')
                this.loggedIn = true
                this.reconnectAttempts = 0
                // 끊겼다 돌아왔으면 기존 등록을 복구해야 시세가 다시 흐른다
                this.replayRegistrations()
                if (!settle.done) {
                  settle.done = true
                  resolve()
                }
              }
              return
            }

            // 실시간 데이터 수신
            if (response.trnm === 'REAL') {
              // 콜백 함수들 호출
              this.dataCallbacks.forEach((callback) => {
                try {
                  callback(response)
                } catch (error) {
                  console.error('[WebSocket] 콜백 실행 오류:', error)
                }
              })
            }

            // REG 응답 처리
            if (response.trnm === 'REG') {
              if (response.return_code === 0) {
                console.log('[WebSocket] 실시간 시세 등록 성공')
              } else {
                console.error('[WebSocket] 실시간 시세 등록 실패:', response.return_msg)
              }
            }

            // PING이 아닌 경우에만 로그 출력
            if (response.trnm !== 'PING') {
              console.log('[WebSocket] 실시간 시세 서버 응답 수신:', JSON.stringify(response).substring(0, 200))
            }
          } catch (error) {
            console.error('[WebSocket] 메시지 파싱 오류:', error)
          }
        })
      } catch (error) {
        console.error('[WebSocket] 연결 생성 오류:', error)
        reject(error)
      }
    })
  }

  /**
   * WebSocket 메시지 전송
   */
  sendMessage(message: any): void {
    if (this.connected && this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      const messageStr = JSON.stringify(message)
      this.websocket.send(messageStr)
      if (message.trnm !== 'PING') {
        console.log(`[WebSocket] 메시지 전송:`, JSON.stringify(message).substring(0, 200))
      }
    } else {
      console.warn('[WebSocket] WebSocket 연결이 없습니다.')
    }
  }

  /**
   * 실시간 시세 등록
   * @param items 종목코드 배열 (예: ['005930', '000660'])
   * @param types 실시간 항목 타입 배열 (예: ['00'] - 주식체결)
   * @param grpNo 그룹번호 (기본값: '1')
   * @param refresh 기존등록유지여부 (기본값: '1')
   */
  registerRealTime(
    items: string[],
    types: string[] = ['0B'],
    grpNo: string = '1',
    refresh: string = '1'
  ): void {
    // 그룹별 등록 상태를 기억한다 (재연결 시 복구용)
    const group = this.registrations.get(grpNo) || { items: new Set<string>(), types: new Set<string>() }
    if (refresh === '0') {
      // 기존 등록을 전부 해지하고 새로 등록하는 요청
      group.items.clear()
    }
    items.forEach((item) => group.items.add(item))
    types.forEach((type) => group.types.add(type))
    this.registrations.set(grpNo, group)

    if (!this.loggedIn) {
      console.warn('[WebSocket] 로그인되지 않아 실시간 시세를 등록할 수 없습니다. (재연결 시 자동 등록)')
      return
    }

    const registerPacket = {
      trnm: 'REG',
      grp_no: grpNo,
      refresh: refresh,
      data: [
        {
          item: items,
          type: types,
        },
      ],
    }

    console.log(`[WebSocket] 실시간 등록: grp=${grpNo}, ${items.length}개 종목, type=${types.join(',')}`)
    this.sendMessage(registerPacket)
  }

  /**
   * 재연결 후 기억해둔 등록을 복구한다.
   * 이게 없으면 끊겼다 돌아온 뒤로는 시세가 영구히 오지 않는다.
   */
  private replayRegistrations(): void {
    if (this.registrations.size === 0) return

    console.log(`[WebSocket] 등록 복구 시작 (${this.registrations.size}개 그룹)`)
    this.registrations.forEach((group, grpNo) => {
      const items = Array.from(group.items)
      const types = Array.from(group.types)
      if (items.length === 0 || types.length === 0) return

      // 서버는 재연결로 상태가 비었으므로 refresh '0'(새로 등록)으로 보낸다
      this.sendMessage({
        trnm: 'REG',
        grp_no: grpNo,
        refresh: '0',
        data: [{ item: items, type: types }],
      })
      console.log(`[WebSocket] 등록 복구: grp=${grpNo}, ${items.length}개 종목`)
    })
  }

  /**
   * 실시간 데이터 콜백 등록
   */
  onRealTimeData(callback: RealTimeDataCallback): () => void {
    this.dataCallbacks.add(callback)
    // 콜백 제거 함수 반환
    return () => {
      this.dataCallbacks.delete(callback)
    }
  }

  /**
   * PING 인터벌 시작
   */
  private startPingInterval(): void {
    this.stopPingInterval()
    // 30초마다 PING 전송 (키움증권 서버가 PING을 보내면 자동으로 응답)
    this.pingInterval = setInterval(() => {
      // 서버가 PING을 보내면 자동으로 응답하므로 여기서는 아무것도 하지 않음
    }, 30000)
  }

  /**
   * PING 인터벌 중지
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  /**
   * WebSocket 연결 종료
   * 주의: dataCallbacks는 지우지 않는다. 재연결해도 서버의 브로드캐스트 리스너가 살아 있어야 한다.
   */
  disconnect(): void {
    this.stopPingInterval()
    if (this.websocket) {
      this.websocket.removeAllListeners()
      this.websocket.close()
      this.websocket = null
    }
    this.connected = false
    this.loggedIn = false
    console.log('[WebSocket] 연결 종료')
  }

  /**
   * 연결 상태 확인
   */
  isConnected(): boolean {
    return this.connected && this.loggedIn && this.websocket?.readyState === WebSocket.OPEN
  }

  /**
   * 로그인 상태 확인
   */
  isLoggedIn(): boolean {
    return this.loggedIn
  }
}

