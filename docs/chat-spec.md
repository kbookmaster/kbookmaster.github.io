# 채팅 코너 설계서 (chat-spec)

## 0. 원칙: 최소화

이 채팅 코너는 안정성과 쾌적함을 위해 코드, 유지, 처리 모두 최소화한다.
- 새 기능이나 수정은 먼저 꼭 필요한지 따진다.
- 더 단순한 방법이 있으면 그쪽을 먼저 제안한다.
- 붙이는 기능은 비밀 값이 없으면 스스로 꺼지게 만든다. 지우지 않고 꺼둔다.

이 문서는 채팅 코너의 기억이다. 기능을 바꿀 때마다 이 문서도 같이 고친다.
새 세션을 열면 이 문서부터 읽으면 맥락이 되살아난다.

주의: 이 저장소는 공개다. 이 문서에는 비밀, 키, 비밀번호, 개인 정보를 절대 적지 않는다.

마지막 갱신: 2026-10-05 (최소화 원칙, 기능 자동 꺼짐)

## 지금 상태 (한눈에)

| 기능 | 켜지는 조건 | 꺼져 있을 때 |
| --- | --- | --- |
| 번역 | 비밀 `ANTHROPIC_API_KEY`가 있을 때 | 원문만 보여주고 Claude API를 부르지 않는다 |
| 텔레그램 | 비밀 `TELEGRAM_BOT_TOKEN`이 있을 때 | 알림 없이 관리 페이지에서만 확인한다 |
| 사람 확인 (Turnstile) | 비밀 `TURNSTILE_SECRET_KEY`가 있을 때 | 사람 확인 없이 노크를 받는다 |

- 지금 필요한 비밀은 `ADMIN_PASSWORD` 하나뿐이다.
- 관리 페이지 맨 위에 꺼진 기능이 한 줄로 보인다.
- 비밀을 넣으면 다시 배포하지 않아도 그 순간부터 켜진다.
- 번역과 텔레그램이 모두 꺼져 있으면 2분마다 도는 정리 작업도 할 일 없이 바로 끝난다.
- 아래 4장(번역), 6장(텔레그램), Turnstile 설명은 켜졌을 때의 동작이다.

---

## 1. 한눈에 보기

| 부분 | 무엇으로 | 어디에 |
| --- | --- | --- |
| 대문, 노크 창, 대화방 화면, 관리 페이지 | 정적 HTML (GitHub Pages) | `index.html`, `chat/` |
| 서버 | Cloudflare Workers | `worker/` |
| 대화 장부 | Cloudflare D1 (SQLite) | 표는 서버가 처음 켜질 때 스스로 만든다 |
| 알림과 빠른 답장 | 텔레그램 봇 | 서버의 `/telegram/webhook` |
| 번역 | Claude API | `worker/src/prompt.js`, `worker/src/translate.js` |
| 사람 확인 | Cloudflare Turnstile | 노크 창, 관리자 로그인 |

- 화면(HTML)은 GitHub Pages가 보여주고, 화면은 Cloudflare Worker 주소로 말을 건다.
- Cloudflare가 이 저장소의 `worker/` 폴더를 지켜보다가 main에 푸시되면 자동으로 다시 배포한다.
- 관리 페이지에서 답하든 텔레그램에서 답하든 같은 장부(D1)에 기록된다.

### 스위치: 아직 서버가 없을 때
`chat/config.js`의 `apiBase`가 비어 있으면 대문의 Message 버튼은 예전처럼 Coming soon 안내만 띄운다.
서버 배포가 끝나고 주소를 넣는 순간 노크 창이 열리기 시작한다. 그래서 코드를 먼저 올려도 사이트가 깨지지 않는다.

---

## 2. 입장 방식: 노크와 초대장

### 2.1 노크 (공개 문)
- 대문의 Message 버튼을 누르면 노크 창이 열린다.
- 방문자는 이름(40자까지)과 첫 편지 한 통(1,000자까지)만 남긴다. 가입은 없다.
- 같은 브라우저에서는 노크를 한 번만 할 수 있다 (브라우저 저장소에 노크 표식을 남긴다).
- Turnstile로 사람인지 확인한다. 자동 프로그램 노크와 번역비 낭비를 막는다.
- 노크는 한국어로 번역되어 관리 페이지와 텔레그램으로 온다. 텔레그램에는 번역과 원문을 함께 넣는다.
- 노크 뒤 방문자에게는 "답장을 받으면 대화방이 열린다"는 안내를 보여준다.
- 같은 브라우저에서 Message 버튼을 다시 누르면 초대 여부를 확인한다.
  - 아직이면: 기다리는 중이라는 안내.
  - 초대되었으면: 대화방 열기 버튼. 그 뒤로는 Message 버튼이 바로 대화방으로 간다.

### 2.2 초대장 (대화방 열쇠)
- 초대 링크 하나에 대화방 하나. 링크가 곧 열쇠라서 다른 기기에서 열어도 같은 대화가 이어진다.
- 링크 모양: `https://kbookmaster.github.io/chat/#k=열쇠`
  - 열쇠는 주소의 # 뒤에 있어서 GitHub Pages 서버로는 전송되지 않는다.
- 만드는 방법 두 가지
  1. 노크에 초대: 관리 페이지에서 노크 옆 Invite를 누른다. 짧은 첫 답장을 함께 쓸 수 있다.
     - 노크 편지는 대화방의 첫 메시지가 된다. 첫 답장을 쓰면 그 답장이 두 번째 메시지가 된다.
     - 초대 링크는 노크한 브라우저로 자동 전달된다 (2.1의 초대 여부 확인).
     - 그래서 노크 초대에는 입장 암호를 걸지 않는다. 암호를 방문자에게 알려줄 길이 없기 때문이다.
     - 텔레그램에서 노크 알림에 "답장(reply)"하면 그 글을 첫 답장으로 삼아 초대한다.
  2. 직접 초대: 노크 없이 이름(내가 알아볼 이름)으로 바로 만든다. 다른 곳에서 만난 사람에게 링크를 보낸다.
     - 선택: 짧은 입장 암호(4~32자). 암호를 걸면 방문자는 처음 한 번 암호를 넣어야 한다.
     - 선택: 상대 언어. 비워두면 방문자 브라우저 언어로 정한다.
- 나는 언제든 링크를 폐기(Revoke)할 수 있다. 폐기하면 방문자 화면은 "이 링크는 더 이상 열리지 않는다"만 보인다. 대화 기록은 관리 페이지에 남는다.
- 나도 관리 페이지에서 대화 전체를 지울 수 있다.

---

## 3. 대화방 규칙

- 3턴 규칙: 방문자는 내 마지막 답장 이후 최대 3개까지 보낼 수 있다. 내가 답장하면 다시 3개가 열린다.
  - 방문자 화면에 남은 개수를 보여준다.
  - 계산: 내 마지막 메시지 이후의 방문자 메시지 수. 지운 메시지도 개수에 남는다 (보내고 지우고 다시 보내는 꼼수 방지).
  - 내가 내 답장을 지워도 그 답장은 "답장한 것"으로 계속 센다.
- 메시지 하나는 1,000자까지.
- 편집과 삭제
  - 방문자와 나 모두 자기 메시지를 언제든 고치고 지울 수 있다.
  - 고친 메시지에는 작은 edited 표시를 남긴다. 고치면 번역도 다시 한다.
  - 편집과 삭제는 3턴 개수를 쓰지 않는다.
  - 지운 메시지는 내용이 장부에서 실제로 지워지고, 자리에는 "Message deleted"만 남는다.
  - 안전장치: 번역비 폭주를 막기 위해 한 대화방에서 하루 편집은 30번까지. (숫자는 `worker/src/config.js`)
- 텔레그램: 새 메시지, 수정본, 삭제 알림을 모두 새 메시지로 보낸다. 텔레그램에 이미 간 메시지를 고치거나 지우지 않는다.
- 원문 보기: 번역문 옆의 작은 Original 버튼으로 원문을 펼친다.
- 자동 삭제는 하지 않는다. 방문자는 Delete this conversation 버튼으로 자기 대화 전체를 지울 수 있다. 이때 나에게 텔레그램 알림이 간다.
- 방문자 화면에 "답장이 실시간이 아닐 수 있다"는 한 줄 안내가 있다.
- 새 메시지 확인: 방문자 화면은 15초마다, 관리 페이지는 20초마다 조용히 다시 불러온다 (화면이 보일 때만).

---

## 4. 번역

- Claude API를 쓴다. 속도보다 정확성과 섬세함이 우선이다.
- 모델은 `worker/wrangler.toml`의 한 줄 `TRANSLATE_MODEL`로 바꾼다.
  - 기본: `claude-opus-5-5`
  - 바꿀 수 있는 값: `claude-sonnet-5-5`, `claude-haiku-4-5-20251001`
- 정확성을 위해 Opus와 Sonnet에서는 생각 깊이(effort)를 high로 둔다. 안전 거절이 나오면 Anthropic이 권하는 다른 모델로 자동 재시도하는 설정(fallbacks)을 켠다.
- 번역 지시문은 `worker/src/prompt.js` 한 파일에 모아두었다. 말투, 유머, 괄호 속 농담, 불교 용어, ㅋㅋ 같은 웃음 표시를 살리라는 내용이다. 나중에 이 파일만 고치면 된다.
- 문맥: 같은 대화의 최근 메시지 6개를 함께 보낸다 (숫자는 `worker/src/config.js`).
- 언어 정하기
  - 처음에는 방문자 브라우저 언어로 정한다.
  - 방문자 메시지를 번역할 때 Claude가 실제 언어를 알려준다. 그 값으로 대화방 언어를 고친다. 내 답장은 그 언어로 번역된다.
  - 방문자가 한국어로 쓰면 번역하지 않고 그대로 둔다.
- 나는 한국어로 읽고 쓴다. 관리 페이지에서 내 메시지 아래 Translation 버튼으로 상대에게 간 번역을 확인할 수 있다.
- 번역 흐름
  1. 메시지를 장부에 먼저 저장하고 바로 화면에 보여준다.
  2. 번역은 뒤에서 한다. 끝나면 텔레그램 알림을 보낸다.
  3. 번역이 실패하거나 너무 오래 걸리면 2분마다 도는 정리 작업(cron)이 다시 시도한다 (최대 5번).
- 번역 비용은 Anthropic Console에 선불로 충전한 크레딧에서 나간다.

---

## 5. 관리 페이지 (주소: `/chat/admin/`)

- 관리자 비밀번호 로그인 + Turnstile.
- 비밀번호를 5번 틀리면 15분 잠긴다. (IP를 저장하지 않기 때문에 잠금은 전체에 걸린다. Turnstile이 있어서 자동 프로그램이 나를 계속 잠그기는 어렵다.)
- 로그인은 30일 유지된다. Log out으로 끝낼 수 있다.
- 할 수 있는 일
  - 노크 목록: 번역문, Original, 언어, 시각. Invite(첫 답장과 함께), Dismiss(지우기).
  - 대화방 목록: 이름, 언어, 마지막 활동, 새 메시지 표시, 남은 턴.
  - 대화방 열기: 메시지 읽기, 한국어로 답장, 내 메시지 고치기와 지우기, 링크 복사, 폐기, 대화 삭제.
  - 새 초대장 만들기: 이름, 언어(선택), 입장 암호(선택).
  - 텔레그램 연결: Connect Telegram 버튼, 확인 코드 방식 (6장 참고).

---

## 6. 텔레그램

- 봇 토큰은 Cloudflare 비밀 보관함에 둔다.
- 주인 등록 (확인 코드 방식)
  1. 관리 페이지에서 Connect Telegram을 누른다.
  2. 서버가 텔레그램에 웹훅 주소를 스스로 등록하고, 10분짜리 확인 코드와 봇 링크를 보여준다.
  3. 링크를 눌러 봇에서 Start를 누르면 (`/start 코드`) 그 텔레그램 계정이 주인으로 등록된다.
  4. 이후 봇은 주인 계정의 말만 듣는다. 다른 사람의 말은 무시한다.
- 웹훅 보안: 텔레그램이 보내는 비밀 머리표(secret token)를 확인한다. 이 값은 봇 토큰에서 자동으로 만들어서 따로 넣을 비밀이 없다.
- 알림 종류: 새 노크, 새 메시지, 수정본, 메시지 삭제, 대화 삭제. 번역과 원문을 함께 넣는다.
- 빠른 답장: 알림 메시지에 텔레그램의 "답장(reply)" 기능으로 글을 쓰면 그 대화방에 내 답장으로 들어간다.
  - 노크 알림에 답장하면 초대 + 첫 답장이 된다.
  - 서버가 번역을 끝내면 "보냄" 확인과 번역문을 돌려준다.
- 텔레그램에서는 편집과 삭제를 하지 않는다. 그런 일은 관리 페이지에서 한다.
- 알림 전송이 실패하면 정리 작업이 다시 보낸다.

---

## 7. 비밀과 개인정보

### 7.1 비밀 (Cloudflare 비밀 보관함에만)
| 이름 | 무엇 | 지금 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | 관리자 비밀번호 | 필수 |
| `ANTHROPIC_API_KEY` | Claude API 키 | 나중에 (없으면 번역 꺼짐) |
| `TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰 | 나중에 (없으면 텔레그램 꺼짐) |
| `TURNSTILE_SECRET_KEY` | Turnstile 비밀 키 | 나중에 (없으면 사람 확인 꺼짐) |

- 저장소에는 절대 넣지 않는다. 채팅에도 붙여넣지 않는다.
- Turnstile의 사이트 키(site key)는 공개용이라 `chat/config.js`에 넣어도 된다.

### 7.2 저장하는 것과 저장하지 않는 것
- 저장: 이름, 언어, 원문과 번역문, 시각, 초대 정보(열쇠, 암호의 해시), 텔레그램 주인 계정 번호.
- 저장하지 않음: IP 주소, 브라우저 정보, 추적 쿠키, 분석 도구.
- 입장 암호와 관리자 로그인 표는 원래 값이 아니라 해시만 저장한다.

### 7.3 방문자에게 보이는 개인정보 안내 (영어, 초안)
> **Privacy, briefly.** Your name and messages are stored so this conversation can continue. To bridge our languages, messages are translated by an AI service (Anthropic's Claude). I don't sell or share your messages with anyone else, and I don't track you or keep your IP address. You can delete this whole conversation at any time with the button below.

- 노크 창에서는 마지막 문장이 "Once you're invited, you can delete the whole conversation at any time from your conversation page."로 바뀐다.
- 문구 위치: `chat/common.js`의 `PRIVACY_NOTE`.
- 상태: 초안. K작가 확인 대기.

---

## 8. 서버 주소 (API) 목록

공개
- `POST /api/knock` 노크 남기기
- `POST /api/knock/status` 노크한 브라우저의 초대 여부 확인
- `GET /api/room` 대화방 불러오기 (머리표 `X-Room-Key`, 암호가 있으면 `X-Room-Unlock`)
- `POST /api/room/unlock` 입장 암호 확인
- `POST /api/room/messages`, `PATCH /api/room/messages/:id`, `DELETE /api/room/messages/:id`
- `DELETE /api/room` 대화 전체 지우기

관리자 (머리표 `Authorization: Bearer 로그인표`)
- `POST /api/admin/login`, `POST /api/admin/logout`
- `GET /api/admin/overview`
- `POST /api/admin/knocks/:id/invite`, `DELETE /api/admin/knocks/:id`
- `POST /api/admin/conversations` 직접 초대
- `GET /api/admin/conversations/:id`
- `POST /api/admin/conversations/:id/messages`
- `POST /api/admin/conversations/:id/revoke`, `DELETE /api/admin/conversations/:id`
- `PATCH /api/admin/messages/:id`, `DELETE /api/admin/messages/:id`
- `GET /api/admin/telegram`, `POST /api/admin/telegram/connect`, `POST /api/admin/telegram/disconnect`

텔레그램
- `POST /telegram/webhook`

---

## 9. 파일 지도

```
index.html               대문 (Message 버튼이 chat/knock.js를 부른다)
chat/config.js           서버 주소와 Turnstile 사이트 키 (공개 값만)
chat/common.js           화면 공용 도구, 개인정보 안내 문구
chat/knock.js            대문의 노크 창
chat/chat.css            채팅 화면 공용 모양
chat/index.html          방문자 대화방
chat/admin/index.html    주인 관리 페이지 (한국어)
worker/wrangler.toml     Worker 설정 (모델 이름 한 줄 포함)
worker/src/index.js      서버 입구와 길 안내
worker/src/config.js     숫자 규칙 (턴 수, 글자 수, 잠금 시간 등)
worker/src/prompt.js     번역 지시문 (여기만 고치면 번역 말투가 바뀐다)
worker/src/translate.js  Claude API 호출
worker/src/telegram.js   텔레그램 보내기와 받기
worker/src/db.js         장부 표 만들기와 공용 쿼리
worker/test/run.mjs      가짜 번역, 가짜 텔레그램으로 하는 내부 시험
```

---

## 10. 시험 방법 (개발용)

- `cd worker && npm install && npm test`
- 시험은 내 컴퓨터 안에서만 서버를 켠다 (`wrangler dev`, 로컬 D1).
- 서버를 두 번 켠다. 처음은 비밀이 `ADMIN_PASSWORD` 하나뿐인 꺼진 상태, 다음은 가짜 기능을 모두 켠 상태.
- 가짜 모드: `FAKE_TRANSLATE=1`, `FAKE_TELEGRAM=1`, `FAKE_TURNSTILE=1`. 이 스위치들은 주소가 localhost일 때만 듣는다. 실제 배포에서 실수로 켜져도 무시된다.
- 화면 시험 때는 `?api=http://localhost:8787`로 서버 주소를 바꿀 수 있다. 이것도 화면이 localhost에서 열렸을 때만 된다.

---

## 11. 결정 기록 (바뀐 것은 여기에 날짜와 함께 남긴다)

- 2026-10-05 첫 설계.
  - 노크 초대는 노크 편지를 첫 메시지로 삼고, 암호를 걸지 않는다.
  - 텔레그램 노크 알림에 답장하면 초대가 된다.
  - 지운 메시지도 3턴 개수에 남는다.
  - 한 대화방 하루 편집 30번 안전장치.
  - 관리자 비밀번호 5번 실패 시 15분 잠금, 입장 암호도 같은 규칙 (대화방마다).
  - 서버 주소가 비어 있으면 Message 버튼은 Coming soon 그대로.
  - 장부 표는 서버가 스스로 만든다 (손으로 SQL을 넣지 않아도 된다).
- 2026-10-05 방향 전환: 최소화 원칙.
  - 번역, 텔레그램, Turnstile은 비밀 값이 없으면 자동으로 꺼진다. 코드는 남겨두고, 비밀만 넣으면 켜진다.
  - 지금 필요한 비밀은 `ADMIN_PASSWORD` 하나.
  - 사람 확인이 꺼진 동안 자동 프로그램 노크는 하루 100개 제한만 막는다. 관리자 로그인 잠금(5번 실패, 15분)은 누구나 걸 수 있으니, 잠기면 15분 기다린다.
  - 방문자 화면의 번역 안내 문구와 개인정보 안내는 그대로 둔다 (번역을 켤 예정이라서).

---

## 12. 배포 설정 메모 (Cloudflare)

- Worker 이름: `kbook-chat`
- Cloudflare Workers Builds로 이 저장소를 연결한다.
  - 지켜볼 브랜치: `main`
  - 루트 디렉터리(Root directory): `worker`
  - 배포 명령(Deploy command): `npx wrangler deploy`
- D1 데이터베이스 이름: `kbook-chat`. 받은 database_id를 `worker/wrangler.toml`에 넣는다.
- 배포가 끝나면 Worker 주소를 `chat/config.js`의 `apiBase`에 넣는다. Turnstile을 켤 때 사이트 키를 `turnstileSiteKey`에 넣는다.
- Turnstile 위젯의 허용 도메인(hostname): `kbookmaster.github.io`
