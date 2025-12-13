/**
 * 계좌 관련 라우터
 * 키움 REST API: 국내주식 > 계좌
 */
import { Router, Request, Response } from 'express'
import { KiwoomService } from '../services/kiwoomService'

const router = Router()
const kiwoomService = KiwoomService.getInstance()

// 계좌 목록 조회
router.get('/', async (req: Request, res: Response) => {
  try {
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

    // 계좌 목록 조회
    const accountList = await kiwoomService.getAccountList()
    
    // 계좌 정보 조회 (첫 번째 계좌 기준)
    const accountNo = req.query.accountNo as string
    const accountProductCode = req.query.accountProductCode as string || '01'
    
    if (accountNo) {
      const accountInfo = await kiwoomService.getAccountInfo(accountNo, accountProductCode)
      
      // 에러가 있는 경우 에러 정보 포함 (200 OK로 반환하여 클라이언트에서 처리)
      if (accountInfo.error) {
        return res.status(200).json({
          accounts: accountList.length > 0 ? accountList : [accountNo],
          accountNumber: accountNo,
          deposit: 0,
          totalAsset: 0,
          totalProfit: 0,
          totalProfitRate: 0,
          error: accountInfo.error,
          warning: true
        })
      }
      
      res.json({
        accounts: accountList.length > 0 ? accountList : [accountNo],
        accountNumber: accountNo,
        deposit: accountInfo.output2?.DNCA_TOT_AMT || accountInfo.output2?.예수금총액 || 0,
        totalAsset: accountInfo.output2?.TOT_EVAL_AMT || accountInfo.output2?.총평가금액 || 0,
        totalProfit: accountInfo.output2?.EVAL_PNLS_AMT || accountInfo.output2?.총평가손익 || 0,
        totalProfitRate: accountInfo.output2?.EVAL_PNLS_RT || accountInfo.output2?.총수익률 || 0,
      })
    } else {
      res.json({
        accounts: accountList,
        accountNumber: accountList.length > 0 ? accountList[0] : null,
      })
    }
  } catch (error: any) {
    // 500 에러는 조용히 처리 (이미 getAccountInfo에서 처리됨)
    if (error.response?.status !== 500) {
      console.error('계좌 정보 조회 오류:', error.response?.data || error.message)
    }
    res.status(500).json({
      error: '계좌 정보 조회 실패',
      detail: error.message
    })
  }
})

// 보유 종목 조회
router.get('/balance', async (req: Request, res: Response) => {
  try {
    if (!kiwoomService.isConnected()) {
      return res.status(200).json({
        stocks: [],
        error: '키움증권 API에 연결되지 않았습니다',
        warning: true
      })
    }

    const accountNo = req.query.accountNo as string
    const accountProductCode = req.query.accountProductCode as string || '01'

    const balance = await kiwoomService.getBalance(accountNo, accountProductCode)
    
    // 에러가 있는 경우 에러 정보 포함 (200 OK로 반환하여 클라이언트에서 처리)
    if (balance.error) {
      return res.status(200).json({ 
        stocks: balance.stocks || [],
        error: balance.error,
        warning: true
      })
    }
    
    // balance가 배열인 경우와 객체인 경우 모두 처리
    res.json({ stocks: Array.isArray(balance) ? balance : (balance.stocks || balance) })
  } catch (error: any) {
    // 500 에러는 조용히 처리 (이미 getBalance에서 처리됨)
    if (error.response?.status !== 500) {
      console.error('보유 종목 조회 오류:', error.response?.data || error.message)
    }
    res.status(500).json({
      error: '보유 종목 조회 실패',
      detail: error.message
    })
  }
})

export default router

