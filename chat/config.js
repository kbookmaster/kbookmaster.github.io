// 채팅 코너 설정. 여기에는 공개해도 되는 값만 넣는다. 비밀 키는 절대 넣지 않는다.
window.CHAT_CONFIG = {
  // Cloudflare Worker 주소. 예: "https://kbook-chat.이름.workers.dev"
  // 비어 있으면 대문의 Message 버튼은 Coming soon 안내만 띄운다.
  apiBase: "",
  // Turnstile 사이트 키 (공개용 site key). 비밀 키(secret key)가 아니다.
  turnstileSiteKey: ""
};
