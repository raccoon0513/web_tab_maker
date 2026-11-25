// 악보 그리기 (VexFlow): 기타 악보 데이터 → 오선보 / TAB
//
// 오선보는 두 가지 (notation 옵션)
//   - 높은음 (grand: false): 기타 관례대로 높은음자리표 하나, 실제 소리보다 한 옥타브 높게 (음자리표 아래 8)
//   - 큰보표 (grand: true): 피아노 악보처럼 높은음자리표 + 낮은음자리표, 실제 소리 높이 그대로.
//       split 음 이상은 위 줄, 미만은 아래 줄. 한쪽 줄에 음이 없는 칸은 그 줄에 쉼표
//   markUnplaced: 기타 악보에서 줄이 없는 음(기타로 칠 수 없음)을 빨간색으로. TAB에는 숫자가 없음
//
// 하는 일
//   1) 마디마다 비트를 "음표 칸"으로 바꿈: 빈 구간은 쉼표, 한 기호로 못 쓰는 길이는 붙임줄로 나눔
//   2) VexFlow 음표를 만들어 마디의 최소 폭을 재고, 마디를 통째로 줄에 채움 (줄 폭에 맞게 늘림)
//   3) 화면에 그리는 함수와, 편집에 필요한 좌표(음표 x, 줄 y, 시간 ↔ x)를 함께 돌려줌
//
// React를 모르는 모듈이다. 그리는 시점(어느 SVG에 그릴지)은 화면 쪽(ScoreView)이 정한다.

import {
  Stave, TabStave, StaveNote, TabNote, GhostNote, Voice, Formatter, Accidental, Beam, StaveTie, Dot, StaveConnector,
} from 'vexflow/bravura';
import { TPQ, measureLength, getTimeSig, sameTimeSig } from './scoreModel.js';
import { STANDARD_TUNING, fretOf, noteId } from './guitar.js';

export const VIEW_STAFF = 'staff';
export const VIEW_BOTH = 'both';
export const VIEW_TAB = 'tab';

// 오선보 종류 기본값: 높은음(기타 관례), 큰보표일 때 나누는 음은 가운데 도(C4)
export const DEFAULT_NOTATION = Object.freeze({ grand: false, split: 60, markUnplaced: true });

// 한 기호로 쓸 수 있는 길이 (긴 것부터). 이보다 복잡한 길이는 여러 개를 붙임줄로 이음
const NOTE_VALUES = [
  { ticks: TPQ * 6, code: 'w', dots: 1 },
  { ticks: TPQ * 4, code: 'w', dots: 0 },
  { ticks: TPQ * 3, code: 'h', dots: 1 },
  { ticks: TPQ * 2, code: 'h', dots: 0 },
  { ticks: TPQ * 1.5, code: 'q', dots: 1 },
  { ticks: TPQ, code: 'q', dots: 0 },
  { ticks: TPQ * 0.75, code: '8', dots: 1 },
  { ticks: TPQ / 2, code: '8', dots: 0 },
  { ticks: TPQ * 0.375, code: '16', dots: 1 },
  { ticks: TPQ / 4, code: '16', dots: 0 },
  { ticks: TPQ * 0.1875, code: '32', dots: 1 },
  { ticks: TPQ / 8, code: '32', dots: 0 },
  { ticks: TPQ / 16, code: '64', dots: 0 },
];

// 길이를 기호 여러 개로 나눔 (큰 것부터). 가장 작은 단위보다 짧은 나머지는 앞 조각에 붙임
export const splitDuration = (ticks) => {
  const parts = [];
  let rest = ticks;
  while (rest >= NOTE_VALUES.at(-1).ticks) {
    const v = NOTE_VALUES.find((nv) => nv.ticks <= rest);
    parts.push(v);
    rest -= v.ticks;
  }
  if (parts.length === 0) parts.push(NOTE_VALUES.at(-1));
  return parts;
};

// 마디 안의 칸: 비트(음)와 빈 구간(쉼표)을 시간순으로. 다음 비트와 겹치거나 마디를 넘는 길이는 잘라서 표시
export const measureEvents = (measure) => {
  const len = measureLength(measure);
  const beats = measure.beats.filter((b) => b.notes.length > 0 && b.time < len).sort((a, b) => a.time - b.time);
  const events = [];
  let t = 0;
  beats.forEach((beat, i) => {
    if (beat.time > t) events.push({ kind: 'rest', time: t, ticks: beat.time - t });
    const next = i + 1 < beats.length ? beats.at(i + 1).time : len;
    const end = Math.min(beat.time + beat.duration, next, len);
    events.push({ kind: 'note', time: beat.time, ticks: Math.max(end - beat.time, 1), beat });
    t = Math.max(t, end);
  });
  if (t < len) events.push({ kind: 'rest', time: t, ticks: len - t });
  return events;
};

// --- 음높이 → 오선보 위치 ---

const SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const LETTER_INDEX = { c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6 };

// 60 → 'c/4' (조표 없이 #으로)
const vexKey = (pitch) => `${SHARP_NAMES.at(pitch % 12)}/${Math.floor(pitch / 12) - 1}`;

// 60 → 'C4' (나누는 음 선택 목록용)
export const pitchLabel = (pitch) => `${SHARP_NAMES.at(pitch % 12).toUpperCase()}${Math.floor(pitch / 12) - 1}`;

// VexFlow 줄 번호 (높은음자리표 기준): 가온 C(c/4) = 0, 한 음(도레미)마다 0.5. 맨 아래 줄 E4 = 1, 맨 위 줄 F5 = 5
const staffLine = (pitch) => {
  const octave = Math.floor(pitch / 12) - 1;
  const letter = LETTER_INDEX[SHARP_NAMES.at(pitch % 12).charAt(0)];
  return (octave * 7 + letter - 4 * 7) / 2;
};

// 음의 실제 높이. 뮤트(음높이 없음)는 그 줄의 개방현 높이에 X 머리로 표시
const soundingPitch = (note) => (note.mute ? STANDARD_TUNING[note.string] : note.pitch);

// 오선 하나의 성질
//   accepts: 이 오선에 올 음인지 / written: 적는 높이 / lineShift: 낮은음자리표는 같은 이름 음이 6줄(3칸) 위
//   rest, wholeRest: 쉼표를 둘 자리 (가운데 줄 / 온쉼표는 넷째 줄에 매달림)
const staffSpecs = (notation) => (notation.grand
  ? [
    { id: 'upper', clef: 'treble', accepts: (p) => p >= notation.split, written: (p) => p, lineShift: 0, rest: 'b/4', wholeRest: 'd/5' },
    { id: 'lower', clef: 'bass', accepts: (p) => p < notation.split, written: (p) => p, lineShift: 6, rest: 'd/3', wholeRest: 'f/3' },
  ]
  : [
    // 기타 악보는 실제 소리보다 한 옥타브 높게 적음 (높은음자리표 아래 8)
    { id: 'upper', clef: 'treble', annotation: '8vb', accepts: () => true, written: (p) => p + 12, lineShift: 0, rest: 'b/4', wholeRest: 'd/5' },
  ]);

// --- 크기 ---

export const LINE_WIDTH = 1200;          // 한 줄 폭 (px)
const MIN_MEASURE_WIDTH = 90;
const MEASURE_PADDING = 28;              // 음표 양옆 여백
const SPACING_FACTOR = 1.35;             // 최소 폭에 곱해 숨 쉴 틈을 줌
const STAFF_TOP = 10;                    // 오선 위쪽 여유 (덧줄, 마디 번호)
const STAFF_TO_TAB = 96;                 // 오선 맨 위 줄에서 TAB 스테이브 시작까지
const GRAND_GAP = 84;                    // 큰보표: 위 오선 맨 위 줄에서 아래 오선 맨 위 줄까지
const BOTTOM_ROOM = 16;
const TAB_STEM_ROOM = 34;                // TAB만 볼 때 아래로 내리는 기둥 자리

// --- 한 마디를 VexFlow 음표로 ---

const buildMeasure = (measure, mIndex, view, tieInfo, notation) => {
  const showStaff = view !== VIEW_TAB;
  const showTab = view !== VIEW_STAFF;
  const ts = getTimeSig(measure);
  const events = measureEvents(measure);
  const specs = showStaff ? staffSpecs(notation) : [];

  // 오선마다 따로: 음표, 마디 안 붙임줄, 다음/앞 마디와 잇는 붙임줄
  const staffs = specs.map((spec) => ({ spec, notes: [], ties: [], tieStarts: [], tieEnds: [], unplaced: [] }));
  const tabNotes = [];
  const eventGeom = [];

  // 통째로 빈 마디는 박자와 상관없이 온쉼표 하나 (악보 관례)
  const wholeMeasureRest = events.length === 1 && events[0].kind === 'rest';

  events.forEach((ev) => {
    const parts = wholeMeasureRest ? [{ ticks: ev.ticks, code: 'w', dots: 0 }] : splitDuration(ev.ticks);
    const tie = ev.kind === 'note' && ev.beat.tieId ? tieInfo[`${mIndex}-${ev.time}`] : null;
    const isContinuation = !!(tie && tie.hasPrev);
    const notes = ev.kind === 'note' ? [...ev.beat.notes].sort((a, b) => soundingPitch(a) - soundingPitch(b)) : [];

    // 이 칸에서 오선마다 맡을 음 (없으면 그 오선은 쉼표)
    const perStaff = staffs.map((st) => {
      const mine = notes.filter((n) => st.spec.accepts(soundingPitch(n)));
      return { st, mine, keys: mine.map((n) => vexKey(st.spec.written(soundingPitch(n))) + (n.mute ? '/x2' : '')), first: null, prev: null };
    });

    parts.forEach((part, pi) => {
      perStaff.forEach((ps) => {
        const { spec } = ps.st;
        const rest = ps.mine.length === 0;
        const note = rest
          ? new StaveNote({ clef: spec.clef, keys: [wholeMeasureRest ? spec.wholeRest : spec.rest], duration: `${part.code}r`, dots: part.dots, alignCenter: wholeMeasureRest })
          : new StaveNote({ clef: spec.clef, keys: ps.keys, duration: part.code, dots: part.dots, autoStem: true });
        if (part.dots) Dot.buildAndAttach([note], { all: true });
        // 기타로 칠 수 없는 음: 그릴 때 빨간색으로 (색은 테마에서 읽어야 하므로 draw에서 칠함)
        if (!rest && notation.markUnplaced) {
          ps.mine.forEach((n, k) => { if (n.string == null) ps.st.unplaced.push({ note, index: k }); });
        }
        ps.st.notes.push(note);
        if (ps.prev && !rest) {
          const idx = ps.keys.map((_, k) => k);
          ps.st.ties.push({ firstNote: ps.prev, lastNote: note, firstIndexes: idx, lastIndexes: idx });
        }
        if (pi === 0) ps.first = note;
        ps.prev = note;
      });
      if (showTab) {
        let tabNote;
        const placed = notes.filter((n) => n.string != null);
        if (placed.length === 0) {
          // 쉼표, 또는 줄에 놓인 음이 하나도 없는 칸 (TAB에는 빈자리)
          tabNote = new GhostNote({ duration: part.code, dots: part.dots });
        } else {
          tabNote = new TabNote({
            positions: placed.map((n) => ({ str: n.string, fret: fretOf(n) })),
            duration: part.code,
            dots: part.dots,
          }, view === VIEW_TAB);
          // 붙임줄로 이어진 뒷부분은 괄호로 (이미 친 음)
          if (pi > 0 || isContinuation) tabNote.setGhost(true);
        }
        tabNotes.push(tabNote);
      }
    });

    // 편집용: 칸의 첫 조각. 음마다 어느 오선에 있는지 기억 (좌표 계산용)
    const noteStaff = notes.map((n) => staffs.findIndex((st) => st.spec.accepts(soundingPitch(n))));
    const staffNoteForX = (perStaff.find((ps) => ps.mine.length > 0) || perStaff[0])?.first || null;
    eventGeom.push({ time: ev.time, kind: ev.kind, notes, noteStaff, staffNote: staffNoteForX, tabNote: showTab ? tabNotes.at(tabNotes.length - parts.length) : null });

    if (tie && ev.kind === 'note') {
      perStaff.forEach((ps) => {
        if (ps.mine.length === 0) return;
        const idx = ps.keys.map((_, k) => k);
        if (tie.hasNext) ps.st.tieStarts.push({ tieId: ev.beat.tieId, note: ps.prev, indexes: idx });
        if (tie.hasPrev) ps.st.tieEnds.push({ tieId: ev.beat.tieId, note: ps.first, indexes: idx });
      });
    }
  });

  const makeVoice = (tickables) => new Voice({ numBeats: ts.num, beatValue: ts.den }).setMode(Voice.Mode.SOFT).addTickables(tickables);
  const beamGroups = Beam.getDefaultBeamGroups(`${ts.num}/${ts.den}`);
  staffs.forEach((st) => {
    st.voice = makeVoice(st.notes);
    Accidental.applyAccidentals([st.voice], 'C');
    st.beams = Beam.generateBeams(st.notes, { groups: beamGroups });
  });
  const tabVoice = showTab ? makeVoice(tabNotes) : null;
  const tabBeams = view === VIEW_TAB
    ? Beam.generateBeams(tabNotes.filter((n) => n instanceof TabNote), { groups: beamGroups, stemDirection: -1 })
    : [];

  const voices = [...staffs.map((st) => st.voice), tabVoice].filter(Boolean);
  const formatter = new Formatter();
  voices.forEach((v) => formatter.joinVoices([v]));
  const minWidth = formatter.preCalculateMinTotalWidth(voices);

  return {
    mIndex, measure, ts, events, eventGeom, staffs, tabVoice, voices, formatter, tabBeams, minWidth,
  };
};

// 줄 머리 장식(음자리표, TAB 표시, 박자표)이 차지하는 폭
const headerWidth = (view, withTimeSig, ts, notation) => {
  const probe = (s) => s.getNoteStartX() - s.getX();
  let w = 0;
  if (view !== VIEW_TAB) {
    staffSpecs(notation).forEach((spec) => {
      const s = new Stave(0, 0, 500).addClef(spec.clef, 'default', spec.annotation);
      if (withTimeSig) s.addTimeSignature(`${ts.num}/${ts.den}`);
      w = Math.max(w, probe(s));
    });
  }
  if (view !== VIEW_STAFF) {
    const t = new TabStave(0, 0, 500).addTabGlyph();
    if (withTimeSig) t.addTimeSignature(`${ts.num}/${ts.den}`);
    w = Math.max(w, probe(t));
  }
  return w;
};

// 마디 중간에 박자가 바뀔 때 (줄 머리가 아닌 곳) 박자표가 차지하는 폭
const timeSigWidth = (view, ts) => {
  const s = view === VIEW_TAB ? new TabStave(0, 0, 500) : new Stave(0, 0, 500);
  const before = s.getNoteStartX();
  s.addTimeSignature(`${ts.num}/${ts.den}`);
  return s.getNoteStartX() - before;
};

// --- 전체 악보 ---
// tieInfo: { 'mIndex-time': { hasPrev, hasNext } } (붙임줄 조각의 앞뒤)
// 반환: { lines: [{ width, height, measures: [...], draw(ctx, colors) }] }
//
// 빠르게 다시 그리기: 편집 한 번은 보통 한 줄만 바꾼다. 그래서
//   - 마디 내용이 같으면 최소 폭을 다시 계산하지 않고 (widthCache)
//   - 줄에 들어간 마디들이 모두 같으면 그 줄을 통째로 재사용한다 (lineCache).
//   재사용된 줄은 같은 객체이므로 화면(ScoreView)도 그 줄은 다시 그리지 않는다.
const WIDTH_CACHE_LIMIT = 4000;
const widthCache = new Map();   // 마디 키 → 최소 폭
let lineCache = new Map();      // 줄 키 → 줄 (직전 engrave 결과만 보관)

// 마디 그림을 결정하는 모든 것: 보기, 위치, 내용, 붙임줄 앞뒤, 앞 마디와 박자가 다른지
const measureKey = (measure, mIndex, view, tieInfo, showSig, notation) => {
  const ties = measure.beats.filter((b) => b.tieId).map((b) => {
    const t = tieInfo[`${mIndex}-${b.time}`];
    return t ? `${b.time}:${t.hasPrev ? 1 : 0}${t.hasNext ? 1 : 0}` : '';
  }).join(',');
  const mode = `${notation.grand ? `g${notation.split}` : 't'}${notation.markUnplaced ? 'u' : ''}`;
  return `${view}|${mode}|${mIndex}|${showSig ? 1 : 0}|${JSON.stringify(measure.timeSig)}|${JSON.stringify(measure.beats)}|${ties}`;
};

// theme: 테마가 바뀌면 줄을 새로 만들어 다시 그림 (한 번 그린 VexFlow 객체를 다른 색으로 또 그리지 않도록)
// notation: { grand, split } (오선보 종류, 위 DEFAULT_NOTATION 참고)
export const engrave = (score, view, tieInfo, theme = '', notation = DEFAULT_NOTATION, lineWidth = LINE_WIDTH) => {
  const sigs = score.map((m) => getTimeSig(m));
  const showSigs = sigs.map((ts, i) => i === 0 || !sameTimeSig(ts, sigs.at(i - 1)));
  const keys = score.map((m, i) => measureKey(m, i, view, tieInfo, showSigs.at(i), notation));

  // 이번에 새로 만든 마디 (폭 계산 때 만든 것을 그리기에서 그대로 씀)
  const fresh = new Map();
  const build = (i) => {
    if (!fresh.has(i)) fresh.set(i, buildMeasure(score.at(i), i, view, tieInfo, notation));
    return fresh.get(i);
  };

  // 마디마다 자연 폭 (줄 머리 장식 제외)
  if (widthCache.size > WIDTH_CACHE_LIMIT) widthCache.clear();
  const natural = score.map((m, i) => {
    let minWidth = widthCache.get(keys.at(i));
    if (minWidth === undefined) {
      minWidth = build(i).minWidth;
      widthCache.set(keys.at(i), minWidth);
    }
    const extra = i > 0 && showSigs.at(i) ? timeSigWidth(view, sigs.at(i)) : 0;
    return Math.max(MIN_MEASURE_WIDTH, minWidth * SPACING_FACTOR + MEASURE_PADDING) + extra;
  });

  // 마디를 통째로 줄에 채움
  const rows = [];
  let row = [];
  let used = 0;
  score.forEach((_, i) => {
    const first = row.length === 0;
    const head = first ? headerWidth(view, showSigs.at(i), sigs.at(i), notation) : 0;
    const w = natural.at(i) + head;
    if (!first && used + w > lineWidth) {
      rows.push(row);
      const head2 = headerWidth(view, showSigs.at(i), sigs.at(i), notation);
      row = [{ i, w: natural.at(i) + head2 }];
      used = natural.at(i) + head2;
      return;
    }
    row.push({ i, w });
    used += w;
  });
  if (row.length) rows.push(row);

  const showStaff = view !== VIEW_TAB;
  const showTab = view !== VIEW_STAFF;
  const specs = showStaff ? staffSpecs(notation) : [];
  const staffY = STAFF_TOP;
  // 오선마다 맨 위 줄 y (큰보표는 두 개)
  const staffYs = specs.map((_, k) => STAFF_TOP + k * GRAND_GAP);
  const tabY = showStaff ? staffYs.at(-1) + STAFF_TO_TAB : STAFF_TOP;

  const nextCache = new Map();
  const lines = rows.map((items, lineIndex) => {
    const total = items.reduce((s, it) => s + it.w, 0);
    const isLast = lineIndex === rows.length - 1;
    // 줄 폭에 맞게 늘림 (마지막 줄은 너무 듬성해지지 않게 절반 이상 찼을 때만)
    const stretch = !isLast || total > lineWidth * 0.5 ? lineWidth / total : 1;

    const lineKey = `${theme}|${lineWidth}|${stretch}|${items.map((it) => keys.at(it.i)).join('\n')}`;
    const cached = lineCache.get(lineKey);
    if (cached) {
      nextCache.set(lineKey, cached);
      return cached;
    }

    // 붙임줄: 줄 안에서 시작과 끝이 다 있으면 온전히, 줄을 넘으면 반쪽씩 그림
    const openTies = {}; // tieId → { note, indexes }
    let x = 0;
    const lineTies = [];
    const measures = items.map((it, k) => {
      const b = build(it.i);
      const width = it.w * stretch;
      const firstInLine = k === 0;
      const showSig = showSigs.at(it.i);
      const sig = `${b.ts.num}/${b.ts.den}`;

      const staves = specs.map((spec, k) => {
        const st = new Stave(x, staffYs[k], width);
        if (firstInLine) st.addClef(spec.clef, 'default', spec.annotation);
        if (showSig) st.addTimeSignature(sig);
        return st;
      });
      const stave = staves[0] || null;
      let tabStave = null;
      if (showTab) {
        tabStave = new TabStave(x, tabY, width);
        if (firstInLine) tabStave.addTabGlyph();
        if (showSig) tabStave.addTimeSignature(sig);
      }
      // 오선보와 TAB의 음표 시작점을 맞춤 (장식 폭이 달라도 같은 x에 음표가 오게)
      const allStaves = [...staves, tabStave].filter(Boolean);
      const startX = Math.max(...allStaves.map((s) => s.getNoteStartX()));
      allStaves.forEach((s) => s.setNoteStartX(startX));
      const endX = allStaves.at(0).getNoteEndX();

      b.staffs.forEach((st, k) => st.voice.getTickables().forEach((n) => n.setStave(staves[k])));
      if (b.tabVoice) b.tabVoice.getTickables().forEach((n) => n.setStave(tabStave));

      // 큰보표: 줄 첫머리에 중괄호와 왼쪽 세로줄, 마디 끝 세로줄은 두 오선을 이어서
      const connectors = [];
      if (staves.length === 2) {
        if (firstInLine) {
          connectors.push(new StaveConnector(staves[0], staves[1]).setType(StaveConnector.type.BRACE));
          connectors.push(new StaveConnector(staves[0], staves[1]).setType(StaveConnector.type.SINGLE_LEFT));
        }
        connectors.push(new StaveConnector(staves[0], staves[1]).setType(StaveConnector.type.SINGLE_RIGHT));
      }
      b.formatter.format(b.voices, Math.max(10, endX - startX - 12));

      // 붙임줄 잇기 (오선마다 따로: 큰보표에서 위·아래 줄의 붙임줄은 서로 섞이지 않음)
      b.staffs.forEach((st, k) => {
        st.tieEnds.forEach((te) => {
          const id = `${k}:${te.tieId}`;
          const open = openTies[id];
          if (open) {
            lineTies.push({ firstNote: open.note, lastNote: te.note, firstIndexes: open.indexes, lastIndexes: te.indexes });
          } else {
            lineTies.push({ firstNote: null, lastNote: te.note, firstIndexes: te.indexes, lastIndexes: te.indexes });
          }
          delete openTies[id];
        });
        st.tieStarts.forEach((tsInfo) => {
          openTies[`${k}:${tsInfo.tieId}`] = { note: tsInfo.note, indexes: tsInfo.indexes };
        });
      });

      // 편집용 좌표: 칸마다 x, 시간 ↔ x 변환 점
      const len = measureLength(b.measure);
      const events = b.eventGeom.map((g) => {
        // 음표 머리/숫자의 가운데 x. 커서는 TAB이 있으면 TAB 숫자 기준
        const staffX = g.staffNote ? g.staffNote.getAbsoluteX() + 6 : null;
        const tabX = g.tabNote && showTab ? g.tabNote.getAbsoluteX() + 4 : null;
        return {
          time: g.time,
          kind: g.kind,
          x: tabX ?? staffX ?? startX,
          staffX,
          tabX,
          notes: g.notes.map((n, ni) => {
            const k = g.noteStaff[ni];
            const st = staves[k];
            return {
            id: noteId(n),
            string: n.string,
            fret: fretOf(n),
            unplaced: notation.markUnplaced && n.string == null,
            staffY: st ? st.getYForNote(staffLine(specs[k].written(soundingPitch(n))) + specs[k].lineShift) : null,
            tabY: tabStave && n.string != null ? tabStave.getYForLine(n.string - 1) : null,
            };
          }),
        };
      });

      const result = {
        mIndex: b.mIndex,
        x0: x,
        x1: x + width,
        noteStartX: startX,
        noteEndX: endX,
        len,
        points: [...events.map((e) => ({ time: e.time, x: e.x })), { time: len, x: endX }],
        events,
        // 오선 영역 위·아래 끝 (큰보표는 위 오선 맨 위 줄 ~ 아래 오선 맨 아래 줄)
        staffLines: stave ? [stave.getYForLine(0), staves.at(-1).getYForLine(4)] : null,
        tabLines: tabStave ? [tabStave.getYForLine(0), tabStave.getYForLine(5)] : null,
        stave,
        staves,
        tabStave,
        connectors,
        built: b,
      };
      x += width;
      return result;
    });

    // 줄 끝에서 다음 줄로 넘어가는 붙임줄: 이 줄에서는 오른쪽 끝까지 반쪽만
    Object.values(openTies).forEach((open) => {
      lineTies.push({ firstNote: open.note, lastNote: null, firstIndexes: open.indexes, lastIndexes: open.indexes });
    });

    const lastStave = measures.at(-1).tabStave || measures.at(-1).staves.at(-1);
    const height = lastStave.getYForLine(lastStave.getNumLines() - 1) + BOTTOM_ROOM + (view === VIEW_TAB ? TAB_STEM_ROOM : 0)
      + (showStaff && !showTab ? 30 : 0);

    // 그리기 (colors: { ink, staff, page, danger })
    const draw = (ctx, colors) => {
      ctx.setFillStyle(colors.ink);
      ctx.setStrokeStyle(colors.ink);
      ctx.setBackgroundFillStyle(colors.page);
      measures.forEach((m) => {
        [...m.staves, m.tabStave].filter(Boolean).forEach((s) => {
          s.setStyle({ strokeStyle: colors.staff, fillStyle: colors.ink });
          s.setContext(ctx).draw();
        });
        m.connectors.forEach((c) => {
          c.setStyle({ strokeStyle: colors.staff, fillStyle: colors.ink });
          c.setContext(ctx).draw();
        });
        m.built.staffs.forEach((st, k) => {
          st.unplaced.forEach(({ note, index }) => note.setKeyStyle(index, { fillStyle: colors.danger, strokeStyle: colors.danger }));
          st.voice.draw(ctx, m.staves[k]);
          st.beams.forEach((bm) => bm.setContext(ctx).draw());
          st.ties.forEach((t) => new StaveTie(t).setContext(ctx).draw());
        });
        if (m.built.tabVoice) m.built.tabVoice.draw(ctx, m.tabStave);
        m.built.tabBeams.forEach((bm) => bm.setContext(ctx).draw());
      });
      lineTies.forEach((t) => new StaveTie(t).setContext(ctx).draw());
    };

    const line = { width: lineWidth, height, measures, draw };
    nextCache.set(lineKey, line);
    return line;
  });

  lineCache = nextCache;
  return { lines, staffY, tabY };
};

// 마디 안 시간 → x (칸 사이는 직선으로 이음)
export const timeToX = (m, time) => {
  const pts = m.points;
  if (time <= pts[0].time) return pts[0].x;
  for (let i = 1; i < pts.length; i++) {
    const a = pts.at(i - 1);
    const b = pts.at(i);
    if (time <= b.time) return a.x + ((time - a.time) / (b.time - a.time || 1)) * (b.x - a.x);
  }
  return pts.at(-1).x;
};

// 마디 안 x → 시간 (timeToX의 반대)
export const xToTime = (m, x) => {
  const pts = m.points;
  if (x <= pts[0].x) return pts[0].time;
  for (let i = 1; i < pts.length; i++) {
    const a = pts.at(i - 1);
    const b = pts.at(i);
    if (x <= b.x) return a.time + ((x - a.x) / (b.x - a.x || 1)) * (b.time - a.time);
  }
  return pts.at(-1).time;
};
