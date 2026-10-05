// Claude API로 번역한다.
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

const DEFAULT_MODEL = 'claude-opus-5-5';

export function languageName(code) {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    if (name) return name;
  } catch (e) { /* 모르는 코드면 코드를 그대로 쓴다 */ }
  return code;
}

// 가짜 번역: 내부 시험용. 실제 API를 부르지 않는다.
function fakeTranslate({ text, targetCode }) {
  let lang = 'en';
  if (/[가-힣ㄱ-ㆎ]/.test(text)) lang = 'ko';
  else if (/[ñ¿¡]/.test(text)) lang = 'es';
  const translation = lang === targetCode.split('-')[0] ? text : `[${targetCode}] ${text}`;
  return { lang, translation };
}

function parseOutput(raw) {
  const lang = /<language>\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\s*<\/language>/.exec(raw);
  const tr = /<translation>\n?([\s\S]*?)\n?<\/translation>/.exec(raw);
  if (!tr) throw new Error('translation output had no <translation> tag');
  return { lang: lang ? lang[1] : '', translation: tr[1] };
}

// text: 번역할 원문, targetCode: 목표 언어 코드, context: [{label, text}], speakerLabel: 글쓴이
export async function translate(env, flags, { text, targetCode, context, speakerLabel }) {
  if (flags.fakeTranslate) return fakeTranslate({ text, targetCode });
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

  const model = (env.TRANSLATE_MODEL || DEFAULT_MODEL).trim();
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: buildUserPrompt({
        context,
        speakerLabel,
        targetCode,
        targetName: languageName(targetCode),
        text,
      }),
    }],
  };

  let response;
  if (/^claude-(opus|sonnet)-5/.test(model)) {
    // 정확성 우선: 생각 깊이를 high로. 안전 거절이 나면 권장 모델로 자동 재시도.
    response = await client.beta.messages.create({
      ...params,
      output_config: { effort: 'high' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } else {
    response = await client.messages.create(params);
  }

  if (response.stop_reason === 'refusal') throw new Error('translation was refused');
  if (response.stop_reason === 'max_tokens') throw new Error('translation was cut off');
  const raw = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseOutput(raw);
}
