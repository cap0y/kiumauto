/**
 * 인증 관련 API 라우터
 * 키 검증 및 키 정보 조회
 */
import { Router, Request, Response } from 'express'
import keyService from '../services/keyService'

const router = Router()

/**
 * 라이선스 키 검증 (유효성만 확인)
 * POST /api/auth/validate-key
 */
router.post('/validate-key', (req: Request, res: Response) => {
  try {
    const { key } = req.body

    if (!key) {
      return res.status(400).json({
        success: false,
        message: '키가 필요합니다'
      })
    }

    // 키 검증
    const validation = keyService.validateKey(key)

    if (!validation.valid) {
      return res.status(401).json({
        success: false,
        message: validation.message || '유효하지 않은 키입니다'
      })
    }

    const licenseKey = validation.licenseKey!

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
 * 키 정보 조회 (키 값만으로)
 * GET /api/auth/key-info/:key
 */
router.get('/key-info/:key', (req: Request, res: Response) => {
  try {
    const { key } = req.params

    const result = keyService.getKeyInfo(key)

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

