/**
 * main.js ― 拡張翻訳・空間ウィンドウ（MVP）
 * 入力: カメラ映像 + マイク音声（Web Speech API / 手入力フォールバック）
 * 処理: engine/translate-engine.js（Gemini マルチモーダル拡張翻訳）
 * 出力: 字幕 + Three.js 空間タグピン + 疑似チップボタン
 * 計測: engine/metrics.js（4つの壁の回収ログ）
 */
import * as THREE from 'three';
import { extendedTranslate, getApiKey, setApiKey, MOCK_RESULT } from './engine/translate-engine.js';
import { addEntry, loadLog, clearLog, exportLog, estimateCostYen, batteryLevel } from './engine/metrics.js';

const $ = (id) => document.getElementById(id);
const video = $('camera');
let stream = null;
let lastResult = null;
let tipYen = 0, tipPoints = 0;

/* ---------- カメラ ---------- */
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    $('status-chip').textContent = 'カメラ起動中（背面）';
    $('btn-record').disabled = false;
    $('btn-translate').disabled = false;
  } catch (e) {
    $('status-chip').textContent = 'カメラを起動できませんでした: ' + e.message;
    addEntry({ type: 'wall1_device_block', error: String(e) });
  }
}

function captureFrame() {
  const c = document.createElement('canvas');
  const scale = Math.min(1, 960 / (video.videoWidth || 960));
  c.width = (video.videoWidth || 960) * scale;
  c.height = (video.videoHeight || 720) * scale;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', 0.72);
  return { mimeType: 'image/jpeg', data: dataUrl.split(',')[1], bytes: Math.floor(dataUrl.length * 0.75) };
}

/* ---------- 音声入力（語り手の声） ---------- */
let recognition = null;
function toggleRecord() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('このブラウザは音声認識に未対応です。下のテキスト欄に手入力してください。'); return; }
  if (recognition) { recognition.stop(); return; }
  recognition = new SR();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = true;
  let base = $('transcript').value;
  recognition.onresult = (ev) => {
    let text = '';
    for (const r of ev.results) text += r[0].transcript;
    $('transcript').value = base + text;
  };
  recognition.onend = () => { recognition = null; $('btn-record').textContent = '🎙 語る（音声入力）'; };
  recognition.onerror = (e) => { addEntry({ type: 'wall1_speech_error', error: e.error }); recognition = null; };
  recognition.start();
  $('btn-record').textContent = '⏹ 停止';
}

/* ---------- Three.js 空間タグ ---------- */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
const scene = new THREE.Scene();
const cam3d = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
cam3d.position.z = 5;
let tagGroup = new THREE.Group();
scene.add(tagGroup);

function resizeGL() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  cam3d.aspect = w / h;
  cam3d.updateProjectionMatrix();
}
new ResizeObserver(resizeGL).observe(canvas);

function makeLabelTexture(title, idx) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(10,12,16,0.82)';
  g.beginPath(); g.roundRect(4, 14, 504, 100, 22); g.fill();
  g.fillStyle = '#d29922';
  g.beginPath(); g.arc(52, 64, 26, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#111'; g.font = 'bold 40px sans-serif'; g.textAlign = 'center';
  g.fillText(String(idx + 1), 52, 79);
  g.fillStyle = '#fff'; g.font = 'bold 30px sans-serif'; g.textAlign = 'left';
  const t = title.length > 22 ? title.slice(0, 22) + '…' : title;
  g.fillText(t, 92, 76);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function placeTags(tags) {
  scene.remove(tagGroup);
  tagGroup = new THREE.Group();
  tags.forEach((tag, i) => {
    const mat = new THREE.MeshBasicMaterial({ map: makeLabelTexture(tag.title, i), transparent: true });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), mat);
    // AIが返した画像内座標(0〜1)を NDC 経由で空間にピン留めする（固定カメラ近似）
    mesh.position.set((tag.x - 0.5) * 4.6, (0.5 - tag.y) * 3.4, 0);
    mesh.userData.baseY = mesh.position.y;
    mesh.userData.phase = i * 1.3;
    tagGroup.add(mesh);
  });
  scene.add(tagGroup);
}

function animate(t) {
  requestAnimationFrame(animate);
  tagGroup.children.forEach((m) => { m.position.y = m.userData.baseY + Math.sin(t / 900 + m.userData.phase) * 0.05; });
  renderer.render(scene, cam3d);
}
requestAnimationFrame(animate);
resizeGL();

/* ---------- 拡張翻訳の実行と計測（壁1・壁4） ---------- */
async function runTranslate() {
  const useDemo = $('chk-demo').checked;
  const transcript = $('transcript').value.trim();
  $('btn-translate').disabled = true;
  $('status-chip').textContent = '拡張翻訳中…';
  const t0 = performance.now();
  let frame = { mimeType: 'image/jpeg', data: '', bytes: 0 };
  if (stream && !useDemo) frame = captureFrame();
  const batteryBefore = await batteryLevel();

  try {
    const result = useDemo ? { ...MOCK_RESULT, source: 'demo' } : await extendedTranslate(frame, transcript);
    const tApi = performance.now();
    lastResult = result;
    renderResult(result);
    const tRender = performance.now();

    const cost = estimateCostYen({ transcriptChars: transcript.length, outputChars: JSON.stringify(result).length });
    const apiMs = Math.round(tApi - t0);
    $('latency-line').textContent =
      `レイテンシ: 取得+API ${apiMs} ms / 描画 ${Math.round(tRender - tApi)} ms / 合計 ${Math.round(tRender - t0)} ms（出典: ${result.source}）`;
    $('status-chip').textContent = '拡張翻訳を表示中';

    addEntry({
      type: 'wall1_wall4_measurement',
      api_ms: apiMs, render_ms: Math.round(tRender - tApi), total_ms: Math.round(tRender - t0),
      image_kb: Math.round(frame.bytes / 1024), cost_yen_per_call: Number(cost.yen.toFixed(3)),
      cost_yen_per_minute_x6: Number((cost.yen * 6).toFixed(2)),
      battery_pct: batteryBefore, source: result.source,
      curiosity_gap: result.cultural_gap || '',
    });
    refreshMetrics();
  } catch (e) {
    $('status-chip').textContent = 'エラー: ' + e.message;
    addEntry({ type: 'wall1_api_error', error: String(e), ms: Math.round(performance.now() - t0) });
  } finally {
    $('btn-translate').disabled = false;
  }
}

function renderResult(r) {
  $('subtitle-bar').classList.remove('hidden');
  $('subtitle-original').textContent = r.literal_translation || '';
  $('subtitle-extended').textContent = r.extended_translation || '';
  if ($('chk-speak').checked && r.extended_translation) {
    const u = new SpeechSynthesisUtterance(r.extended_translation);
    u.lang = 'en-US'; u.rate = 0.98;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  placeTags(r.tags || []);
  const cards = $('tag-cards');
  cards.innerHTML = '';
  $('tags-empty').style.display = r.tags?.length ? 'none' : '';
  (r.tags || []).forEach((tag, i) => {
    const div = document.createElement('div');
    div.className = 'tag-card';
    div.innerHTML = `<h4>${i + 1}. ${escapeHtml(tag.title)}</h4><p>${escapeHtml(tag.description)}</p><p class="why">なぜ大切か: ${escapeHtml(tag.why_it_matters || '')}</p>`;
    cards.appendChild(div);
  });
  if (r.cultural_gap || r.curiosity_hook) {
    $('gap-box').classList.remove('hidden');
    $('gap-text').textContent = r.cultural_gap || '';
    $('hook-text').textContent = r.curiosity_hook || '';
  }
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

/* ---------- 疑似チップ（壁4） ---------- */
$('btn-tip').addEventListener('click', () => {
  tipYen += 100; tipPoints += 1;
  $('tip-yen').textContent = '¥' + tipYen.toLocaleString();
  $('tip-points').textContent = tipPoints;
  addEntry({ type: 'wall4_tip', yen: 100, total_yen: tipYen, scene: lastResult?.scene_summary || '(no scene yet)' });
  $('btn-tip').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 220 });
});

/* ---------- 実験パネル ---------- */
function refreshMetrics() {
  const log = loadLog();
  const ms = log.filter(e => e.type === 'wall1_wall4_measurement');
  const tbody = document.querySelector('#metrics-table tbody');
  tbody.innerHTML = '';
  ms.slice(-8).forEach(e => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${e.at.slice(11, 19)}</td><td>${e.api_ms} ms</td><td>${e.image_kb}</td><td>¥${e.cost_yen_per_call}</td><td>${e.battery_pct ?? '—'}%</td>`;
    tbody.appendChild(tr);
  });
  if (ms.length) {
    const avg = Math.round(ms.reduce((a, e) => a + e.api_ms, 0) / ms.length);
    const avgCost = (ms.reduce((a, e) => a + e.cost_yen_per_call, 0) / ms.length).toFixed(2);
    $('metrics-summary').textContent = `計測 ${ms.length} 回 / 平均API応答 ${avg} ms / 平均原価 ¥${avgCost}/回`;
    $('per-minute').textContent = `1分間の体験共有（10秒×6回送信と仮定）: 通信量 約${(ms.reduce((a, e) => a + e.image_kb, 0) / ms.length * 6 / 1024).toFixed(2)} MB / API原価 約¥${(avgCost * 6).toFixed(1)}`;
  }
  const wtp = log.filter(e => e.type === 'wall4_wtp');
  if (wtp.length) {
    const vals = wtp.map(e => e.yen);
    $('wtp-summary').textContent = `回答 ${wtp.length} 件 / 中央値 ¥${vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)]} / 最高 ¥${Math.max(...vals)}`;
  }
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tabpage').forEach(p => p.classList.add('hidden'));
    $('tab-' + tab.dataset.tab).classList.remove('hidden');
  });
});

$('btn-save-compare').addEventListener('click', () => {
  addEntry({ type: 'wall2_comparison', bigtech_memo: $('cmp-bigtech').value, score_bigtech: Number($('cmp-score-big').value), score_ours: Number($('cmp-score-ours').value), our_gap: lastResult?.cultural_gap || '' });
  alert('比較データを記録しました');
});
$('btn-save-dev').addEventListener('click', () => {
  addEntry({ type: 'wall3_devnote', feel: $('dev-feel').value, area: $('dev-area').value, memo: $('dev-memo').value });
  $('dev-memo').value = '';
  alert('開発メモを記録しました');
});
document.querySelectorAll('#wtp-buttons button').forEach(b => {
  b.addEventListener('click', () => {
    addEntry({ type: 'wall4_wtp', yen: Number(b.dataset.yen), who: $('wtp-who').value || 'anonymous' });
    refreshMetrics();
  });
});
$('btn-export').addEventListener('click', exportLog);
$('btn-clear-log').addEventListener('click', () => { if (confirm('実験ログを消去しますか？')) { clearLog(); refreshMetrics(); } });

/* ---------- 設定・初期化 ---------- */
$('btn-settings').addEventListener('click', () => { $('api-key').value = getApiKey(); $('settings').classList.remove('hidden'); });
$('btn-close-settings').addEventListener('click', () => $('settings').classList.add('hidden'));
$('btn-save-key').addEventListener('click', () => { setApiKey($('api-key').value.trim()); $('settings').classList.add('hidden'); });
$('btn-camera').addEventListener('click', startCamera);
$('btn-record').addEventListener('click', toggleRecord);
$('btn-translate').addEventListener('click', runTranslate);
refreshMetrics();
