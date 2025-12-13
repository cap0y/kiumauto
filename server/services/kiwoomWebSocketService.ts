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
  private static instance: KiwoomWebSocketService
  private websocket: WebSocket | null = null
  private config: WebSocketConfig | null = null
  private connected: boolean = false
  private loggedIn: boolean = false
  private pingInterval: NodeJS.Timeout | null = null
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 5
  private reconnectDelay: number = 3000
  private dataCallbacks: Set<RealTimeDataCallback> = new Set()

  private constructor() {}

  static getInstance(): KiwoomWebSocketService {
    if (!KiwoomWebSocketService.instance) {
      KiwoomWebSocketService.instance = new KiwoomWebSocketService()
    }
    return KiwoomWebSocketService.instance
  }

  /**
   * WebSocket 연결
   */
  async connect(socketUrl: string, accessToken: string): Promise<void> {
    if (this.websocket && this.connected) {
      console.log('[WebSocket] 이미 연결되어 있습니다.')
      return
    }

    this.config = { socketUrl, accessToken }

    return new Promise((resolve, reject) => {
      try {
        console.log(`[WebSocket] 연결 시도: ${socketUrl}`)
        this.websocket = new WebSocket(socketUrl)

        // 연결 성공
        this.websocket.on('open', () => {
          console.log('[WebSocket] 서버와 연결되었습니다.')
          this.connected = true
          this.reconnectAttempts = 0

          // 로그인 패킷 전송
          const loginPacket = {
            trnm: 'LOGIN',
            token: accessToken,
          }

          console.log('[WebSocket] 로그인 패킷 전송')
          this.sendMessage(loginPacket)

          // PING 인터벌 시작 (30초마다)
          this.startPingInterval()

          resolve()
        })

        // 에러 발생
        this.websocket.on('error', (error) => {
          console.error('[WebSocket] 연결 오류:', error)
          this.connected = false
          this.loggedIn = false
          reject(error)
        })

        // 연결 종료
        this.websocket.on('close', () => {
          console.log('[WebSocket] 연결이 종료되었습니다.')
          this.connected = false
          this.loggedIn = false
          this.stopPingInterval()

          // 자동 재연결 시도
          if (this.reconnectAttempts < this.maxReconnectAttempts && this.config) {
            this.reconnectAttempts++
            console.log(`[WebSocket] 재연결 시도 ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`)
            setTimeout(() => {
              this.connect(this.config!.socketUrl, this.config!.accessToken).catch(console.error)
            }, this.reconnectDelay)
          }
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
                this.disconnect()
                reject(new Error(response.return_msg || '로그인 실패'))
              } else {
                console.log('[WebSocket] 로그인 성공')
                this.loggedIn = true
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
    types: string[] = ['00'], // '00': 주식체결
    grpNo: string = '1',
    refresh: string = '1'
  ): void {
    if (!this.loggedIn) {
      console.warn('[WebSocket] 로그인되지 않아 실시간 시세를 등록할 수 없습니다.')
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

    console.log(`[WebSocket] 실시간 시세 등록: ${items.length}개 종목`)
    this.sendMessage(registerPacket)
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
   */
  disconnect(): void {
    this.stopPingInterval()
    if (this.websocket) {
      this.websocket.close()
      this.websocket = null
    }
    this.connected = false
    this.loggedIn = false
    this.dataCallbacks.clear()
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

