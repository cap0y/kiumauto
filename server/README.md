# 키움증권 자동매매 서버

Node.js + Express + TypeScript 기반 백엔드 서버입니다.

## 프로젝트 구조

```
server/
├── index.ts                    # 메인 서버 (WebSocket 세션 분리, 미체결 자동취소)
├── middleware/
│   └── auth.ts                 # 라이선스/관리자 인증 + 세션 서비스 주입
├── routes/
│   ├── index.ts                # 라우터 통합 (인증 미들웨어 적용)
│   ├── auth.ts                 # 라이선스 키 검증 (인증 불필요)
│   ├── admin.ts                # 키 발급/관리 (관리자 토큰 필수)
│   ├── kiwoom.ts               # 키움증권 연결/해제
│   ├── account.ts              # 계좌/보유종목
│   ├── stock.ts                # 종목 검색/시세/차트
│   ├── order.ts                # 주문/취소/내역
│   ├── condition.ts            # 조건검색
│   └── settings.ts             # 설정
└── services/
    ├── kiwoomService.ts        # 키움 REST API (세션별 인스턴스)
    ├── kiwoomWebSocketService.ts # 실시간 시세 (세션별 인스턴스)
    ├── kiwoomRegistry.ts       # 라이선스 키 → KiwoomService 매핑
    ├── keyService.ts           # 라이선스 키 저장/검증
    └── stockConditionService.ts
```

## 설치

```bash
npm install
```

## 환경 변수 설정

`.env` 파일을 생성하세요. **프로덕션에서는 `ADMIN_TOKEN`이 필수입니다.**

```
NODE_ENV=development
PORT=3000

# 관리자 API 토큰 (프로덕션 필수)
# 미설정 시 프로덕션에서는 관리자 API가 503으로 비활성화된다.
ADMIN_TOKEN=충분히_긴_임의_문자열
```

키움 appkey/secretkey는 사용자가 화면에서 입력하며, 서버는 세션 메모리에만 보관합니다
(`data/license-keys.json`에는 라이선스 키만 저장).

## 실행

```bash
npm run dev:server   # 개발 (tsx watch)
npm start            # 프로덕션
```

프론트엔드는 별도:
```bash
npm run dev          # Vite (5000)
npm run dev:all      # 둘 다
```

## 인증

| 경로 | 요구 사항 |
|---|---|
| `/api/auth/*` | 없음 (라이선스 검증 전 단계) |
| `/api/admin/*` | `x-admin-token` 헤더 (ADMIN_TOKEN) |
| 그 외 `/api/*` | 라이선스 세션 (HttpOnly 쿠키 또는 `x-license-key` 헤더) |

**세션 쿠키**: `POST /api/auth/validate-key` 성공 시 `kiwoom_license` 쿠키를 발급한다.
`httpOnly`라 JS에서 읽을 수 없어 XSS로 탈취되지 않는다. 프로덕션에서는 `secure`(HTTPS 전용).

- `GET /api/auth/session` — 현재 세션 확인 (앱 시작 시 복원용)
- `POST /api/auth/logout` — 세션 쿠키 삭제

키를 localStorage에 저장하지 않는다 (만료 정보만 저장).

## 세션 분리

라이선스 키 하나가 하나의 세션입니다.

- `kiwoomRegistry.get(licenseKey)` → 해당 세션의 `KiwoomService`
- 각 세션은 독립된 키움 토큰/계좌/WebSocket을 가진다
- **같은 키움 계정(appkey)으로 두 세션이 연결되면 409로 거부**한다
  (키움은 계정당 WebSocket 1연결만 허용)
- 6시간 미사용 세션은 자동 정리

## WebSocket

```
ws://<host>/ws
```

인증은 **HttpOnly 세션 쿠키**로 이뤄진다 (URL에 키를 넣지 않는다 — 프록시/서버 로그에 남는다).
`verifyClient`에서 쿠키의 라이선스 키를 검증하고, 실패 시 4401로 거부한다.
세션 키가 일치하는 소켓에만 해당 계좌의 시세가 전송된다.

## 키 저장소 (PostgreSQL)

`DATABASE_URL`이 있으면 **Neon PostgreSQL**에 저장한다. 없으면 로컬 SQLite로 폴백한다.

```
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
DATABASE_SSL=true
```

- 테이블 `license_keys`는 서버 시작 시 자동 생성된다
- 서버 인스턴스가 여러 개여도 **같은 ���이터를 본다** (로드밸런서 뒤 다중 배포 가능)
- 처음 실행 시 로컬 `data/license-keys.db`(SQLite)에 남은 키를 자동 이전한다
- 점검: `node script/selfcheck-db.cjs`

저장소 이력:
| 버전 | 저장소 | 다중 서버 |
|---|---|---|
| 1 | `data/license-keys.json` | ❌ |
| 2 | `data/license-keys.db` (SQLite) | ⚠️ 같은 디스크만 |
| 3 | PostgreSQL (현재) | ✅ |

## 보안 설정

| 환경변수 | 설명 |
|---|---|
| `DATABASE_URL` | PostgreSQL 연결 문자열 (Neon). 없으면 SQLite 폴백 |
| `DATABASE_SSL` | `false`면 SSL 비활성 (기본: 활성) |
| `ADMIN_TOKEN` | 관리자 API 토큰. **프로덕션 필수** (미설정 시 관리자 API 503) |
| `ALLOWED_ORIGINS` | CORS 허용 origin (쉼표 구분). 미설정 시 localhost:5000/5001 |
| `NODE_ENV` | `production`이면 HTTPS 강제 + 쿠키 secure |

## API 엔드포인트

- `POST /api/auth/validate-key` - 라이선스 키 검증
- `POST /api/admin/keys/issue` - 키 발급 (관리자)
- `GET /api/admin/keys` - 키 목록 (관리자)
- `POST /api/kiwoom/connect` - 키움 연결
- `POST /api/kiwoom/disconnect` - 연결 해제 (해당 세션만)
- `GET /api/kiwoom/status` - 연결 상태
- `GET /api/stocks` - 종목 리스트
- `GET /api/stocks/search?q=` - 종목명/코드 검색
- `GET /api/stocks/:code/price` - 현재가
- `GET /api/stocks/:code/candle` - 차트
- `GET /api/accounts` - 계좌 정보
- `GET /api/accounts/balance` - 보유 종목
- `POST /api/orders` - 주문
- `POST /api/orders/cancel` - 주문 취소
- `GET /api/orders/history` - 주문 내역

## 미체결 자동취소

서버에서 5초마다 미체결 주문을 확인한다.

- **시장가** 주문이 30초 넘게 미체결이면 취소 (물량이 잠겨 매도가 막힘)
- **지정가** 주문은 취소하지 않음 (체결을 기다려야 함)
- 잔고의 매도가능수량이 보유수량과 같으면 이미 종료된 주문으로 보고 건너뜀

## 주의사항

- 프로덕션에서는 HTTPS 필수 (`NODE_ENV=production`이면 HTTP 요청은 403)
- `data/license-keys.db`는 git에 커밋하지 않는다 (`.gitignore` 적용됨)
- appkey/secretkey는 브라우저 localStorage에 남는다. 공용 PC에서는 사용하지 말 것
  (서버 재시작 후 자동 재연결에 필요해 유지)
- 모의투자 환경에서 먼저 테스트하세요
