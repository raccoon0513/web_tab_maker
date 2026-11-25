// 악보 데이터 모델과 시간 계산 유틸리티
//
// 시간 단위: 정수 틱(tick). 4분음표 = TPQ(48)틱.
//   48은 2, 3, 4, 8, 16으로 나누어떨어져서 16분음표(12), 8분 셋잇단(16),
//   32분음표(6)까지 모두 정수로 표현된다. 부동소수 오차 보정이 필요 없다.
//
// 데이터 구조 (version 3)
//   저장 형식: { version: 3, bpm, measures: Measure[], instrument?, source? }
//     - instrument: 'guitar' | 'piano'. 없으면 기타 (예전 파일은 모두 기타)
//     - source: MIDI에서 가져온 원곡 (구조는 midiImport.js 참고). 악보와 따로 보관
//   Measure  : { id, timeSig: { num, den }, beats: Beat[] }
//   Beat     : { time, duration, notes: Note[], tieId? }
//     - time, duration: 틱 단위. time은 마디 안에서의 위치.
//   Note     : { pitch, string?, sustain? }  또는 뮤트 { string, mute: true }
//     - pitch: 음높이(MIDI 번호, 60 = C4). 악기와 상관없는 "음악" 정보
//     - string: 기타에서 칠 줄 (1 = 가장 가는 줄). 프렛은 저장하지 않고 guitar.js에서 계산
//         피아노에서 넣은 음은 줄이 없음. 기타로 바꿀 때 배치하고, 칠 수 없는 음은 줄 없이 남음
//         (피아노로 바꿔도 줄은 지우지 않으므로 다시 기타로 돌아오면 TAB이 그대로)
//     - sustain: 이 음만 실제로 울리는 길이(틱). 없으면 비트의 duration
//
// 이전 형식은 불러올 때 차례로 변환한다: v1(박 단위 소수) → v2(줄: 프렛) → v3(음높이)
//
// 마지막 마디 뒤의 시간은 "마지막 마디의 박자표가 계속된다"고 가정해서 계산한다.
// ensureMeasures로 마디를 늘릴 때도 같은 규칙을 쓰므로 두 계산이 항상 일치한다.

export const TPQ = 48;
import { STANDARD_TUNING } from './guitar.js';

export const SCORE_VERSION = 3;
export const INSTRUMENTS = ['guitar', 'piano'];
export const DEFAULT_TIME_SIG = Object.freeze({ num: 4, den: 4 });

// 입력 길이 단계: 16분, 8분, 4분, 2분, 온음표
export const DURATION_STEPS = [TPQ / 4, TPQ / 2, TPQ, TPQ * 2, TPQ * 4];
export const TIME_SIG_DENOMINATORS = [2, 4, 8, 16];
export const MAX_TIME_SIG_NUM = 16;

// --- 박자표 / 마디 길이 ---

export const getTimeSig = (measure) => (measure && measure.timeSig) || DEFAULT_TIME_SIG;

export const timeSigLength = ({ num, den }) => Math.round((num * TPQ * 4) / den);

// 박자표의 한 박(분모 음표) 길이. 6/8이면 8분음표 = 24틱
export const beatUnitTicks = ({ den }) => (TPQ * 4) / den;

export const measureLength = (measure) => timeSigLength(getTimeSig(measure));

const lastTimeSig = (score) => getTimeSig(score[score.length - 1]);

// 존재하지 않는 마디(악보 끝 이후)도 마지막 박자표로 계산
export const timeSigAt = (score, mIndex) =>
  mIndex < score.length ? getTimeSig(score[mIndex]) : lastTimeSig(score);

export const measureLengthAt = (score, mIndex) => timeSigLength(timeSigAt(score, mIndex));

export const sameTimeSig = (a, b) => a.num === b.num && a.den === b.den;

// --- 생성 / 복제 ---

export const makeMeasure = (id, timeSig = DEFAULT_TIME_SIG) => ({
  id,
  timeSig: { num: timeSig.num, den: timeSig.den },
  beats: [],
});

export const createEmptyScore = () => [makeMeasure(1)];

export const cloneScore = (score) => JSON.parse(JSON.stringify(score));

// score를 직접 수정한다 (cloneScore한 사본에만 사용할 것)
export const ensureMeasures = (score, mIndex) => {
  while (score.length <= mIndex) {
    score.push(makeMeasure(score.length + 1, lastTimeSig(score)));
  }
  return score;
};

// --- 절대 시간 <-> (마디, 마디 내 위치) 변환 ---

// starts[i] = i번째 마디의 시작 절대 틱. 길이는 score.length + 1 (마지막 값 = 전체 길이)
export const buildMeasureStarts = (score) => {
  const starts = [0];
  score.forEach((m) => starts.push(starts[starts.length - 1] + measureLength(m)));
  return starts;
};

export const measureStart = (score, mIndex) => {
  let abs = 0;
  const n = Math.min(mIndex, score.length);
  for (let i = 0; i < n; i++) abs += measureLength(score[i]);
  if (mIndex > score.length) {
    abs += (mIndex - score.length) * timeSigLength(lastTimeSig(score));
  }
  return abs;
};

export const toAbs = (score, mIndex, time) => measureStart(score, mIndex) + time;

export const fromAbs = (score, abs) => {
  let rest = Math.max(0, abs);
  for (let i = 0; i < score.length; i++) {
    const len = measureLength(score[i]);
    if (rest < len) return { mIndex: i, time: rest };
    rest -= len;
  }
  const len = timeSigLength(lastTimeSig(score));
  const k = Math.floor(rest / len);
  return { mIndex: score.length + k, time: rest - k * len };
};

// 커서를 delta 틱만큼 이동 (음수 가능, 0 미만은 0으로 고정)
export const moveCursor = (score, cursor, delta) =>
  fromAbs(score, Math.max(0, toAbs(score, cursor.mIndex, cursor.time) + delta));

// [startAbs, startAbs + duration) 구간을 마디 경계에서 자른다.
// score를 직접 수정해 필요한 마디를 만든다 (cloneScore한 사본에만 사용할 것)
export const splitSpanByMeasures = (score, startAbs, duration) => {
  const segments = [];
  let abs = startAbs;
  let remaining = duration;
  while (remaining > 0) {
    const pos = fromAbs(score, abs);
    ensureMeasures(score, pos.mIndex);
    const part = Math.min(remaining, measureLength(score[pos.mIndex]) - pos.time);
    segments.push({ mIndex: pos.mIndex, time: pos.time, duration: part });
    abs += part;
    remaining -= part;
  }
  return segments;
};

// --- 저장 / 불러오기 ---

const normalizeMeasures = (measures) =>
  measures.map((m, i) => ({
    ...m,
    id: i + 1,
    timeSig: m.timeSig ? { num: m.timeSig.num, den: m.timeSig.den } : { ...DEFAULT_TIME_SIG },
    beats: (Array.isArray(m.beats) ? m.beats : []).map((b) => ({ ...b, notes: Array.isArray(b.notes) ? b.notes : [] })),
  }));

// v1(박 단위 소수, 4/4 고정, 마디 배열) -> v2
const migrateV1 = (measures) =>
  measures.map((m) => ({
    ...m,
    timeSig: { ...DEFAULT_TIME_SIG },
    beats: (m.beats || []).map((b) => ({
      ...b,
      time: Math.round(b.time * TPQ),
      duration: Math.round(b.duration * TPQ),
    })),
  }));

// v2(notes: { 줄: 프렛 | 'X' }, sustain: { 줄: 틱 }) -> v3(notes: 음높이 기준 배열)
// v2는 스탠다드 튜닝 기타 악보였으므로 그 튜닝으로 음높이를 계산
const migrateV2 = (measures) =>
  measures.map((m) => ({
    ...m,
    beats: (m.beats || []).map((b) => {
      const { sustain, notes = {}, ...rest } = b;
      return {
        ...rest,
        notes: Object.entries(notes).map(([str, fret]) => {
          const string = parseInt(str, 10);
          if (fret === 'X') return { string, mute: true };
          const note = { pitch: STANDARD_TUNING[string] + fret, string };
          if (sustain && sustain[str]) note.sustain = sustain[str];
          return note;
        }),
      };
    }),
  }));

// 저장된 원곡이 쓸 수 있는 모양인지
export const isValidSource = (s) =>
  !!s && typeof s === 'object' && Array.isArray(s.tracks) && s.tracks.every((t) => t && Array.isArray(t.notes))
  && Array.isArray(s.tempos) && Array.isArray(s.timeSignatures);

// 캐시나 JSON 파일에서 읽은 데이터를 현재 형식으로 변환.
// 반환: { measures, bpm(없으면 null), source(없으면 null) } / 알 수 없는 형식이면 null
export const loadScoreData = (raw) => {
  let measures;
  let bpm = null;

  if (Array.isArray(raw)) {
    measures = migrateV2(migrateV1(raw));
  } else if (raw && raw.version === 2 && Array.isArray(raw.measures)) {
    measures = migrateV2(raw.measures);
  } else if (raw && raw.version === SCORE_VERSION && Array.isArray(raw.measures)) {
    measures = raw.measures;
  } else {
    return null;
  }
  if (raw && typeof raw.bpm === 'number' && raw.bpm > 0) bpm = raw.bpm;

  measures = normalizeMeasures(measures);
  if (measures.length === 0) measures = createEmptyScore();
  const source = raw && isValidSource(raw.source) ? raw.source : null;
  const instrument = raw && INSTRUMENTS.includes(raw.instrument) ? raw.instrument : 'guitar';
  return { measures, bpm, source, instrument };
};

export const serializeScore = (measures, bpm, source = null, instrument = 'guitar') => {
  const data = { version: SCORE_VERSION, bpm, measures };
  if (instrument !== 'guitar') data.instrument = instrument;
  if (source) data.source = source;
  return data;
};

// --- 표시용 ---

export const formatBeats = (ticks) => {
  const beats = ticks / TPQ;
  return Number.isInteger(beats) ? String(beats) : String(Math.round(beats * 1000) / 1000);
};
