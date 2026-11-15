/**
 * engine/metrics.js ― 実験ログ（4つの壁の回収データ）
 * localStorage に蓄積し、JSONで書き出せる。
 * 1. 技術: レイテンシ内訳 / 画像サイズ / 電池
 * 4. 原価: API推定コスト（概算であることを明記して記録する）
 * 2. 比較 / 3. 開発メモ / 4. 支払い意向 も同じログに残す。
 */

const LOG_KEY = 'etw_experiment_log_v1';

// 概算前提（Gemini Flash系, 2026-11時点の公開価格ベースの目安）:
// 入力 $0.30 / 1M tokens, 出力 $2.50 / 1M tokens。画像1枚 ≒ 258〜1,032 tokens。
// ここでは中央値として 560 tokens/枚 で計算し、「概算」と明記する。
const USD_JPY = 155;
const PRICE_IN_PER_TOKEN = 0.30 / 1_000_000;
const PRICE_OUT_PER_TOKEN = 2.50 / 1_000_000;
const IMAGE_TOKENS = 560;

export function estimateCostYen({ transcriptChars = 0, outputChars = 0 }) {
  const inTokens = IMAGE_TOKENS + Math.ceil(transcriptChars * 1.5) + 700; // +プロンプト分
  const outTokens = Math.ceil(outputChars * 1.5);
  const usd = inTokens * PRICE_IN_PER_TOKEN + outTokens * PRICE_OUT_PER_TOKEN;
  return { yen: usd * USD_JPY, inTokens, outTokens };
}

export function loadLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch { return []; }
}
function saveLog(log) { localStorage.setItem(LOG_KEY, JSON.stringify(log)); }

export function addEntry(entry) {
  const log = loadLog();
  log.push({ at: new Date().toISOString(), ...entry });
  saveLog(log);
  return log;
}

export function clearLog() { localStorage.removeItem(LOG_KEY); }

export function exportLog() {
  const blob = new Blob([JSON.stringify(loadLog(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `etw-experiment-log-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function batteryLevel() {
  try {
    if (!navigator.getBattery) return null;
    const b = await navigator.getBattery();
    return Math.round(b.level * 100);
  } catch { return null; }
}
