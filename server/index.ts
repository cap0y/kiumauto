/**
 * 키움증권 자동매매 API 서버
 * Express + TypeScript 기반 백엔드 서버
 */
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import routes from './routes/index'
import { KiwoomService } from './services/kiwoomService'
import { kiwoomRegistry } from './services/kiwoomRegistry'
import keyService from './services/keyService'
import userStateService from './services/userStateService'
import { LICENSE_COOKIE } from './middleware/auth'

// 환경 변수 로드
dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

/**
 * CORS 허용 목록.
 * 세션 쿠키를 쓰므로 origin '*' + credentials 조합은 브라우저가 거부하고,
 * 모든 사이트가 쿠키로 API를 호출할 수 있어 위험하다.
 * ALLOWED_ORIGINS(쉼표 구분)로 명시하고, 없으면 개발용 localhost만 허용한다.
 */
const allowedOrigins = (() => {
  const fromEnv = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (fromEnv.length > 0) return fromEnv
  return [
    'http://localhost:5000',
    'http://localhost:5001',
    'http://127.0.0.1:5000',
    'http://127.0.0.1:5001',
  ]
})()

// 미들웨어 설정
app.use(cors({  origin: (origin, callback) => {
    // 같은 출처(프록시 경유)·서버 간 요청은 origin이 없다 → 허용
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    // 거부하되 서버 오류로 만들지 않는다 (CORS 헤더만 생략)
    return callback(null, false)
  },
  credentials: true,
}))

// 프로덕션에서는 HTTPS를 강제한다.
// 라이선스 키·appkey가 오가고 쿠키가 secure로 설정되므로 평문 HTTP는 위험하다.
// 리버스 프록시(Nginx 등) 뒤에 있다면 X-Forwarded-Proto로 판단한다.
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next()
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim()
  if (proto === 'https') return next()
  // Railway 헬스체크(/health)는 내부 HTTP로 들어오므로 막지 않는다
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/api/kiwoom/status')) return next()
  return res.status(403).json({
    success: false,
    error: 'HTTPS 연결이 필요합니다',
    code: 'HTTPS_REQUIRED',
  })
})

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 라이선스 세션 쿠키(HttpOnly)를 읽으려면 쿠키 파서가 필요하다.
// cookie-parser 의존성 없이 헤더를 직접 파싱한다 (형식이 단순하다).
app.use((req, _res, next) => {
  const raw = req.headers.cookie
  if (raw) {
    const cookies: Record<string, string> = {}
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=')
      if (idx < 0) continue
      const name = part.slice(0, idx).trim()
      const value = part.slice(idx + 1).trim()
      if (name) {
        try {
          cookies[name] = decodeURIComponent(value)
        } catch {
          cookies[name] = value
        }
      }
    }
    ;(req as any).cookies = cookies
  } else {
    ;(req as any).cookies = {}
  }
  next()
})

// Railway 헬스체크 엔드포인트
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

/**
 * 배포 진단 (Railway에서 환경변수가 실제로 들어왔는지 확인)
 * GET /diagnostics
 *
 * 값 자체는 노출하지 않고 설정 여부만 알려준다.
 * "실현손익 0원"처럼 배포 환경 문제를 빠르게 찾기 위한 용도.
 */
app.get('/diagnostics', (_req, res) => {
  const has = (name: string) => String(process.env[name] || '').trim().length > 0
  res.json({
    nodeEnv: process.env.NODE_ENV || '(미설정)',
    databaseUrl: has('DATABASE_URL') ? '설정됨' : '없음 ⚠️',
    adminToken: has('ADMIN_TOKEN') ? '설정됨' : '없음',
    allowedOrigins: has('ALLOWED_ORIGINS') ? '설정됨' : '없음(기본 localhost)',
    keyStore: keyService.describeStore(),
    stateStore: userStateService.describeStore(),
    uptime: Math.round(process.uptime()),
  })
})

// API 라우터 설정
app.use('/api', routes)

// 정적 파일 제공 (프로덕션)
const distPath = path.resolve(__dirname, '../dist')
app.use(express.static(distPath))

// SPA 라우팅 - API가 아닌 모든 요청은 index.html로
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(distPath, 'index.html'))
  }
})

// HTTP 서버 생성
const server = createServer(app)

// WebSocket 서버 생성
// 세션 쿠키(HttpOnly)로 인증한다. 쿼리 문자열에 키를 넣으면
// 브라우저 히스토리·프록시 로그·서버 로그에 키가 그대로 남는다.
const wss = new WebSocketServer({
  server,
  verifyClient: (info: any, done: (ok: boolean, code?: number, msg?: string) => void) => {
    const cookieHeader = String(info.req?.headers?.cookie || '')
    const match = cookieHeader
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${LICENSE_COOKIE}=`))
    const cookieKey = match ? decodeURIComponent(match.slice(LICENSE_COOKIE.length + 1)) : ''

    // 쿠키가 없으면 쿼리(구버전 호환)도 허용
    const url = new URL(info.req?.url || '/', 'http://localhost')
    const queryKey = String(url.searchParams.get('key') || '')
    const key = (cookieKey || queryKey).trim()

    if (!key) {
      done(false, 4401, 'LICENSE_MISSING')
      return
    }
    // DB 조회가 비동기이므로 결과를 기다려 응답한다
    keyService
      .checkKey(key)
      .then((result) => {
        if (!result.valid) {
          done(false, 4401, 'LICENSE_INVALID')
          return
        }
        ;(info.req as any).sessionKey = key
        done(true)
      })
      .catch((error: any) => {
        console.error('[WebSocket] 세션 검증 오류:', error.message)
        done(false, 4503, 'AUTH_STORE_UNAVAILABLE')
      })
  },
})

// WebSocket 연결 관리 — 세션(라이선스 키)별로 소켓을 묶는다.
// 전부에게 브로드캐스트하면 A의 시세가 B 화면에도 흘러가고,
// 계좌 주문체결(00)까지 남의 화면에 노출된다.
const clientSessions = new Map<any, string>()

wss.on('connection', (ws, req) => {
  const sessionKey = String((req as any).sessionKey || '').trim()
  clientSessions.set(ws, sessionKey)
  console.log(`WebSocket 클라이언트 연결됨 (세션 ${sessionKey ? sessionKey.slice(0, 8) + '...' : '없음'})`)

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString())
      // 세션 키를 나중에 보내는 경우를 허용
      if (data?.type === 'auth' && typeof data.key === 'string') {
        clientSessions.set(ws, data.key.trim())
        ws.send(JSON.stringify({ type: 'auth', success: true }))
        return
      }
      ws.send(JSON.stringify({ message: 'received', data }))
    } catch (error) {
      console.error('WebSocket 메시지 처리 오류:', error)
    }
  })

  ws.on('close', () => {
    clientSessions.delete(ws)
    console.log('WebSocket 클라이언트 연결 해제됨')
  })

  ws.on('error', (error) => {
    console.error('WebSocket 오류:', error)
    clientSessions.delete(ws)
  })
})

// 브로드캐스트 함수
export const broadcastMessage = (message: any) => {
  const data = JSON.stringify(message)
  clientSessions.forEach((_session, client) => {
    if (client.readyState === 1) {
      client.send(data)
    }
  })
}

/** 특정 세션(라이선스 키)의 소켓에만 보낸다 */
export const sendToSession = (sessionKey: string, message: any) => {
  const data = JSON.stringify(message)
  clientSessions.forEach((session, client) => {
    if (session === sessionKey && client.readyState === 1) {
      client.send(data)
    }
  })
}

// 키움증권 WebSocket 실시간 데이터를 '해당 세션'에게만 전달한다
const bindRealtimeStream = (sessionKey: string, kiwoomService: KiwoomService) => {
  kiwoomService.onRealTimeData((data) => {
    sendToSession(sessionKey, { type: 'realtime', data })
  })
}

// ───────────────────────────── 미체결 자동취소 ─────────────────────────────
// 브라우저가 닫혀 있어도 동작해야 하므로 서버에서 수행한다.
// (클라이언트 타이머에 맡기면 화면을 닫은 사이 물량이 계속 잠긴다)
const UNFILLED_TIMEOUT_MS = 30_000 // 시장가 주문 30초
const AUTO_CANCEL_INTERVAL_MS = 5_000
// 취소 요청을 보낸 주문번호. 주문번호는 계좌별로 겹칠 수 있으므로 세션 키를 붙인다.
const cancelRequested = new Set<string>()
const autoCancelTimers = new Map<string, NodeJS.Timeout>()

const cancelKey = (sessionKey: string, orderNo: string) => `${sessionKey}::${orderNo}`

/** 'HHmmss' 또는 'HH:MM:SS' 형태의 주문 시각을 오늘 날짜의 epoch(ms)로 변환 */
const parseOrderTime = (time: string): number | null => {
  const raw = String(time || '').replace(/[^0-9]/g, '').padStart(6, '0')
  if (raw.length < 6) return null
  const hh = Number(raw.slice(0, 2))
  const mm = Number(raw.slice(2, 4))
  const ss = Number(raw.slice(4, 6))
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null
  const d = new Date()
  d.setHours(hh, mm, ss, 0)
  return d.getTime()
}

const startAutoCancelLoop = (sessionKey: string, kiwoomService: KiwoomService) => {
  if (autoCancelTimers.has(sessionKey)) return
  const timer = setInterval(async () => {
    if (!kiwoomService.isConnected()) return

    try {
      // 계좌번호가 없어도 kt00007은 토큰 계좌 기준으로 조회된다
      const orders = await kiwoomService.getOrderHistory()
      const pending = orders.filter((o: any) =>
        o.orderNumber &&
        (o.status === '접수' || o.status === '확인') &&
        !cancelRequested.has(cancelKey(sessionKey, String(o.orderNumber)))
      )
      if (pending.length === 0) return

      // 잔고의 매도가능수량으로 실제 물량이 잠겨 있는지 확인한다.
      // (kt00007은 이미 종료된 주문도 '접수'로 남기는 경우가 있다)
      const balance = await kiwoomService.getBalance()
      const holdings: any[] = Array.isArray(balance?.stocks) ? balance.stocks : []
      const now = Date.now()

      for (const order of pending) {
        const orderNo = String(order.orderNumber)
        const code = String(order.stockCode || '')
        const held = holdings.find((h: any) => String(h.code) === code)

        // 매도 주문인데 매도가능수량이 보유수량과 같으면 그 주문은 이미 죽었다
        const isGhost = order.type === 'sell' && held &&
          Number(held.sellableQuantity) >= Number(held.quantity)
        if (isGhost) {
          cancelRequested.add(cancelKey(sessionKey, orderNo))
          continue
        }

        // 지정가 주문은 체결을 기다려야 한다. 자동취소하면 영원히 체결되지 않는다.
        // (시장가만 미체결로 남으면 물량을 잠그고 의미가 없으므로 취소 대상)
        const orderPrice = Number(order.orderPrice) || 0
        if (orderPrice > 0) continue

        const placedAt = parseOrderTime(order.time)
        if (placedAt === null) continue
        if (now - placedAt < UNFILLED_TIMEOUT_MS) continue

        cancelRequested.add(cancelKey(sessionKey, orderNo))
        const qty = Number(order.unfilledQuantity) > 0
          ? Number(order.unfilledQuantity)
          : Number(order.quantity) || 0
        if (!code || qty <= 0) continue

        try {
          await kiwoomService.cancelOrder(orderNo, code, qty)
          console.log(`[자동취소] ${order.stockName || code} ${qty}주 취소 (원주문 ${orderNo})`)
        } catch (error: any) {
          console.log(`[자동취소] ${order.stockName || code} 실패: ${error.message}`)
        }
      }
    } catch (error: any) {
      console.log(`[자동취소] 주문 조회 실패: ${error.message}`)
    }
  }, AUTO_CANCEL_INTERVAL_MS)
  autoCancelTimers.set(sessionKey, timer)
}

/**
 * 세션이 새로 만들어졌을 때 실시간 스트림·자동취소를 그 세션에만 붙인다.
 * 레지스트리에서 onCreate 훅으로 호출한다.
 */
export const onSessionCreated = (sessionKey: string, service: KiwoomService) => {
  bindRealtimeStream(sessionKey, service)
  startAutoCancelLoop(sessionKey, service)
}

// 서버 시작 — 키 저장소(DB)를 먼저 초기화한다.
// 첫 요청에서 지연되거나 조용히 실패하면 로그인 자체가 막히므로 기동 시 확인한다.
const start = async () => {
  try {
    await keyService.initialize()
  } catch (error: any) {
    console.error('[시작] 키 저장소 초기화 실패:', error.message)
  }
  try {
    await userStateService.initialize()
  } catch (error: any) {
    console.error('[시작] 상태 저장소 초기화 실패:', error.message)
  }

  // Railway는 0.0.0.0 바인딩이 필요하다 (기본 localhost면 헬스체크가 실패한다)
  server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다`)
    console.log(`환경: ${process.env.NODE_ENV || 'development'}`)
    console.log(`키 저장소: ${keyService.describeStore()}`)
    // 세션 생성 훅 등록 (순환 참조를 피하려고 레지스트리에 주입)
    kiwoomRegistry.setOnCreate(onSessionCreated)
    kiwoomRegistry.setOnRemove((sessionKey) => {
      const timer = autoCancelTimers.get(sessionKey)
      if (timer) {
        clearInterval(timer)
        autoCancelTimers.delete(sessionKey)
      }
    })
  })
}

start()

export default app
