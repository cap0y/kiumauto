# 키움증권 자동매매 서버

Node.js + Express + TypeScript 기반 백엔드 서버입니다.

## 프로젝트 구조

```
server/
├── index.ts          # 메인 서버 파일
├── routes/           # 라우터
│   ├── index.ts      # 메인 라우터
│   ├── kiwoom.ts    # 키움증권 연결
│   ├── account.ts   # 계좌 관련
│   ├── stock.ts     # 종목 관련
│   ├── order.ts     # 주문 관련
│   └── settings.ts  # 설정 관련
├── services/         # 비즈니스 로직
│   └── kiwoomService.ts  # 키움증권 API 서비스
└── utils/           # 유틸리티
    └── logger.ts    # 로거
```

## 설치

```bash
npm install
```

## 환경 변수 설정

`.env` 파일을 생성하고 다음 내용을 추가하세요:

```
NODE_ENV=development
PORT=8000
KIWOOM_HOST=https://openapi.kiwoom.com
KIWOOM_APPKEY=your_appkey_here
KIWOOM_SECRETKEY=your_secretkey_here
```

## 실행

### 개발 모드
```bash
npm run dev
```

### 프로덕션 모드
```bash
npm run build
npm start
```

## API 엔드포인트

- `GET /` - 서버 상태 확인
- `POST /api/connect` - 키움증권 API 연결
- `GET /api/status` - 연결 상태 확인
- `GET /api/stocks` - 종목 리스트 조회
- `GET /api/stocks/:code/price` - 종목 현재가 조회
- `GET /api/stocks/:code/candle` - 차트 데이터 조회
- `GET /api/accounts` - 계좌 정보 조회
- `GET /api/accounts/balance` - 보유 종목 조회
- `POST /api/orders` - 주문 전송
- `GET /api/settings` - 매매 설정 조회
- `POST /api/settings` - 매매 설정 저장
- `WS /ws` - WebSocket 연결 (실시간 데이터)

## 주의사항

- 키움증권 REST API의 실제 엔드포인트와 TR_ID는 키움증권 API 문서에 맞게 수정이 필요합니다
- 현재 코드는 기본 구조만 제공하며, 실제 API 호출은 키움증권 공식 문서를 참고하여 구현해야 합니다
- 모의투자 환경에서 먼저 테스트하세요

