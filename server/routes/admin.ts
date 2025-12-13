/**
 * 관리자용 API 라우터
 * 키 발급 및 관리 기능
 */
import { Router, Request, Response } from 'express'
import keyService from '../services/keyService'

const router = Router()

/**
 * 키 발급 (관리자용)
 * POST /api/admin/keys/issue
 */
router.post('/keys/issue', (req: Request, res: Response) => {
  try {
    const { validDays, issuedBy, description } = req.body

    // 필수 필드 검증
    if (!validDays) {
      return res.status(400).json({
        success: false,
        message: 'validDays는 필수입니다'
      })
    }

    // 유효기간 검증 (1일 이상, 365일 이하)
    const days = parseInt(validDays.toString())
    if (isNaN(days) || days < 1 || days > 365) {
      return res.status(400).json({
        success: false,
        message: '유효기간은 1일 이상 365일 이하여야 합니다'
      })
    }

    // 키 발급
    const licenseKey = keyService.issueKey(
      days,
      issuedBy || 'admin',
      description || undefined
    )

    res.json({
      success: true,
      key: licenseKey.key,
      expiresAt: licenseKey.expiresAt,
      validDays: licenseKey.validDays,
      message: '키가 성공적으로 발급되었습니다'
    })
  } catch (error: any) {
    console.error('키 발급 오류:', error)
    res.status(500).json({
      success: false,
      message: error.message || '키 발급 실패'
    })
  }
})

/**
 * 키 목록 조회 (관리자용)
 * GET /api/admin/keys
 */
router.get('/keys', (req: Request, res: Response) => {
  try {
    const keys = keyService.getAllKeys()
    
    // 민감한 정보 제외하고 반환
    const safeKeys = keys.map(key => ({
      key: key.key,
      issuedAt: key.issuedAt,
      expiresAt: key.expiresAt,
      validDays: key.validDays,
      issuedBy: key.issuedBy,
      description: key.description,
      isActive: key.isActive,
      usedCount: key.usedCount,
      lastUsedAt: key.lastUsedAt
    }))

    res.json({
      success: true,
      keys: safeKeys,
      count: safeKeys.length
    })
  } catch (error: any) {
    console.error('키 목록 조회 오류:', error)
    res.status(500).json({
      success: false,
      message: error.message || '키 목록 조회 실패'
    })
  }
})

/**
 * 키 활성화/비활성화 (관리자용)
 * PUT /api/admin/keys/:key/toggle
 */
router.put('/keys/:key/toggle', (req: Request, res: Response) => {
  try {
    const { key } = req.params
    const { isActive } = req.body

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive는 boolean 값이어야 합니다'
      })
    }

    const success = keyService.toggleKey(key, isActive)

    if (!success) {
      return res.status(404).json({
        success: false,
        message: '키를 찾을 수 없습니다'
      })
    }

    res.json({
      success: true,
      message: `키가 ${isActive ? '활성화' : '비활성화'}되었습니다`
    })
  } catch (error: any) {
    console.error('키 토글 오류:', error)
    res.status(500).json({
      success: false,
      message: error.message || '키 토글 실패'
    })
  }
})

/**
 * 키 삭제 (관리자용)
 * DELETE /api/admin/keys/:key
 */
router.delete('/keys/:key', (req: Request, res: Response) => {
  try {
    const { key } = req.params

    const success = keyService.deleteKey(key)

    if (!success) {
      return res.status(404).json({
        success: false,
        message: '키를 찾을 수 없습니다'
      })
    }

    res.json({
      success: true,
      message: '키가 삭제되었습니다'
    })
  } catch (error: any) {
    console.error('키 삭제 오류:', error)
    res.status(500).json({
      success: false,
      message: error.message || '키 삭제 실패'
    })
  }
})

export default router

