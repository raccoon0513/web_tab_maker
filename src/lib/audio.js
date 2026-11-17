// Web Audio 기반 소리 합성 (기타 톤, 퍼커시브 뮤트, 메트로놈)
//
// 출력 경로:
//   기타음(voice)           → [재생 버스] → 3밴드 EQ → 마스터 볼륨 → 컴프레서 → 스피커
//   삼각파 · 뮤트 · 메트로놈 → [재생 버스] ─────────────→ 마스터 볼륨 → ...   (EQ를 거치지 않음)
//   - 마스터 볼륨 + 컴프레서: 화음이 겹쳐도 출력이 1을 넘어 찌그러지지(클리핑) 않게 함
//   - 재생 버스: 한 번의 재생에서 예약한 소리 묶음. 정지할 때 버스만 끄면 예약이 전부 취소됨

const METRONOME_GAIN = 0.5;
const MASTER_GAIN = 0.8;

// 음색 종류
export const TONE_BASIC = 'basic';  // 삼각파 (가볍고 단순, EQ 영향 없음)
export const TONE_PLUCK = 'pluck';  // 기타음: Karplus-Strong 줄 뜯는 소리 (나일론 기타 쪽 음색, EQ 적용)

// 음 하나의 최대 볼륨. 6음 화음이 겹쳐도 컴프레서가 감당할 수 있는 수준
const VOICE_GAIN = { [TONE_BASIC]: 0.3, [TONE_PLUCK]: 0.45 };
const RELEASE_SEC = 0.5;       // 음 길이가 끝난 뒤 여운
const CUT_FADE_SEC = 0.012;    // 같은 줄에서 새 음이 나올 때 앞 음을 끊는 페이드 시간

let audioCtx = null;
let masterInput = null;
let eqNodes = null;

// --- 3밴드 EQ (기타음에만 적용) ---
export const EQ_BANDS = {
  low: { type: 'lowshelf', frequency: 200 },
  mid: { type: 'peaking', frequency: 800, Q: 0.8 },
  high: { type: 'highshelf', frequency: 2500 },
};
export const EQ_MIN_DB = -24;
export const EQ_MAX_DB = 12;
export const DEFAULT_EQ = Object.freeze({ low: 3, mid: -10, high: -18 });
let eqGains = { ...DEFAULT_EQ };
let toneMode = TONE_BASIC;

// 현재 오디오 컨텍스트 (없으면 생성)
export const getAudioCtx = () => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
};

// 모든 소리가 모이는 마스터 입력 (마스터 볼륨 → 컴프레서 → 스피커)
const getMasterInput = () => {
  const ctx = getAudioCtx();
  if (!masterInput) {
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    compressor.connect(ctx.destination);

    masterInput = ctx.createGain();
    masterInput.gain.value = MASTER_GAIN;
    masterInput.connect(compressor);
  }
  return masterInput;
};

// 기타 소리가 들어가는 EQ 입력 (low → mid → high → 마스터)
const getEqInput = () => {
  const ctx = getAudioCtx();
  if (!eqNodes) {
    eqNodes = {};
    let prev = null;
    Object.entries(EQ_BANDS).forEach(([band, cfg]) => {
      const f = ctx.createBiquadFilter();
      f.type = cfg.type;
      f.frequency.value = cfg.frequency;
      if (cfg.Q) f.Q.value = cfg.Q;
      f.gain.value = eqGains[band];
      if (prev) prev.connect(f);
      eqNodes[band] = f;
      prev = f;
    });
    prev.connect(getMasterInput());
  }
  return eqNodes.low;
};

// EQ 값(dB) 변경. 재생 중에도 끊김 없이 부드럽게 바뀜
export const setEq = (gains) => {
  eqGains = { ...eqGains, ...gains };
  if (!eqNodes) return;
  const now = getAudioCtx().currentTime;
  Object.keys(EQ_BANDS).forEach((band) => eqNodes[band].gain.setTargetAtTime(eqGains[band], now, 0.03));
};

// 실제로 스피커에서 소리가 나는 시각 = currentTime - 출력 지연.
// 화면 표시는 이 값을 기준으로 해야 소리와 어긋나지 않는다.
export const getOutputLatency = () => {
  const ctx = getAudioCtx();
  return ctx.outputLatency || ctx.baseLatency || 0;
};

// 컨텍스트가 일시정지 상태면 깨운다 (브라우저 자동재생 정책)
export const resumeAudioCtx = async () => {
  const ctx = getAudioCtx();
  if (ctx.state !== 'running') await ctx.resume();
  return ctx;
};

export const setToneMode = (mode) => { toneMode = mode === TONE_PLUCK ? TONE_PLUCK : TONE_BASIC; };

// --- 재생 버스 ---

// inst: 기타음용 (EQ 거침), click: 삼각파 · 뮤트 · 메트로놈용 (EQ 안 거침)
export const createBus = () => {
  const ctx = getAudioCtx();
  const inst = ctx.createGain();
  inst.connect(getEqInput());
  const click = ctx.createGain();
  click.connect(getMasterInput());
  return { inst, click, sources: [] };
};

export const stopBus = (bus) => {
  if (!bus) return;
  bus.sources.forEach((src) => {
    try { src.stop(); } catch { /* 이미 끝난 소리 */ }
  });
  bus.sources = [];
  bus.inst.disconnect();
  bus.click.disconnect();
};

// 버스가 주어지면 버스로, 아니면 바로 출력. bypassEq면 EQ를 거치지 않음
const connectOut = (node, src, bus, bypassEq = false) => {
  if (bus) {
    node.connect(bypassEq ? bus.click : bus.inst);
    bus.sources.push(src);
    // 끝난 소리는 목록에서 정리
    src.onended = () => {
      const i = bus.sources.indexOf(src);
      if (i !== -1) bus.sources.splice(i, 1);
    };
  } else {
    node.connect(bypassEq ? getMasterInput() : getEqInput());
  }
};

// --- Karplus-Strong 줄 소리 (클래식/나일론 기타 쪽으로 조정) ---
// 짧은 노이즈를 "한 주기 길이의 지연선"에 넣고, 돌 때마다 이웃 샘플을 평균(저역 통과)하며
// 조금씩 줄인다. 고음 성분이 먼저 사라지는 실제 줄의 감쇠가 자연스럽게 생긴다.
// 나일론 줄 느낌을 위해:
//   1) 초기 노이즈를 여러 번 걸러 "손가락 살로 뜯는" 부드러운 시작
//   2) 뜯는 위치(줄 길이의 1/5 지점) 효과로 일부 배음 제거
//   3) 음마다 저역 통과 + 몸통 공명(저음 강조) 필터 (playTone에서)
// 음높이마다 한 번만 계산해서 캐시한다.
const PLUCK_BUFFER_SEC = 4;
const PLUCK_SOFTNESS = 0.8;      // 초기 노이즈 저역 통과 계수 (클수록 부드러움)
const PLUCK_SOFT_PASSES = 5;
const PLUCK_POSITION = 0.2;      // 줄 길이 대비 뜯는 위치
const PLUCK_ATTACK_SEC = 0.01;   // 시작 "틱" 소리 제거
const pluckCache = new Map();

// 밝기 (0 = 가장 먹먹, 1 = 가장 밝음). 저역 통과 차단 주파수를 정함
export const DEFAULT_PLUCK_BRIGHTNESS = 0.15;
let pluckBrightness = DEFAULT_PLUCK_BRIGHTNESS;
export const setPluckBrightness = (v) => { pluckBrightness = Math.min(1, Math.max(0, Number(v) || 0)); };
// 0 → 500Hz, 0.15 → 약 680Hz, 1 → 4000Hz (음높이가 높으면 기본음은 지나가도록 그보다 위로)
const pluckCutoff = (freq) => Math.max(freq * 1.5, 500 * Math.pow(2, pluckBrightness * 3));

// 울림 길이(소리가 1/1000로 줄어드는 시간, 초): 저음은 길게, 고음은 짧게
const pluckT60 = (midi) => {
  const t = Math.min(1, Math.max(0, (midi - 40) / 44));
  return 2.5 - 1.5 * t;
};

const getPluckBuffer = (midi) => {
  const ctx = getAudioCtx();
  const key = `${midi}@${ctx.sampleRate}`;
  if (pluckCache.has(key)) return pluckCache.get(key);

  const sr = ctx.sampleRate;
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  // 평균 필터가 반 샘플 지연을 더하므로 버퍼 속 주기 = N + 0.5 샘플.
  // 원하는 주기(sr / freq)와의 차이는 재생 속도로 보정: 출력 주기 = (N + 0.5) / playbackRate
  const N = Math.max(2, Math.round(sr / freq - 0.5));
  const playbackRate = (N + 0.5) / (sr / freq);

  // 한 주기마다 곱할 감쇠율 (T60초 동안 -60dB)
  const decay = Math.pow(10, -3 / (pluckT60(midi) * freq));

  const length = Math.floor(sr * PLUCK_BUFFER_SEC);
  const buffer = ctx.createBuffer(1, length, sr);
  const out = buffer.getChannelData(0);

  // 1) 부드러운 초기 신호: 노이즈를 여러 번 저역 통과
  const exc = new Float32Array(N);
  for (let i = 0; i < N; i++) exc[i] = Math.random() * 2 - 1;
  for (let pass = 0; pass < PLUCK_SOFT_PASSES; pass++) {
    let p = exc[N - 1]; // 주기 신호이므로 끝값에서 이어서 시작
    for (let i = 0; i < N; i++) {
      p = p * PLUCK_SOFTNESS + exc[i] * (1 - PLUCK_SOFTNESS);
      exc[i] = p;
    }
  }
  // 2) 뜯는 위치 효과 (빗살 필터): x[i] - x[i - P]
  const P = Math.max(1, Math.round(N * PLUCK_POSITION));
  const shaped = new Float32Array(N);
  for (let i = 0; i < N; i++) shaped[i] = exc[i] - exc[(i - P + N) % N];
  // 직류 성분 제거
  const mean = shaped.reduce((a, v) => a + v, 0) / N;
  for (let i = 0; i < N; i++) out[i] = shaped[i] - mean;

  for (let i = N; i < length; i++) {
    const a = out[i - N];
    const b = i - N - 1 >= 0 ? out[i - N - 1] : 0;
    out[i] = decay * 0.5 * (a + b);
  }

  // 최대 진폭을 1로 맞춤
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < length; i++) out[i] /= peak;

  const entry = { buffer, playbackRate };
  pluckCache.set(key, entry);
  return entry;
};

// --- 음 하나 (voice) ---
// 반환값은 나중에 releaseVoice로 끊을 수 있는 핸들
export const playTone = (midi, startTime, durationInSeconds, bus = null) => {
  const ctx = getAudioCtx();
  const gainNode = ctx.createGain();
  const peak = VOICE_GAIN[toneMode];
  const endTime = startTime + durationInSeconds + RELEASE_SEC;
  let src;
  let head; // src가 연결될 첫 노드

  if (toneMode === TONE_PLUCK) {
    const { buffer, playbackRate } = getPluckBuffer(midi);
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = playbackRate;

    // 3) 쨍한 고음 차단 (저역 통과 2단 = 옥타브당 -24dB) + 몸통 공명
    const cutoff = pluckCutoff(freq);
    const lp1 = ctx.createBiquadFilter();
    const lp2 = ctx.createBiquadFilter();
    [lp1, lp2].forEach((lp) => { lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 0; });
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 110;
    body.Q.value = 1.2;
    body.gain.value = 4;
    lp1.connect(lp2);
    lp2.connect(body);
    body.connect(gainNode);
    head = lp1;

    // 감쇠는 버퍼에 들어 있으므로, 음 길이가 끝나면 줄을 손으로 막듯 빠르게 줄임
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(peak, startTime + PLUCK_ATTACK_SEC);
    gainNode.gain.setValueAtTime(peak, startTime + durationInSeconds);
    gainNode.gain.exponentialRampToValueAtTime(0.001, endTime);
  } else {
    src = ctx.createOscillator();
    src.type = 'triangle';
    src.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    head = gainNode;

    // 치는 순간 커지고 서서히 줄어듦
    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(peak, startTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.001, endTime);
  }

  src.connect(head);
  connectOut(gainNode, src, bus, toneMode !== TONE_PLUCK); // EQ는 기타음에만
  src.start(startTime);
  src.stop(endTime);

  return { src, gain: gainNode.gain, endTime };
};

// 같은 줄에서 새 음이 나올 때 앞 음을 time 시점에 짧게 페이드아웃해서 끊음
export const releaseVoice = (voice, time) => {
  if (!voice || time >= voice.endTime) return;
  const g = voice.gain;
  if (typeof g.cancelAndHoldAtTime === 'function') {
    g.cancelAndHoldAtTime(time);
  } else {
    g.cancelScheduledValues(time);
  }
  g.setTargetAtTime(0, time, CUT_FADE_SEC / 3);
  try { voice.src.stop(time + CUT_FADE_SEC * 4); } catch { /* 이미 끝난 소리 */ }
  voice.endTime = time;
};

// 화이트 노이즈와 대역통과 필터를 이용한 퍼커시브(챱챱) 소리 합성
export const playPercussiveMute = (startTime, bus = null) => {
  const ctx = getAudioCtx();

  // 1. 0.05초 길이의 노이즈(백색 소음) 버퍼 생성
  const bufferSize = ctx.sampleRate * 0.05;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  const noise = ctx.createBufferSource();
  noise.buffer = buffer;

  // 2. 대역통과 필터(Bandpass)로 기타 줄 때리는 대역의 소리만 남김
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1200;
  filter.Q.value = 1;

  // 3. 엔벨롭 (아주 짧고 강하게 끊어침)
  const gainNode = ctx.createGain();
  gainNode.gain.setValueAtTime(0.8, startTime);
  gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.04);

  noise.connect(filter);
  filter.connect(gainNode);
  connectOut(gainNode, noise, bus, true);

  noise.start(startTime);
};

// 메트로놈 띡/딱 사운드 합성 (bus: 재생 버스, 없으면 바로 출력)
export const playMetronomeClick = (time, isAccent, bus = null) => {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.value = isAccent ? 1200 : 800;

  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(METRONOME_GAIN, time + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

  osc.connect(gain);
  connectOut(gain, osc, bus, true);
  osc.start(time);
  osc.stop(time + 0.06);
};
