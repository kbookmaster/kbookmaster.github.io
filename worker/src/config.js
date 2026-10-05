// 채팅 규칙에 쓰이는 숫자들. 규칙을 바꾸고 싶으면 여기 숫자만 고친다.
// 바꾼 뒤에는 docs/chat-spec.md도 같이 고친다.

export const LIMITS = {
  // 3턴 규칙: 내 마지막 답장 이후 방문자가 보낼 수 있는 메시지 수
  turnsPerReply: 3,
  // 메시지 하나, 노크 편지 하나의 최대 글자 수
  messageChars: 1000,
  // 방문자 이름 최대 글자 수
  nameChars: 40,
  // 입장 암호 길이
  passcodeMin: 4,
  passcodeMax: 32,
  // 한 대화방에서 방문자가 하루에 할 수 있는 편집 수 (번역비 폭주 방지)
  visitorEditsPerDay: 30,
  // 하루에 받을 수 있는 노크 수 (번역비 폭주 방지)
  knocksPerDay: 100,
};

export const SECURITY = {
  // 관리자 비밀번호를 이만큼 틀리면 잠긴다
  adminMaxFails: 5,
  // 잠기는 시간 (밀리초) : 15분
  adminLockMs: 15 * 60 * 1000,
  // 입장 암호도 같은 규칙 (대화방마다 따로 센다)
  passcodeMaxFails: 5,
  passcodeLockMs: 15 * 60 * 1000,
  // 관리자 로그인 유지 기간 : 30일
  adminSessionMs: 30 * 24 * 60 * 60 * 1000,
  // 텔레그램 연결 확인 코드 유효 시간 : 10분
  telegramCodeMs: 10 * 60 * 1000,
};

export const TRANSLATION = {
  // 문맥으로 함께 보내는 최근 메시지 수
  contextMessages: 6,
  // 번역 시도 최대 횟수 (넘으면 원문만 보여준다)
  maxTries: 5,
  // 번역 중 표시가 이 시간보다 오래되면 멈춘 것으로 보고 다시 시도한다 : 3분
  staleMs: 3 * 60 * 1000,
};

export const TELEGRAM = {
  maxTries: 5,
};
