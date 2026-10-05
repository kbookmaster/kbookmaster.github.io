# Letters Without Borders: K작가 책방 소개 페이지

- index.html : 완성된 페이지 (이 파일 하나로 동작)
- i18n/*.json : 10개 언어 문구 원본 (en, ko, ja, zh, es, fr, de, pt, et, fa)
- template.html : 페이지 틀
- build.py : 문구 원본과 틀을 합쳐 index.html을 다시 만드는 스크립트 (python3 build.py)

문구를 고칠 때는 i18n 폴더의 json을 고친 뒤 build.py를 실행해 index.html을 새로 만든다.
주의: 대시 문자(em dash, en dash)는 쓰지 않는다. build.py가 자동으로 검사한다.

## 후원 버튼 (긴 편지 9쪽)
- 지금은 한국어에만 문구가 있고, 다른 언어에서는 이 칸이 숨겨진다.
- Ko-fi 주소가 생기면 template.html의 var SUPPORT={coffee:"",brick:""} 에 두 주소를 넣고 build.py를 다시 실행한다.
