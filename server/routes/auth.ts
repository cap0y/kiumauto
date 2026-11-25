/**
 * 인증 관련 API 라우터
 * 키 검증 및 키 정보 조회
 */
import { Router, Request, Response } from 'express'
import keyService from '../services/keyService'
import { LICENSE_COOKIE, licenseCookieOptions } from '../middleware/auth'

const router = Router()

/**
 * 라이선스 키 검증 (유효성만 확인) + 세션 쿠키 발급
 *
 * 키를 response body나 localStorage에만 두면 XSS 한 번에 탈취된다.
 * 검증에 성공하면 HttpOnly 쿠키로 심어 JS에서 읽지 못하게 한다.
 * (헤더 방식도 계속 허용 — 쿠키가 막히는 환경 대비)
 */
router.post('/validate-key', async (req: Request, res: Response) => {
  try {
    const { key } = req.body

    if (!key) {
      return res.status(400).json({
        success: false,
        message: '키가 필요합니다'
      })
    }

    // 키 검증
    const validation = await keyService.validateKey(key)

    if (!validation.valid) {
      return res.status(401).json({
        success: false,
        message: validation.message || '유효하지 않은 키입니다'
      })
    }

    const licenseKey = validation.licenseKey!

    // HttpOnly 세션 쿠키 — JS에서 접근 불가
    res.cookie(LICENSE_COOKIE, licenseKey.key, licenseCookieOptions())

    // 라이선스 키 유효성 정보만 반환 (App Key/Secret Key는 반환하지 않음)
    res.json({
      success: true,
      expiresAt: licenseKey.expiresAt,
      validDays: licenseKey.validDays,
      remainingDays: Math.ceil(
        (new Date(licenseKey.expiresAt).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)
      )
    })
  } catch (error: any) {
    console.error('키 검증 오류:', error)
    res.status(500).json({
      success: false,
      message: error.message || '키 검증 실패'
    })
  }
})

/**
 * 현재 세션 조회 (쿠키 기반)
 * GET /api/auth/session
 *
 * 앱 재시작 시 localStorage에 키를 남기지 않아도 세션을 복원한다.
 */
router.get('/session', async (req: Request, res: Response) => {
  try {
    const key = String((req as any).cookies?.[LICENSE_COOKIE] || '').trim()
    if (!key) {
      return res.json({ success: false, authenticated: false })
    }

    const result = await keyService.checkKey(key)
    if (!result.valid || !result.licenseKey) {
      // 만료/비활성 쿠키는 지운다 (재로그인 유도)
      res.clearCookie(LICENSE_COOKIE, { path: '/' })
      return res.json({ success: false, authenticated: false, message: result.message })
    }

    const licenseKey = result.licenseKey
    res.json({
      success: true,
      authenticated: true,
      expiresAt: licenseKey.expiresAt,
      validDays: licenseKey.validDays,
      remainingDays: Math.ceil(
        (new Date(licenseKey.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      ),
    })
  } catch (error: any) {
    console.error('세션 조회 오류:', error)
    res.status(500).json({ success: false, message: error.message || '세션 조회 실패' })
  }
})

/**
 * 로그아웃 (세션 쿠키 삭제)
 * POST /api/auth/logout
 */
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(LICENSE_COOKIE, { path: '/' })
  res.json({ success: true })
})

/**
 * 키 정보 조회 (키 값만으로)
 * GET /api/auth/key-info/:key
 */
router.get('/key-info/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params

    const result = await keyService.getKeyInfo(key)

    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.message || '키를 찾을 수 없습니다'
      })
    }

    res.json({
      success: true,
      info: result.info
    })
  } catch (error: any) {
    console.error('키 정보 조회 오류:', error)
    res.status(500).json({
      success: false,
      message: error.message || '키 정보 조회 실패'
    })
  }
})

export default router

