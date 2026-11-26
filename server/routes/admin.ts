/**
 * 관리자용 API 라우터
 * 키 발급 및 관리 기능
 */
import { Router, Request, Response } from 'express'
import keyService from '../services/keyService'
import userStateService from '../services/userStateService'

const router = Router()

/**
 * 키 발급 (관리자용)
 * POST /api/admin/keys/issue
 */
router.post('/keys/issue', async (req: Request, res: Response) => {
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
    const licenseKey = await keyService.issueKey(
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
router.get('/keys', async (req: Request, res: Response) => {
  try {
    const keys = await keyService.getAllKeys()
    
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
router.put('/keys/:key/toggle', async (req: Request, res: Response) => {
  try {
    const { key } = req.params
    const { isActive } = req.body

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'isActive는 boolean 값이어야 합니다'
      })
    }

    const success = await keyService.toggleKey(key, isActive)

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
router.delete('/keys/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params

    const success = await keyService.deleteKey(key)

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

/**
 * 세션 상태 조회 (관리자용)
 * GET /api/admin/state/:key/:name
 *
 * 서버에 저장된 사용자 상태를 확인한다 (마이그레이션 검증용).
 */
router.get('/state/:key/:name', async (req: Request, res: Response) => {
  try {
    const value = await userStateService.get(req.params.key, req.params.name)
    res.json({ success: true, value })
  } catch (error: any) {
    console.error('상태 조회 오류:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

/**
 * 세션 상태 저장 (관리자용)
 * PUT /api/admin/state/:key/:name
 * Body: { value: any }
 *
 * 기존 localStorage에만 있던 값을 서버로 옮길 때 쓴다.
 * (도메인마다 localStorage가 달라 로컬 실적이 Railway에서 보이지 않던 문제)
 */
router.put('/state/:key/:name', async (req: Request, res: Response) => {
  try {
    const { key, name } = req.params
    if (req.body?.value === undefined) {
      return res.status(400).json({ success: false, message: 'value가 필요합니다' })
    }

    // 존재하는 키에만 쓸 수 있다 (오타로 유령 세션을 만들지 않도록)
    const check = await keyService.checkKey(key)
    if (!check.valid) {
      return res.status(404).json({ success: false, message: '라이선스 키를 찾을 수 없습니다' })
    }

    await userStateService.set(key, name, req.body.value)
    res.json({ success: true, value: req.body.value })
  } catch (error: any) {
    console.error('상태 저장 오류:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

export default router
