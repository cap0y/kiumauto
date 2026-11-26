/**
 * 사용자 상태 저장 라우터 (오늘 실현손익, 체결 주문 내역 등)
 *
 * localStorage에만 두면 브라우저·도메인마다 값이 달라진다.
 * (로컬에서 매도한 실적이 Railway 도메인에서는 0으로 보였다)
 * 라이선스 키(세션) 단위로 서버에 저장한다.
 */
import { Router, Request, Response } from 'express'
import userStateService from '../services/userStateService'
import { getUserKey } from '../middleware/auth'

const router = Router()

/** 허용하는 상태 이름 (임의 키 저장 방지) */
const ALLOWED_NAMES = new Set([
  'today_realized_profit',
  'trading_state',
  'watchlist',
])

const isValidName = (name: string) => ALLOWED_NAMES.has(name)

// 상태 조회
router.get('/:name', async (req: Request, res: Response) => {
  try {
    const name = String(req.params.name)
    if (!isValidName(name)) {
      return res.status(400).json({ success: false, error: '지원하지 않는 상태 이름입니다' })
    }

    const value = await userStateService.get(getUserKey(req), name)
    res.json({ success: true, name, value })
  } catch (error: any) {
    console.error('[상태 조회] 오류:', error.message)
    res.status(500).json({ success: false, error: '상태 조회 실패', detail: error.message })
  }
})

// 상태 저장 (덮어쓰기)
router.put('/:name', async (req: Request, res: Response) => {
  try {
    const name = String(req.params.name)
    if (!isValidName(name)) {
      return res.status(400).json({ success: false, error: '지원하지 않는 상태 이름입니다' })
    }
    if (req.body?.value === undefined) {
      return res.status(400).json({ success: false, error: 'value가 필요합니다' })
    }

    await userStateService.set(getUserKey(req), name, req.body.value)
    res.json({ success: true })
  } catch (error: any) {
    console.error('[상태 저장] 오류:', error.message)
    res.status(500).json({ success: false, error: '상태 저장 실패', detail: error.message })
  }
})

export default router
