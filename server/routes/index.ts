/**
 * 메인 라우터
 * 모든 API 라우트를 통합 관리
 *
 * 보안:
 *   /api/auth/*    — 라이선스 키 검증 (인증 전 단계이므로 인증 불필요)
 *   /api/admin/*   — 관리자 토큰 필수
 *   그 외 업무 API — 라이선스 키 필수 (x-license-key 헤더)
 */
import { Router } from 'express'
import kiwoomRoutes from './kiwoom'
import accountRoutes from './account'
import stockRoutes from './stock'
import orderRoutes from './order'
import settingsRoutes from './settings'
import conditionRoutes from './condition'
import adminRoutes from './admin'
import authRoutes from './auth'
import { requireAdmin, requireLicense, withKiwoomService } from '../middleware/auth'

const router = Router()

// 인증 전 단계 — 라이선스 키 검증 자체는 열려 있어야 한다
router.use('/auth', authRoutes) // /api/auth/*

// 관리자 전용 — 관리자 토큰 필수
router.use('/admin', requireAdmin, adminRoutes) // /api/admin/*

// 업무 API — 라이선스 키 필수 + 사용자별 KiwoomService 주입
// (세션을 분리하지 않으면 A의 주문이 B 계좌로 나간다)
const session = [requireLicense, withKiwoomService]
router.use('/kiwoom', ...session, kiwoomRoutes) // /api/kiwoom/*
router.use('/accounts', ...session, accountRoutes) // /api/accounts/*
router.use('/stocks', ...session, stockRoutes) // /api/stocks/*
router.use('/orders', ...session, orderRoutes) // /api/orders/*
router.use('/settings', ...session, settingsRoutes) // /api/settings/*
router.use('/conditions', ...session, conditionRoutes) // /api/conditions/*

export default router
