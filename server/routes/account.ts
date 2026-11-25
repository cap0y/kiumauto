/**
 * 계좌 관련 라우터
 * 키움 REST API: 국내주식 > 계좌
 */
import { Router, Request, Response } from 'express'
import { getKiwoom } from '../middleware/auth'

const router = Router()

// 계좌 목록 조회
router.get('/', async (req: Request, res: Response) => {
  try {
    const kiwoomService = getKiwoom(req)
    if (!kiwoomService.isConnected()) {
      return res.status(200).json({
        accounts: [],
        accountNumber: null,
        deposit: 0,
        totalAsset: 0,
        totalProfit: 0,
        totalProfitRate: 0,
        error: '키움증권 API에 연결되지 않았습니다',
        warning: true
      })
    }

    // 계좌번호는 토큰 기준으로 조회 (ka00001)
    const accountList = await kiwoomService.getAccountList()

    
    // 계좌 정보 조회 (첫 번째 계좌 기준)
    const accountNo = req.query.accountNo as string
    const accountProductCode = req.query.accountProductCode as string || '01'
    
    if (accountNo) {
      const accountInfo = await kiwoomService.getAccountInfo(accountNo, accountProductCode)
      
      // 에러가 있는 경우에도 캐시된 예수금이 있으면 사용
      if (accountInfo.error) {
        // 예수금 추출: output2.DNCA_TOT_AMT 또는 직접 deposit 필드 확인
        const deposit = accountInfo.output2?.DNCA_TOT_AMT || 
                        accountInfo.output2?.예수금총액 || 
                        accountInfo.deposit || 
                        0
        
        // 예수금이 문자열인 경우 숫자로 변환
        const depositValue = typeof deposit === 'string' 
          ? parseFloat(deposit.replace(/[,\s]/g, '')) || 0 
          : (typeof deposit === 'number' ? deposit : 0)
        
        return res.status(200).json({
          accounts: accountList.length > 0 ? accountList : [accountNo],
          accountNumber: accountNo,
          deposit: depositValue, // 캐시된 예수금이 있으면 사용, 없으면 0
          totalAsset: accountInfo.output2?.TOT_EVAL_AMT || accountInfo.output2?.총평가금액 || 0,
          totalProfit: accountInfo.output2?.EVAL_PNLS_AMT || accountInfo.output2?.총평가손익 || 0,
          totalProfitRate: accountInfo.output2?.EVAL_PNLS_RT || accountInfo.output2?.총수익률 || 0,
          error: accountInfo.error,
          warning: accountInfo.warning || true // 경고 메시지도 전달
        })
      }
      
      // 예수금 추출: output2.DNCA_TOT_AMT를 우선 사용하고, 없으면 직접 deposit 필드 확인
      const deposit = accountInfo.output2?.DNCA_TOT_AMT || 
                      accountInfo.output2?.예수금총액 || 
                      accountInfo.deposit || 
                      0
      
      // 예수금이 문자열인 경우 숫자로 변환
      const depositValue = typeof deposit === 'string' 
        ? parseFloat(deposit.replace(/[,\s]/g, '')) || 0 
        : (typeof deposit === 'number' ? deposit : 0)
      
      res.json({
        accounts: accountList.length > 0 ? accountList : [accountNo],
        accountNumber: accountNo,
        deposit: depositValue,
        totalAsset: accountInfo.output2?.TOT_EVAL_AMT || accountInfo.output2?.총평가금액 || 0,
        totalProfit: accountInfo.output2?.EVAL_PNLS_AMT || accountInfo.output2?.총평가손익 || 0,
        totalProfitRate: accountInfo.output2?.EVAL_PNLS_RT || accountInfo.output2?.총수익률 || 0,
      })
    } else {
      res.json({
        accounts: accountList,
        accountNumber: accountList.length > 0 ? accountList[0] : null,
        deposit: 0,
        totalAsset: 0,
        totalProfit: 0,
        totalProfitRate: 0,
      })
    }
  } catch (error: any) {
    console.error('계좌 정보 조회 오류:', error.message)
    res.status(500).json({
      error: '계좌 정보 조회 실패',
      detail: error.message
    })
  }
})

// 보유 종목 조회
router.get('/balance', async (req: Request, res: Response) => {
  try {
    const kiwoomService = getKiwoom(req)
    if (!kiwoomService.isConnected()) {
      return res.status(200).json({
        stocks: [],
        error: '키움증권 API에 연결되지 않았습니다',
        warning: true
      })
    }

    const accountNo = req.query.accountNo as string
    const accountProductCode = req.query.accountProductCode as string || '01'

    const balance = await kiwoomService.getBalance()

    // 에러가 있는 경우 에러 정보 포함 (200 OK로 반환하여 클라이언트에서 처리)
    if (!Array.isArray(balance) && balance.error) {
      return res.status(200).json({
        stocks: [],
        error: balance.error,
        warning: true
      })
    }

    // 보유 종목과 함께 서버가 계산한 합계도 전달한다
    // (클라이언트가 반올림 단가 × 수량으로 재계산하면 실제 매입금액과 어긋난다)
    if (Array.isArray(balance)) {
      // 이전 형태(배열) 호환
      const sumPurchase = balance.reduce((s: number, h: any) => s + (Number(h.purchaseAmount) || 0), 0)
      const sumValue = balance.reduce((s: number, h: any) => s + (Number(h.evaluation) || 0), 0)
      const sumProfit = balance.reduce((s: number, h: any) => s + (Number(h.profit) || 0), 0)
      return res.json({
        stocks: balance,
        totalPurchase: sumPurchase,
        totalStockValue: sumValue,
        totalProfit: sumProfit,
        totalProfitRate: sumPurchase > 0 ? Number(((sumProfit / sumPurchase) * 100).toFixed(2)) : 0,
      })
    }

    res.json(balance)
  } catch (error: any) {
    console.error('보유 종목 조회 오류:', error.message)
    res.status(500).json({
      error: '보유 종목 조회 실패',
      detail: error.message
    })
  }
})

export default router

