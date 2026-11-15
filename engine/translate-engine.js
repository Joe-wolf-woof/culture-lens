/**
 * engine/translate-engine.js ― 拡張翻訳エンジン
 *
 * 単なる直訳ではなく、映像＋語り手の言葉から
 * 「文化・歴史・語り手の感情」の文脈を JSON で抽出する。
 *
 * プロンプト設計（心理学・行動科学の知見を組み込み済み）:
 * - 情報ギャップ理論（Loewenstein）: 「知っているつもり」と「知らないこと」の
 *   落差を1つだけ鋭く提示すると好奇心が最大化する。タグを並べるのではなく
 *   "cultural_gap" を1つに絞らせる。
 * - 自己関連効果: 受け手（英語圏の生活者）の日常と接続する一文を必ず入れる。
 * - 具体性効果: 抽象的な文化説明ではなく、感覚（匂い・手触り・音・温度）で語る。
 * - 物語輸送: 語り手の感情と小さなエピソードを字幕に残す（無難な説明との差分）。
 *
 * Gemini キーが無ければモック（チャイのデモデータ）を返す。
 * モデルフォールバックは HowLink と同じ方式（3.x系から試行、404/429/503で次へ）。
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_CANDIDATES = [
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];
const KEY_STORAGE = 'etw_gemini_api_key';
const MODEL_STORAGE = 'etw_gemini_model';

export function getApiKey() { return localStorage.getItem(KEY_STORAGE) || ''; }
export function setApiKey(k) { localStorage.setItem(KEY_STORAGE, k); localStorage.removeItem(MODEL_STORAGE); }

const EXTENDED_TRANSLATION_PROMPT = `
あなたは「拡張翻訳」エンジンです。入力は (1) 現地の景色・モノを写した画像、(2) 語り手が自分の言葉（日本語）で語ったテキストです。
受け手は英語圏の一般生活者です。Google翻訳やGoogleレンズのような「正確だが無難で退屈な説明」は禁止です。

やること:
1. literal_translation: 語り手の言葉の忠実な英訳。
2. extended_translation: 感情と文脈が伝わる英語の字幕（2文以内）。語り手の声の温度を残すこと。
3. tags: 画像の中のモノ・風景について2〜4個。各タグには、その文化でそれが大切な理由（why_it_matters）と、受け手の日常と接続する一文を含める。x,y は画像内の位置（0〜1）。
4. cultural_gap: 受け手が最も驚く異文化のギャップを「1つだけ」選んで書く（情報ギャップ理論：落差は1つに絞るほど好奇心が強くなる）。
5. curiosity_hook: 読んだ人が次に質問したくなる「問い」を1文で。
6. speaker_emotion: 語り手の感情を英語1語＋短い根拠。

必ず次のJSON形式だけで答えてください:
{"literal_translation":"","extended_translation":"","speaker_emotion":"","scene_summary":"","tags":[{"title":"","x":0.5,"y":0.5,"description":"","why_it_matters":""}],"cultural_gap":"","curiosity_hook":""}
`.trim();

export const MOCK_RESULT = {
  literal_translation: "This is masala chai made from whole spices. On cold days, holding the cup with both hands is our family's winter ritual.",
  extended_translation: "He doesn't buy tea bags. He crushes whole spices by hand — because in his home, warmth is something you make, not something you buy.",
  speaker_emotion: "proud — he slows down when describing the two-handed grip on the cup",
  scene_summary: "A small home kitchen; a pot of masala chai simmering, whole spices beside it.",
  tags: [
    { title: "Masala chai from whole spices", x: 0.45, y: 0.55, description: "Cardamom, cloves and ginger, crushed just before brewing — never pre-mixed powder.", why_it_matters: "Grinding spices by hand is a small daily act of care; the aroma is the signal that 'someone is home'." },
    { title: "The two-handed cup", x: 0.6, y: 0.7, description: "Holding a hot cup with both palms is a winter habit across Japan, for tea and soup alike.", why_it_matters: "Warmth through the palms is treated as comfort itself — the drink is almost an excuse." },
  ],
  cultural_gap: "In Japan, a drink can be a hand-warmer first and a beverage second — convenience stores even sell hot canned drinks purely to hold on cold train platforms.",
  curiosity_hook: "What everyday object in your home would carry this much memory for you?",
  source: 'mock',
};

function orderedModels() {
  const saved = localStorage.getItem(MODEL_STORAGE);
  if (saved && MODEL_CANDIDATES.includes(saved)) return [saved, ...MODEL_CANDIDATES.filter(m => m !== saved)];
  return MODEL_CANDIDATES;
}

async function callModel(model, key, parts) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
  };
  const res = await fetch(`${API_BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* noop */ }
    const err = new Error(`Gemini API error: ${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const parsed = JSON.parse(raw);
  parsed.source = `gemini (${model})`;
  return parsed;
}

/**
 * @param {{mimeType:string, data:string}} frame Base64フレーム
 * @param {string} transcript 語り手の言葉
 * @returns {Promise<object>} 拡張翻訳JSON
 */
export async function extendedTranslate(frame, transcript) {
  const key = getApiKey();
  if (!key) return { ...MOCK_RESULT };
  const parts = [
    { text: `${EXTENDED_TRANSLATION_PROMPT}\n\n語り手の言葉（日本語）: ${transcript || '（言葉なし。画像の文脈から推定する）'}` },
    { inline_data: { mime_type: frame.mimeType, data: frame.data } },
  ];
  let lastError = null;
  for (const model of orderedModels()) {
    try {
      const out = await callModel(model, key, parts);
      localStorage.setItem(MODEL_STORAGE, model);
      return out;
    } catch (err) {
      lastError = err;
      if (![404, 429, 503].includes(err.status)) throw err;
    }
  }
  throw lastError;
}
