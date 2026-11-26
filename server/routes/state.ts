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

/**
 * 상태 저장 키를 결정한다.
 *
 * 기기마다 라이선스 키가 다르면(폰/PC) 실현손익이 따로 쌓여 값이 달라진다.
 * 계좌번호를 넘기면 계좌 기준으로 저장해 어느 기기에서든 같은 값이 보이게 한다.
 * 계좌번호가 없으면 기존처럼 라이선스 키 기준(하위 호환).
 */
const resolveStateKey = (req: Request): string => {
  const account = String((req.query.account as string) || (req.body?.account as string) || '').trim()
  if (account) {
    // 계좌번호만 남긴다 ('8135796711-01' → '8135796711')
    const digits = account.split('-')[0].replace(/[^0-9]/g, '')
    if (digits) return `account:${digits}`
  }
  return getUserKey(req)
}

// 상태 조회
router.get('/:name', async (req: Request, res: Response) => {
  try {
    const name = String(req.params.name)
    if (!isValidName(name)) {
      return res.status(400).json({ success: false, error: '지원하지 않는 상태 이름입니다' })
    }

    const value = await userStateService.get(resolveStateKey(req), name)
    res.json({ success: true, name, value })
  } catch (error: any) {
    console.error('[상태 조회] 오류:', error.message)
    res.status(500).json({ success: false, error: '상태 조회 실패', detail: error.message })
  }
})

/**
 * 오늘 실현손익 값 검증.
 *
 * 버그로 -100%(매도가 0) 같은 엉터리 값이 누적되는 사고가 반복됐다.
 * 서버에서 비정상 값을 거부해 DB가 오염되는 것을 막는다.
 */
export const MAX_ABS_REALIZED_PROFIT = 1_000_000_000 // 10억 원 (넘으면 계산 오류)

export const validateRealizedProfit = (value: any): string | null => {
  if (!value || typeof value !== 'object') return 'value는 객체여야 합니다'
  const amount = Number(value.amount)
  if (!Number.isFinite(amount)) return 'amount가 숫자가 아닙니다'
  if (Math.abs(amount) > MAX_ABS_REALIZED_PROFIT) {
    return `amount가 비정상적으로 큽니다 (${amount.toLocaleString()})`
  }
  if (typeof value.date !== 'string' || !value.date) return 'date가 필요합니다'
  return null
}

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

    // 실현손익은 계산 버그로 오염되기 쉬워 서버에서 형식을 검증한다
    if (name === 'today_realized_profit') {
      const invalid = validateRealizedProfit(req.body.value)
      if (invalid) {
        console.warn(`[상태 저장 거부] ${name}: ${invalid}`, req.body.value)
        return res.status(400).json({ success: false, error: invalid })
      }
    }

    await userStateService.set(resolveStateKey(req), name, req.body.value)
    res.json({ success: true })
  } catch (error: any) {
    console.error('[상태 저장] 오류:', error.message)
    res.status(500).json({ success: false, error: '상태 저장 실패', detail: error.message })
  }
})

export default router
