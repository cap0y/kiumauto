import React, { useState, useEffect } from 'react'
import { useMutation } from 'react-query'
import { TradingSettings } from '../api/kiwoom'
import { useThemeStore } from '../store/useThemeStore'
import toast from 'react-hot-toast'

/**
 * 환경설정 페이지 - 모바일 최적화
 * 탭2에 해당하는 설정 페이지
 */
const TradingSettingsPage = () => {
  const { theme } = useThemeStore()
  const [activeSection, setActiveSection] = useState<string>('basic')
  
  // 매매조건 입력
  const [tradingConditions, setTradingConditions] = useState({
    종목당매수금액: 5000000,
    최대동시매수종목수: 10,
    종목당매매허용횟수: 30,
    당일최대매매종목수: 50,
    수수료및세금: 0.92,
    종목별매수가격설정실행: true,
    매수가격옵션: '지정가',
    매수호가: 0,
  })

  // 매매시간 설정
  const [tradingTime, setTradingTime] = useState({
    시작시: 9,
    시작분: 0,
    시작초: 0,
    종료시: 15,
    종료분: 19,
    종료초: 59,
    목표시간도달시보유종목전량매도: true,
    목표시: 15,
    목표분: 19,
    목표초: 59,
  })

  // 매수/매도 가격지정
  const [priceSettings, setPriceSettings] = useState({
    종목별매도수익률설정실행: true,
    익절목표수익률: 10.0,
    익절주문옵션: '시장가',
    손절기준손실률: -1.5,
    손절주문옵션: '지정가',
    매도호가: 0,
  })

  // 기타조건
  const [otherConditions, setOtherConditions] = useState({
    프로그램실행시자동시작: false,
    미체결매수주문취소: true,
    미체결매수주문취소초: 20,
    분봉조회: true,
    분봉조회분: 5,
    Trailing매도조건설정실행: true,
    매도감시기준수익률: 10.0,
    최고수익률대비하락률: -3.0,
  })

  // AI 설정
  const [aiSettings, setAiSettings] = useState({
    ai모델: 'GPT-4-Mini',
    api키: '',
    매매시작시: 9,
    매매종료시: 15,
    분석간격분: 3,
    신뢰도기준: 70,
    ai매매사용: false,
  })

  // 매매기법 설정
  const [tradingMethods, setTradingMethods] = useState({
    장시작급등주매매: true,
    볼린저밴드하단반등매매: true,
    추세선매매: true,
    장마감종가배팅매매: true,
    스캘핑매매: true,
    돌파매매: true,
  })

  // 텔레그램 설정
  const [telegramSettings, setTelegramSettings] = useState({
    봇토큰: '',
    채팅ID: '',
    활성화: false,
  })

  const saveMutation = useMutation(
    async () => {
      // 로컬 스토리지에 저장
      localStorage.setItem('tradingConditions', JSON.stringify(tradingConditions))
      localStorage.setItem('tradingTime', JSON.stringify(tradingTime))
      localStorage.setItem('priceSettings', JSON.stringify(priceSettings))
      localStorage.setItem('otherConditions', JSON.stringify(otherConditions))
      localStorage.setItem('aiSettings', JSON.stringify(aiSettings))
      localStorage.setItem('tradingMethods', JSON.stringify(tradingMethods))
      localStorage.setItem('telegramSettings', JSON.stringify(telegramSettings))
      return true
    },
    {
      onSuccess: () => {
        toast.success('설정이 저장되었습니다')
      },
      onError: () => {
        toast.error('설정 저장 실패')
      },
    }
  )

  useEffect(() => {
    // 저장된 설정 불러오기
    const savedTradingConditions = localStorage.getItem('tradingConditions')
    const savedTradingTime = localStorage.getItem('tradingTime')
    const savedPriceSettings = localStorage.getItem('priceSettings')
    const savedOtherConditions = localStorage.getItem('otherConditions')
    const savedAiSettings = localStorage.getItem('aiSettings')
    const savedTradingMethods = localStorage.getItem('tradingMethods')
    const savedTelegramSettings = localStorage.getItem('telegramSettings')

    if (savedTradingConditions) setTradingConditions(JSON.parse(savedTradingConditions))
    if (savedTradingTime) setTradingTime(JSON.parse(savedTradingTime))
    if (savedPriceSettings) setPriceSettings(JSON.parse(savedPriceSettings))
    if (savedOtherConditions) setOtherConditions(JSON.parse(savedOtherConditions))
    if (savedAiSettings) setAiSettings(JSON.parse(savedAiSettings))
    if (savedTradingMethods) setTradingMethods(JSON.parse(savedTradingMethods))
    if (savedTelegramSettings) setTelegramSettings(JSON.parse(savedTelegramSettings))
  }, [])

  const handleSave = () => {
    saveMutation.mutate()
  }

  const sections = [
    { id: 'basic', label: '기본설정' },
    { id: 'time', label: '매매시간' },
    { id: 'price', label: '가격설정' },
    { id: 'other', label: '기타조건' },
    { id: 'ai', label: 'AI설정' },
    { id: 'methods', label: '매매기법' },
    { id: 'telegram', label: '텔레그램' },
  ]

  return (
    <div className={`h-screen flex flex-col overflow-hidden ${
      theme === 'dark' ? 'bg-gradient-dark text-dark-text' : 'bg-gray-50 text-gray-900'
    }`}>
      {/* 헤더 */}
      <div className={`border-b shadow-sm sticky top-0 z-10 backdrop-blur-sm ${
        theme === 'dark' 
          ? 'bg-dark-surface/80 border-dark-border' 
          : 'bg-white/90 border-gray-200'
      }`}>
        <div className="px-4 py-3 flex items-center justify-between">
          <h2 className={`text-lg font-bold ${
            theme === 'dark' ? 'text-gradient' : 'text-gray-900'
          }`}>환경설정</h2>
          <button
            onClick={handleSave}
            disabled={saveMutation.isLoading}
            className="btn-gradient-primary text-sm flex items-center gap-2 disabled:opacity-50"
          >
            {saveMutation.isLoading ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span className="text-gradient font-bold">저장 중...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-gradient font-bold">저장</span>
              </>
            )}
          </button>
        </div>

        {/* 섹션 탭 */}
        <div className="flex overflow-x-auto border-t">
          {sections.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 ${
                activeSection === section.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500'
              }`}
            >
              {section.label}
            </button>
          ))}
        </div>
      </div>

      {/* 설정 내용 */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeSection === 'basic' && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-base font-semibold mb-4">매매조건 입력</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">종목당 매수금액</label>
                  <input
                    type="number"
                    value={tradingConditions.종목당매수금액}
                    onChange={(e) => setTradingConditions({ ...tradingConditions, 종목당매수금액: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">최대 동시매수종목수</label>
                  <input
                    type="number"
                    value={tradingConditions.최대동시매수종목수}
                    onChange={(e) => setTradingConditions({ ...tradingConditions, 최대동시매수종목수: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">종목당 매매허용횟수</label>
                  <input
                    type="number"
                    value={tradingConditions.종목당매매허용횟수}
                    onChange={(e) => setTradingConditions({ ...tradingConditions, 종목당매매허용횟수: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">당일 최대매매종목수</label>
                  <input
                    type="number"
                    value={tradingConditions.당일최대매매종목수}
                    onChange={(e) => setTradingConditions({ ...tradingConditions, 당일최대매매종목수: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">수수료 및 세금 (%)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={tradingConditions.수수료및세금}
                    onChange={(e) => setTradingConditions({ ...tradingConditions, 수수료및세금: parseFloat(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={tradingConditions.종목별매수가격설정실행}
                    onChange={(e) => setTradingConditions({ ...tradingConditions, 종목별매수가격설정실행: e.target.checked })}
                    className="w-5 h-5 mr-2"
                  />
                  <label className="text-sm font-medium">종목별 매수가격 설정 실행</label>
                </div>
                {tradingConditions.종목별매수가격설정실행 && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-2">매수가격 옵션</label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setTradingConditions({ ...tradingConditions, 매수가격옵션: '시장가' })}
                          className={`flex-1 px-4 py-2 rounded-lg text-sm ${
                            tradingConditions.매수가격옵션 === '시장가'
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-100'
                          }`}
                        >
                          시장가
                        </button>
                        <button
                          onClick={() => setTradingConditions({ ...tradingConditions, 매수가격옵션: '지정가' })}
                          className={`flex-1 px-4 py-2 rounded-lg text-sm ${
                            tradingConditions.매수가격옵션 === '지정가'
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-100'
                          }`}
                        >
                          지정가
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">매수호가 (-10 ~ 0 ~ +10)</label>
                      <input
                        type="number"
                        min="-10"
                        max="10"
                        value={tradingConditions.매수호가}
                        onChange={(e) => setTradingConditions({ ...tradingConditions, 매수호가: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {activeSection === 'time' && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-base font-semibold mb-4">매매시간 설정</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">시작 시간</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      max="23"
                      value={tradingTime.시작시}
                      onChange={(e) => setTradingTime({ ...tradingTime, 시작시: parseInt(e.target.value) || 0 })}
                      className="w-20 px-3 py-2 border rounded-lg text-sm"
                      placeholder="시"
                    />
                    <input
                      type="number"
                      min="0"
                      max="59"
                      value={tradingTime.시작분}
                      onChange={(e) => setTradingTime({ ...tradingTime, 시작분: parseInt(e.target.value) || 0 })}
                      className="w-20 px-3 py-2 border rounded-lg text-sm"
                      placeholder="분"
                    />
                    <input
                      type="number"
                      min="0"
                      max="59"
                      value={tradingTime.시작초}
                      onChange={(e) => setTradingTime({ ...tradingTime, 시작초: parseInt(e.target.value) || 0 })}
                      className="w-20 px-3 py-2 border rounded-lg text-sm"
                      placeholder="초"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">종료 시간</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      max="23"
                      value={tradingTime.종료시}
                      onChange={(e) => setTradingTime({ ...tradingTime, 종료시: parseInt(e.target.value) || 0 })}
                      className="w-20 px-3 py-2 border rounded-lg text-sm"
                      placeholder="시"
                    />
                    <input
                      type="number"
                      min="0"
                      max="59"
                      value={tradingTime.종료분}
                      onChange={(e) => setTradingTime({ ...tradingTime, 종료분: parseInt(e.target.value) || 0 })}
                      className="w-20 px-3 py-2 border rounded-lg text-sm"
                      placeholder="분"
                    />
                    <input
                      type="number"
                      min="0"
                      max="59"
                      value={tradingTime.종료초}
                      onChange={(e) => setTradingTime({ ...tradingTime, 종료초: parseInt(e.target.value) || 0 })}
                      className="w-20 px-3 py-2 border rounded-lg text-sm"
                      placeholder="초"
                    />
                  </div>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={tradingTime.목표시간도달시보유종목전량매도}
                    onChange={(e) => setTradingTime({ ...tradingTime, 목표시간도달시보유종목전량매도: e.target.checked })}
                    className="w-5 h-5 mr-2"
                  />
                  <label className="text-sm font-medium">목표시간 도달시 보유종목 전량매도</label>
                </div>
                {tradingTime.목표시간도달시보유종목전량매도 && (
                  <div>
                    <label className="block text-sm font-medium mb-1">목표 시간</label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min="0"
                        max="23"
                        value={tradingTime.목표시}
                        onChange={(e) => setTradingTime({ ...tradingTime, 목표시: parseInt(e.target.value) || 0 })}
                        className="w-20 px-3 py-2 border rounded-lg text-sm"
                        placeholder="시"
                      />
                      <input
                        type="number"
                        min="0"
                        max="59"
                        value={tradingTime.목표분}
                        onChange={(e) => setTradingTime({ ...tradingTime, 목표분: parseInt(e.target.value) || 0 })}
                        className="w-20 px-3 py-2 border rounded-lg text-sm"
                        placeholder="분"
                      />
                      <input
                        type="number"
                        min="0"
                        max="59"
                        value={tradingTime.목표초}
                        onChange={(e) => setTradingTime({ ...tradingTime, 목표초: parseInt(e.target.value) || 0 })}
                        className="w-20 px-3 py-2 border rounded-lg text-sm"
                        placeholder="초"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeSection === 'price' && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-base font-semibold mb-4">매수/매도 가격지정</h3>
              <div className="space-y-3">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={priceSettings.종목별매도수익률설정실행}
                    onChange={(e) => setPriceSettings({ ...priceSettings, 종목별매도수익률설정실행: e.target.checked })}
                    className="w-5 h-5 mr-2"
                  />
                  <label className="text-sm font-medium">종목별 매도수익률 설정 실행</label>
                </div>
                {priceSettings.종목별매도수익률설정실행 && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-1">익절 목표수익률 (%)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={priceSettings.익절목표수익률}
                        onChange={(e) => setPriceSettings({ ...priceSettings, 익절목표수익률: parseFloat(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">손절 기준손실률 (%)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={priceSettings.손절기준손실률}
                        onChange={(e) => setPriceSettings({ ...priceSettings, 손절기준손실률: parseFloat(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">매도호가 (-10 ~ 0 ~ +10)</label>
                      <input
                        type="number"
                        min="-10"
                        max="10"
                        value={priceSettings.매도호가}
                        onChange={(e) => setPriceSettings({ ...priceSettings, 매도호가: parseInt(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {activeSection === 'other' && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-base font-semibold mb-4">기타조건</h3>
              <div className="space-y-3">
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={otherConditions.프로그램실행시자동시작}
                    onChange={(e) => setOtherConditions({ ...otherConditions, 프로그램실행시자동시작: e.target.checked })}
                    className="w-5 h-5 mr-2"
                  />
                  <label className="text-sm font-medium">프로그램 실행시 자동시작</label>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={otherConditions.미체결매수주문취소}
                    onChange={(e) => setOtherConditions({ ...otherConditions, 미체결매수주문취소: e.target.checked })}
                    className="w-5 h-5 mr-2"
                  />
                  <label className="text-sm font-medium">미체결 매수주문 취소 (초)</label>
                  {otherConditions.미체결매수주문취소 && (
                    <input
                      type="number"
                      value={otherConditions.미체결매수주문취소초}
                      onChange={(e) => setOtherConditions({ ...otherConditions, 미체결매수주문취소초: parseInt(e.target.value) || 0 })}
                      className="w-20 ml-2 px-3 py-2 border rounded-lg text-sm"
                    />
                  )}
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={otherConditions.분봉조회}
                    onChange={(e) => setOtherConditions({ ...otherConditions, 분봉조회: e.target.checked })}
                    className="w-5 h-5 mr-2"
                  />
                  <label className="text-sm font-medium">분봉조회</label>
                  {otherConditions.분봉조회 && (
                    <input
                      type="number"
                      value={otherConditions.분봉조회분}
                      onChange={(e) => setOtherConditions({ ...otherConditions, 분봉조회분: parseInt(e.target.value) || 0 })}
                      className="w-20 ml-2 px-3 py-2 border rounded-lg text-sm"
                    />
                  )}
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={otherConditions.Trailing매도조건설정실행}
                    onChange={(e) => setOtherConditions({ ...otherConditions, Trailing매도조건설정실행: e.target.checked })}
                    className="w-5 h-5 mr-2"
                  />
                  <label className="text-sm font-medium">Trailing 매도조건 설정 실행</label>
                </div>
                {otherConditions.Trailing매도조건설정실행 && (
                  <>
                    <div>
                      <label className="block text-sm font-medium mb-1">매도감시 기준 수익률 (%)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={otherConditions.매도감시기준수익률}
                        onChange={(e) => setOtherConditions({ ...otherConditions, 매도감시기준수익률: parseFloat(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">최고 수익률 대비 하락률 (%)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={otherConditions.최고수익률대비하락률}
                        onChange={(e) => setOtherConditions({ ...otherConditions, 최고수익률대비하락률: parseFloat(e.target.value) || 0 })}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {activeSection === 'ai' && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-base font-semibold mb-4">AI 설정</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">AI 모델</label>
                  <select
                    value={aiSettings.ai모델}
                    onChange={(e) => setAiSettings({ ...aiSettings, ai모델: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  >
                    <option>GPT-4-Mini</option>
                    <option>GPT-4</option>
                    <option>GPT-3.5-Turbo</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">API 키</label>
                  <input
                    type="password"
                    value={aiSettings.api키}
                    onChange={(e) => setAiSettings({ ...aiSettings, api키: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    placeholder="API 키를 입력하세요"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">매매 시작 시</label>
                  <input
                    type="number"
                    min="0"
                    max="23"
                    value={aiSettings.매매시작시}
                    onChange={(e) => setAiSettings({ ...aiSettings, 매매시작시: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">매매 종료 시</label>
                  <input
                    type="number"
                    min="0"
                    max="23"
                    value={aiSettings.매매종료시}
                    onChange={(e) => setAiSettings({ ...aiSettings, 매매종료시: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">분석 간격 (분)</label>
                  <input
                    type="number"
                    value={aiSettings.분석간격분}
                    onChange={(e) => setAiSettings({ ...aiSettings, 분석간격분: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">신뢰도 기준 (%)</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={aiSettings.신뢰도기준}
                    onChange={(e) => setAiSettings({ ...aiSettings, 신뢰도기준: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={aiSettings.ai매매사용}
                    onChange={(e) => setAiSettings({ ...aiSettings, ai매매사용: e.target.checked })}
                    className="w-5 h-5 mr-2"
                  />
                  <label className="text-sm font-medium">AI 매매 사용</label>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeSection === 'methods' && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-base font-semibold mb-4">매매기법 설정</h3>
              <div className="space-y-3">
                {Object.entries(tradingMethods).map(([key, value]) => (
                  <div key={key} className="flex items-center">
                    <input
                      type="checkbox"
                      checked={value}
                      onChange={(e) => setTradingMethods({ ...tradingMethods, [key]: e.target.checked })}
                      className="w-5 h-5 mr-2"
                    />
                    <label className="text-sm font-medium">{key}</label>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeSection === 'telegram' && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg shadow p-4">
              <h3 className="text-base font-semibold mb-4">텔레그램 설정</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">봇 토큰</label>
                  <input
                    type="text"
                    value={telegramSettings.봇토큰}
                    onChange={(e) => setTelegramSettings({ ...telegramSettings, 봇토큰: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    placeholder="봇 토큰을 입력하세요"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">채팅 ID</label>
                  <input
                    type="text"
                    value={telegramSettings.채팅ID}
                    onChange={(e) => setTelegramSettings({ ...telegramSettings, 채팅ID: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    placeholder="채팅 ID를 입력하세요"
                  />
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    checked={telegramSettings.활성화}
                    onChange={(e) => setTelegramSettings({ ...telegramSettings, 활성화: e.target.checked })}
                    className="w-5 h-5 mr-2"
                  />
                  <label className="text-sm font-medium">텔레그램 알림 활성화</label>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default TradingSettingsPage
