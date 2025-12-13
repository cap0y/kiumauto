/**
 * 매매 설정 관련 라우터
 */
import { Router, Request, Response } from 'express'
import { promises as fs } from 'fs'
import path from 'path'

const router = Router()
const SETTINGS_FILE = path.join(process.cwd(), 'trading_settings.json')

// 매매 설정 조회
router.get('/', async (req: Request, res: Response) => {
  try {
    try {
      const data = await fs.readFile(SETTINGS_FILE, 'utf-8')
      const settings = JSON.parse(data)
      res.json(settings)
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        res.json({ message: '설정 파일이 없습니다' })
      } else {
        throw error
      }
    }
  } catch (error: any) {
    console.error('설정 조회 오류:', error)
    res.status(500).json({
      error: '설정 조회 실패',
      detail: error.message
    })
  }
})

// 매매 설정 저장
router.post('/', async (req: Request, res: Response) => {
  try {
    const settings = req.body
    await fs.writeFile(
      SETTINGS_FILE,
      JSON.stringify(settings, null, 2),
      'utf-8'
    )
    res.json({
      status: 'saved',
      message: '설정이 저장되었습니다'
    })
  } catch (error: any) {
    console.error('설정 저장 오류:', error)
    res.status(500).json({
      error: '설정 저장 실패',
      detail: error.message
    })
  }
})

export default router

