/**
 * 키움증권 자동매매 API 서버
 * Express + TypeScript 기반 백엔드 서버
 */
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import routes from './routes/index'
import { KiwoomService } from './services/kiwoomService'

// 환경 변수 로드
dotenv.config()

const app = express()
const PORT = process.env.PORT || 8000

// 미들웨어 설정
app.use(cors({
  origin: '*', // 프로덕션에서는 특정 도메인으로 제한
  credentials: true,
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 라우터 설정
app.use('/api', routes)

// 루트 엔드포인트
app.get('/', (req, res) => {
  res.json({
    message: '키움증권 자동매매 API 서버',
    status: 'running',
    version: '1.0.0'
  })
})

// HTTP 서버 생성
const server = createServer(app)

// WebSocket 서버 생성
const wss = new WebSocketServer({ server })

// WebSocket 연결 관리
const connectedClients = new Set<any>()

wss.on('connection', (ws) => {
  connectedClients.add(ws)
  console.log('WebSocket 클라이언트 연결됨')

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString())
      // 클라이언트로부터 메시지 수신 처리
      ws.send(JSON.stringify({ message: 'received', data }))
    } catch (error) {
      console.error('WebSocket 메시지 처리 오류:', error)
    }
  })

  ws.on('close', () => {
    connectedClients.delete(ws)
    console.log('WebSocket 클라이언트 연결 해제됨')
  })

  ws.on('error', (error) => {
    console.error('WebSocket 오류:', error)
    connectedClients.delete(ws)
  })
})

// 브로드캐스트 함수
export const broadcastMessage = (message: any) => {
  const data = JSON.stringify(message)
  connectedClients.forEach((client) => {
    if (client.readyState === 1) { // OPEN 상태
      client.send(data)
    }
  })
}

// 키움증권 WebSocket 실시간 데이터를 클라이언트에 브로드캐스트
const kiwoomService = KiwoomService.getInstance()
kiwoomService.onRealTimeData((data) => {
  // 실시간 시세 데이터를 모든 클라이언트에 브로드캐스트
  broadcastMessage({
    type: 'realtime',
    data: data,
  })
})

// 서버 시작
server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다`)
  console.log(`환경: ${process.env.NODE_ENV || 'development'}`)
})

export default app

