/**
 * main.js ― 拡張翻訳・空間ウィンドウ（MVP）
 * 入力: カメラ映像 + マイク音声（Web Speech API / 手入力フォールバック）
 * 処理: engine/translate-engine.js（Gemini マルチモーダル拡張翻訳）
 * 出力: 字幕 + Three.js 空間タグピン
 */
import * as THREE from 'three';
import { extendedTranslate, getApiKey, setApiKey, MOCK_RESULT } from './engine/translate-engine.js';

const $ = (id) => document.getElementById(id);
const video = $('camera');
let stream = null;

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
  recognition.onerror = () => { recognition = null; };
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

/* ---------- 拡張翻訳の実行 ---------- */
async function runTranslate() {
  const useDemo = $('chk-demo').checked;
  const transcript = $('transcript').value.trim();
  $('btn-translate').disabled = true;
  $('status-chip').textContent = '拡張翻訳中…';
  let frame = { mimeType: 'image/jpeg', data: '', bytes: 0 };
  if (stream && !useDemo) frame = captureFrame();

  try {
    const result = useDemo ? { ...MOCK_RESULT, source: 'demo' } : await extendedTranslate(frame, transcript);
    renderResult(result);
    $('status-chip').textContent = '拡張翻訳を表示中';
  } catch (e) {
    $('status-chip').textContent = 'エラー: ' + e.message;
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

/* ---------- 設定・初期化 ---------- */
$('btn-settings').addEventListener('click', () => { $('api-key').value = getApiKey(); $('settings').classList.remove('hidden'); });
$('btn-close-settings').addEventListener('click', () => $('settings').classList.add('hidden'));
$('btn-save-key').addEventListener('click', () => { setApiKey($('api-key').value.trim()); $('settings').classList.add('hidden'); });
$('btn-camera').addEventListener('click', startCamera);
$('btn-record').addEventListener('click', toggleRecord);
$('btn-translate').addEventListener('click', runTranslate);
