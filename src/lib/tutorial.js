// 피아노 튜토리얼(떨어지는 막대) 화면을 위한 계산
//
// 튜토는 악보를 보여준다 (기타 악보든 나중의 피아노 악보든 건반으로).
// 악보는 tick 단위라, 소리와 화면을 초 단위로 맞추기 위해 "타임라인"을 한 번 만들어 두고
// 그리기·재생 모두 이것을 쓴다.
//
// 타임라인 구조
//   { notes: [{ pitch, start, end, velocity }],   // start 순 정렬, 단위 초
//     duration, maxNoteLength, lowest, highest,
//     measures: [{ number, time }] }              // 마디 시작 시각 (가로 눈금용)
//   - 붙임줄로 이어진 음은 막대 하나로 합침 (실제로 한 번만 침)
//   - 화음 중 일부 음만 길게 끄는 경우(sustain)는 그 음만 길게
//   - 뮤트(X)는 음 높이가 없으므로 뺌

import { TPQ, buildMeasureStarts } from './scoreModel.js';

export const MIDDLE_C = 60;
export const PIANO_LOWEST = 21;  // A0
export const PIANO_HIGHEST = 108; // C8
const DEFAULT_VELOCITY = 96;

export const buildScoreTimeline = (score, bpm) => {
  const secPerTick = 60 / bpm / TPQ;
  const starts = buildMeasureStarts(score);

  // 붙임줄 묶음: 첫 조각 위치와 전체 길이
  const ties = {};
  score.forEach((m, mi) => m.beats.forEach((b) => {
    if (!b.tieId) return;
    const abs = starts[mi] + b.time;
    const g = ties[b.tieId] || (ties[b.tieId] = { first: abs, total: 0 });
    g.first = Math.min(g.first, abs);
    g.total += b.duration;
  }));

  const notes = [];
  score.forEach((m, mi) => m.beats.forEach((b) => {
    const abs = starts[mi] + b.time;
    let ticks = b.duration;
    if (b.tieId) {
      const g = ties[b.tieId];
      if (abs !== g.first) return; // 뒤 조각: 앞 조각 막대에 이미 포함
      ticks = g.total;
    }
    b.notes.forEach((n) => {
      if (n.mute) return;
      const start = abs * secPerTick;
      notes.push({ pitch: n.pitch, start, end: start + (n.sustain || ticks) * secPerTick, velocity: DEFAULT_VELOCITY });
    });
  }));
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);

  let lowest = Infinity;
  let highest = -Infinity;
  let duration = 0;
  let maxNoteLength = 0;
  notes.forEach((n) => {
    lowest = Math.min(lowest, n.pitch);
    highest = Math.max(highest, n.pitch);
    duration = Math.max(duration, n.end);
    maxNoteLength = Math.max(maxNoteLength, n.end - n.start);
  });

  return {
    notes, duration, maxNoteLength,
    lowest: notes.length ? lowest : MIDDLE_C, highest: notes.length ? highest : MIDDLE_C,
    measures: score.map((_, i) => ({ number: i + 1, time: starts[i] * secPerTick })),
  };
};

// 마디 번호(0부터) → 그 마디 시작 시각(초)
export const measureTime = (timeline, mIndex) => {
  const m = timeline.measures[Math.min(mIndex, timeline.measures.length - 1)];
  return m ? m.time : 0;
};

// --- 건반 ---

// 반음 12개 중 검은 건반
const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlackKey = (pitch) => BLACK.has(((pitch % 12) + 12) % 12);

// 보여줄 건반 범위: 곡에서 쓰는 음 + 양쪽 여유, 끝은 흰 건반, 최소 2옥타브
export const MIN_KEY_SPAN = 25;
export const keyRange = (lowest, highest, margin = 2) => {
  let lo = Math.max(PIANO_LOWEST, lowest - margin);
  let hi = Math.min(PIANO_HIGHEST, highest + margin);
  // 너무 좁으면 가운데를 기준으로 넓힘
  while (hi - lo + 1 < MIN_KEY_SPAN) {
    if (lo > PIANO_LOWEST) lo -= 1;
    if (hi - lo + 1 < MIN_KEY_SPAN && hi < PIANO_HIGHEST) hi += 1;
    if (lo === PIANO_LOWEST && hi === PIANO_HIGHEST) break;
  }
  while (isBlackKey(lo)) lo -= 1;
  while (isBlackKey(hi)) hi += 1;
  return { lo, hi };
};

// 건반 배치: 흰 건반은 같은 폭으로 나란히, 검은 건반은 두 흰 건반 경계에 걸침
//   반환: { whiteWidth, keys: { [pitch]: { x, w, black } } }
export const BLACK_KEY_RATIO = 0.6;
export const layoutKeys = ({ lo, hi }, width) => {
  let whiteCount = 0;
  for (let p = lo; p <= hi; p += 1) if (!isBlackKey(p)) whiteCount += 1;
  const whiteWidth = width / whiteCount;
  const blackWidth = whiteWidth * BLACK_KEY_RATIO;
  const keys = {};
  let wi = 0;
  for (let p = lo; p <= hi; p += 1) {
    if (isBlackKey(p)) {
      keys[p] = { x: wi * whiteWidth - blackWidth / 2, w: blackWidth, black: true };
    } else {
      keys[p] = { x: wi * whiteWidth, w: whiteWidth, black: false };
      wi += 1;
    }
  }
  return { whiteWidth, keys };
};

// 화면에 걸친 음만 고르기: notes는 start 순 정렬
//   [from, to] 구간과 겹치는 음. 긴 음도 놓치지 않도록 maxNoteLength만큼 앞에서부터 훑음
export const notesInWindow = (timeline, from, to) => {
  const { notes, maxNoteLength } = timeline;
  const firstStart = from - maxNoteLength;
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].start < firstStart) lo = mid + 1; else hi = mid;
  }
  const out = [];
  for (let i = lo; i < notes.length && notes[i].start <= to; i += 1) {
    if (notes[i].end > from) out.push(notes[i]);
  }
  return out;
};

// 초 → '1:05'
export const formatClock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// 시각 → 몇 번째 마디인지 (1부터)
export const measureAt = (timeline, time) => {
  const ms = timeline.measures;
  let lo = 0;
  let hi = ms.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ms[mid].time <= time + 1e-6) lo = mid; else hi = mid - 1;
  }
  return ms[lo].number;
};
