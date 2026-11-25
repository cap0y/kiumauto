/**
 * API 인증 미들웨어
 *
 * 기존에는 라이선스 키를 클라이언트에서만 검증했기 때문에
 * 누구든 `POST /api/orders`를 직접 호출해 주문을 낼 수 있었다.
 * 서버에서도 모든 업무 API를 검증한다.
 */
import { Request, Response, NextFunction } from 'express'
import keyService from '../services/keyService'
import { kiwoomRegistry } from '../services/kiwoomRegistry'
import { KiwoomService } from '../services/kiwoomService'

/** 라이선스 키 헤더 이름 (클라이언트 인터셉터와 공유) */
export const LICENSE_HEADER = 'x-license-key'
/** 관리자 토큰 헤더 이름 */
export const ADMIN_HEADER = 'x-admin-token'
/** HttpOnly 세션 쿠키 이름 (XSS로 키를 탈취하지 못하도록 JS에서 숨긴다) */
export const LICENSE_COOKIE = 'kiwoom_license'

/**
 * 라이선스 세션 쿠키 옵션
 * - httpOnly: JS에서 document.cookie로 읽을 수 없다
 * - sameSite lax: CSRF 완화
 * - secure: HTTPS에서만 전송 (프로덕션)
 * maxAge는 30일 (키 만료는 서버에서 별도로 검사한다)
 */
export const licenseCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 30 * 24 * 60 * 60 * 1000,
})

const readHeader = (req: Request, name: string): string => {
  const value = req.headers[name]
  if (Array.isArray(value)) return String(value[0] || '').trim()
  return String(value || '').trim()
}

/**
 * 관리자 토큰.
 *
 * 개발 편의를 위해 NODE_ENV !== 'production' 이면 기본값을 허용한다.
 * 프로덕션에서 ADMIN_TOKEN이 없으면 관리자 API를 아예 막는다.
 * (기본값이 살아 있으면 번들에서 찾은 토큰으로 누구나 키를 발급할 수 있다)
 */
const isProduction = () => process.env.NODE_ENV === 'production'

const adminToken = (): string | null => {
  const fromEnv = String(process.env.ADMIN_TOKEN || '').trim()
  if (fromEnv) return fromEnv

  if (isProduction()) {
    if (!(globalThis as any).__adminTokenMissingLogged) {
      ;(globalThis as any).__adminTokenMissingLogged = true
      console.error(
        '[보안] ADMIN_TOKEN이 설정되지 않아 관리자 API를 비활성화합니다. ' +
        'ADMIN_TOKEN 환경변수를 설정한 뒤 재시작하세요.'
      )
    }
    return null
  }

  if (!(globalThis as any).__adminTokenWarned) {
    ;(globalThis as any).__adminTokenWarned = true
    console.warn(
      '[보안 경고] ADMIN_TOKEN 환경변수가 없어 개발용 기본 토큰을 사용합니다. ' +
      '배포 전 ADMIN_TOKEN을 설정하세요.'
    )
  }
  return 'cap@3156'
}

/** 관리자 전용 API 보호 */
export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const expected = adminToken()
  if (!expected) {
    return res.status(503).json({
      success: false,
      error: '관리자 기능이 비활성화되어 있습니다 (ADMIN_TOKEN 미설정)',
      code: 'ADMIN_DISABLED',
    })
  }

  const provided = readHeader(req, ADMIN_HEADER)
  if (!provided) {
    return res.status(401).json({
      success: false,
      error: '관리자 토큰이 필요합니다',
      code: 'ADMIN_TOKEN_MISSING',
    })
  }
  if (provided !== expected) {
    return res.status(403).json({
      success: false,
      error: '관리자 토큰이 올바르지 않습니다',
      code: 'ADMIN_TOKEN_INVALID',
    })
  }
  next()
}

/** 요청에서 라이선스 키를 꺼낸다 (쿠키 우선, 헤더 허용) */
const resolveLicenseKey = (req: Request): string => {
  const fromCookie = String((req as any).cookies?.[LICENSE_COOKIE] || '').trim()
  if (fromCookie) return fromCookie
  return readHeader(req, LICENSE_HEADER)
}

/** 라이선스 키가 필요한 업무 API 보호 */
export const requireLicense = async (req: Request, res: Response, next: NextFunction) => {
  const key = resolveLicenseKey(req)
  if (!key) {
    return res.status(401).json({
      success: false,
      error: '라이선스 키가 필요합니다',
      code: 'LICENSE_MISSING',
    })
  }

  try {
    // 요청마다 DB를 읽는다 (다른 인스턴스에서 발급/비활성화한 키도 즉시 반영)
    const validation = await keyService.checkKey(key)
    if (!validation.valid) {
      return res.status(401).json({
        success: false,
        error: validation.message || '유효하지 않은 라이선스 키입니다',
        code: 'LICENSE_INVALID',
      })
    }

    // 후속 핸들러에서 필요할 수 있도록 남겨둔다
    ;(req as any).licenseKey = key
    next()
  } catch (error: any) {
    console.error('[인증] 키 검증 오류:', error.message)
    return res.status(503).json({
      success: false,
      error: '인증 저장소에 접근할 수 없습니다',
      detail: error.message,
      code: 'AUTH_STORE_UNAVAILABLE',
    })
  }
}

/**
 * 라이선스 키에 묶인 KiwoomService를 요청에 주입한다.
 * requireLicense 뒤에 붙여 쓴다.
 * 라우트는 `getKiwoom(req)`로 자기 세션의 서비스를 꺼내야 한다.
 */
export const withKiwoomService = (req: Request, _res: Response, next: NextFunction) => {
  const key = String((req as any).licenseKey || resolveLicenseKey(req)).trim()
  if (!key) {
    return _res.status(401).json({
      success: false,
      error: '라이선스 키가 필요합니다',
      code: 'LICENSE_MISSING',
    })
  }
  try {
    ;(req as any).kiwoomService = kiwoomRegistry.get(key)
  } catch (error: any) {
    return _res.status(500).json({
      success: false,
      error: '세션 생성 실패',
      detail: error.message,
    })
  }
  next()
}

/** 핸들러에서 세션별 KiwoomService를 꺼낸다 */
export const getKiwoom = (req: Request): KiwoomService => {
  const service = (req as any).kiwoomService as KiwoomService | undefined
  if (!service) throw new Error('KiwoomService가 요청에 주입되지 않았습니다')
  return service
}

/** 핸들러에서 라이선스 키(세션 ID)를 꺼낸다 */
export const getUserKey = (req: Request): string =>
  String((req as any).licenseKey || resolveLicenseKey(req)).trim()
