/**
 * 메인 라우터
 * 모든 API 라우트를 통합 관리
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

const router = Router()

// 각 라우터 등록
router.use('/kiwoom', kiwoomRoutes) // /api/kiwoom/*
router.use('/accounts', accountRoutes) // /api/accounts/*
router.use('/stocks', stockRoutes) // /api/stocks/*
router.use('/orders', orderRoutes) // /api/orders/*
router.use('/settings', settingsRoutes) // /api/settings/*
router.use('/conditions', conditionRoutes) // /api/conditions/*
router.use('/admin', adminRoutes) // /api/admin/*
router.use('/auth', authRoutes) // /api/auth/*

export default router


