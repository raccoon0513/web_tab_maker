import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  IconPlayFromStart, IconPlayMeasure, IconPlay, IconRecord, IconStop, IconMetronome,
  IconSetLength, IconExtend, IconOpen, IconSave, IconNew, IconSun, IconMoon, IconHelp,
} from './components/Icons';
import {
  getAudioCtx, getOutputLatency, resumeAudioCtx, createBus, stopBus,
  playTone, playPercussiveMute, playMetronomeClick, releaseVoice,
  setToneMode, TONE_BASIC, TONE_PLUCK, setPluckBrightness, DEFAULT_PLUCK_BRIGHTNESS,
  setEq, DEFAULT_EQ, EQ_MIN_DB, EQ_MAX_DB,
} from './lib/audio';
import {
  TPQ, DURATION_STEPS, TIME_SIG_DENOMINATORS, MAX_TIME_SIG_NUM,
  getTimeSig, timeSigLength, beatUnitTicks, measureLength, measureLengthAt, timeSigAt, sameTimeSig,
  makeMeasure, createEmptyScore, cloneScore, ensureMeasures,
  buildMeasureStarts, toAbs, fromAbs, moveCursor, splitSpanByMeasures,
  loadScoreData, serializeScore, formatBeats,
} from './lib/scoreModel';

// --- 상수 모음 ---
const UNIT = 50; // 4분음표 1개(기본 밀도)의 가로 폭(px)
const MAX_LINE_WIDTH = 24; // 한 줄의 최대 폭 (UNIT 단위)
const MIN_MEASURE_WIDTH = 2; // 아주 짧은 마디도 이 폭 이상으로 그림
const SIDE_PADDING = 20;
const STRING_COUNT = 6;
const STRING_SPACING = 20;
const TOP_PADDING = 30;
const HEIGHT = TOP_PADDING + STRING_SPACING * 5 + 30;
const CLEF_WIDTH = 30; // 줄 머리(TAB 표시) 폭
const FRET_FONT = "'IBM Plex Sans Condensed', 'Arial Narrow', sans-serif"; // 악보 숫자는 좁은 글꼴
const DEFAULT_BPM = 120;
const STORAGE_KEY = 'tabEditorScore';

const TUNING = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };

// 재생 스케줄링: 소리는 이 시간만큼 앞서서만 예약 (긴 곡도 한꺼번에 예약하지 않음)
const SCHEDULE_LOOKAHEAD_SEC = 1.5;
const SCHEDULE_INTERVAL_MS = 100;
const PLAYHEAD_HEIGHT = STRING_SPACING * 5 + 14; // 줄 위아래로 7px씩

// 스트럼: 재생 시 화음을 6번줄 → 1번줄 순서(다운스트로크)로 조금씩 늦게 침
const STRUM_STEP_SEC = 0.012;     // 줄 사이 간격
const STRUM_MAX_RATIO = 0.4;      // 전체 스트럼이 음 길이의 이 비율을 넘지 않게 (빠른 패시지 보호)
const TONE_STORAGE_KEY = 'tabEditorTone';
const BRIGHTNESS_STORAGE_KEY = 'tabEditorToneBrightness';
const EQ_STORAGE_KEY = 'tabEditorEq';

const THEME_STORAGE_KEY = 'tabEditorTheme';
const STATUS_CLEAR_MS = 4000;

// 저장된 테마, 없으면 운영체제 설정을 따름
const loadTheme = () => {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* 저장된 값 없음 */ }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const MODES = [
  { id: 'INPUT', label: '입력', key: '`' },
  { id: 'SELECT', label: '선택', key: '`' },
  { id: 'SYMBOL', label: '기호', key: ']' },
];
const MODE_HINTS = {
  INPUT: '건반으로 음 입력, 클릭으로 커서 이동',
  SELECT: '↑↓ 음정, Ctrl+↑↓ 줄 이동, -/= 길이',
  SYMBOL: '1~6 해당 줄에 뮤트(X)',
};

const loadEq = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(EQ_STORAGE_KEY));
    if (saved && ['low', 'mid', 'high'].every(k => typeof saved[k] === 'number')) return saved;
  } catch { /* 저장된 값 없음 */ }
  return { ...DEFAULT_EQ };
};

// 캐시(localStorage)에서 악보와 BPM 불러오기
const loadCachedData = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const data = loadScoreData(JSON.parse(saved));
      if (data) return data;
    }
  } catch (e) {
    console.error("캐시 데이터를 읽는 중 오류가 발생했습니다.", e);
  }
  return { measures: createEmptyScore(), bpm: null };
};

// 키보드 매핑
const PIANO_MAP = {
  'z' : 48, 's' : 49, 'x' : 50, 'd' : 51, 
  'c' : 52, 'v' : 53, 'g' : 54, 'b' : 55, 
  'h' : 56, 'n' : 57, 'j' : 58, 'm' : 59, 
  ',' : 60, 'l' : 61, '.' : 62, ';' : 63, 
  '/' : 64, 
  'q' : 60, '2' : 61, 'w' : 62, '3' : 63, 
  'e' : 64, 'r' : 65, '5' : 66, 't' : 67, 
  '6' : 68, 'y' : 69, '7' : 70, 'u' : 71, 
  'i' : 72, '9' : 73, 'o' : 74, '0' : 75, 
  'p' : 76, 
};


// 화면 건반 배열 (실제 피아노처럼 E, B 다음엔 검은 건반 없음)
const TOP_ROW = [
  { w: 'q', b: '2' }, { w: 'w', b: '3' }, { w: 'e', b: null }, 
  { w: 'r', b: '5' }, { w: 't', b: '6' }, { w: 'y', b: '7' }, { w: 'u', b: null }, 
  { w: 'i', b: '9' }, { w: 'o', b: '0' }, { w: 'p', b: null }
];
const BOTTOM_ROW = [
  { w: 'z', b: 's' }, { w: 'x', b: 'd' }, { w: 'c', b: null }, 
  { w: 'v', b: 'g' }, { w: 'b', b: 'h' }, { w: 'n', b: 'j' }, { w: 'm', b: null }, 
  { w: ',', b: 'l' }, { w: '.', b: ';' }, { w: '/', b: null }
];

// 회전 노브: 위아래로 드래그해서 값 변경, 더블클릭하면 기본값
//    포커스를 받지 않으므로 스페이스바 등 단축키에 영향 없음
const KNOB_SIZE = 20;
const KNOB_DRAG_PX = 150; // 이만큼 드래그하면 전체 범위를 돎
const Knob = ({ label, value, min, max, defaultValue, onChange, title }) => {
  const dragRef = useRef(null);
  const ratio = (value - min) / (max - min);
  const angle = (-135 + ratio * 270) * (Math.PI / 180);
  const r = KNOB_SIZE / 2;
  const tipX = r + Math.sin(angle) * (r - 4);
  const tipY = r - Math.cos(angle) * (r - 4);

  const onPointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { y: e.clientY, value };
  };
  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const delta = ((dragRef.current.y - e.clientY) / KNOB_DRAG_PX) * (max - min);
    const next = Math.round(Math.min(max, Math.max(min, dragRef.current.value + delta)));
    if (next !== value) onChange(next);
  };
  const onPointerUp = () => { dragRef.current = null; };

  return (
    <div
      title={`${title} (드래그: 조절, 더블클릭: 기본값 ${defaultValue > 0 ? '+' : ''}${defaultValue}dB)`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange(defaultValue)}
      style={{ display: 'flex', alignItems: 'center', gap: '3px', cursor: 'ns-resize', userSelect: 'none', touchAction: 'none' }}
    >
      <svg width={KNOB_SIZE} height={KNOB_SIZE}>
        <circle cx={r} cy={r} r={r - 1} style={{ fill: 'var(--chrome-3)', stroke: value === 0 ? 'var(--line)' : 'var(--accent)' }} strokeWidth="1.5" />
        <line x1={r} y1={r} x2={tipX} y2={tipY} style={{ stroke: 'var(--text)' }} strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span style={{ fontSize: '11px', color: 'var(--muted)', minWidth: '27px', fontVariantNumeric: 'tabular-nums' }}>
        {label} {value > 0 ? '+' : ''}{value}
      </span>
    </div>
  );
};

// 악보의 모든 노트를 (마디, 위치, 줄) 순으로 펼친 목록
const collectAllNotes = (score) => {
  const allNotes = [];
  score.forEach((measure, mIndex) => {
    measure.beats.forEach((beat) => {
      Object.entries(beat.notes).forEach(([str, fret]) => {
        allNotes.push({ mIndex, time: beat.time, string: parseInt(str, 10), fret, duration: beat.duration });
      });
    });
  });
  allNotes.sort((a, b) => {
    if (a.mIndex !== b.mIndex) return a.mIndex - b.mIndex;
    if (a.time !== b.time) return a.time - b.time;
    return a.string - b.string;
  });
  return allNotes;
};

export default function TabEditor() {
  // 캐시(localStorage)에서 악보와 BPM 불러오기 (구버전 데이터는 자동 변환)
  const [initialData] = useState(loadCachedData);
  const [score, setScore] = useState(initialData.measures);
  const [bpm, setBpm] = useState(initialData.bpm || DEFAULT_BPM);

  // 악보나 BPM이 바뀔 때마다 자동으로 캐시에 저장
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeScore(score, bpm)));
  }, [score, bpm]);
  const [editorMode, setEditorMode] = useState('INPUT'); // 'INPUT', 'SELECT', 'SYMBOL'
  const [selectedNotes, setSelectedNotes] = useState([]); // 선택된 노트 배열: [{ mIndex, time, string }]
  const [isDebugMode, setIsDebugMode] = useState(false); // 박자 시각화 토글
  
  const [cursor, setCursor] = useState({ mIndex: 0, time: 0 });
  const [durIdx, setDurIdx] = useState(2); 
  const [isDotted, setIsDotted] = useState(false);
  const [status, setStatus] = useState(null); // 상태 줄 메시지 { text, isError }
  const statusTimerRef = useRef(null);
  const [theme, setTheme] = useState(loadTheme);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  
  // 재생 관련 상태
  const [playbackState, setPlaybackState] = useState('STOPPED'); // 'STOPPED', 'PLAYING', 'PAUSED'
  const [isOctaveDown, setIsOctaveDown] = useState(false);

  const prePlaybackCursorRef = useRef(null); // 재생 전 커서 위치 기억용
  const playbackRef = useRef(null);      // 현재 재생 세션 (스케줄러 타이머, 재생 버스)
  const playTokenRef = useRef(0);        // 재생/정지할 때마다 증가 (오디오 준비 중 겹친 재생 요청 무시용)
  const scoreAreaRef = useRef(null);     // 진행 바 좌표 기준이 되는 악보 영역
  const playheadRef = useRef(null);      // 진행 바 DOM
  const playheadLineRef = useRef(null);  // 진행 바가 있는 줄 (줄이 바뀌면 스크롤)
  const chunkElsRef = useRef({});        // `${줄}-${조각}` -> 마디 조각 svg
  const layoutRef = useRef([]);          // 최신 레이아웃 (진행 바 계산용)
  const scoreLenRef = useRef(score.length);
  const [isMetronome, setIsMetronome] = useState(false);
  // 음색 (삼각파 / 기타음). 악보가 아닌 개인 설정이라 따로 저장
  const [toneMode, setToneModeState] = useState(() => {
    try { return localStorage.getItem(TONE_STORAGE_KEY) === TONE_PLUCK ? TONE_PLUCK : TONE_BASIC; }
    catch { return TONE_BASIC; }
  });
  useEffect(() => {
    setToneMode(toneMode);
    try { localStorage.setItem(TONE_STORAGE_KEY, toneMode); } catch { /* 저장 불가 환경 */ }
  }, [toneMode]);
  // 기타음의 밝기 (0 = 가장 먹먹 ~ 100 = 가장 밝음)
  const [brightness, setBrightness] = useState(() => {
    try {
      const v = Number(localStorage.getItem(BRIGHTNESS_STORAGE_KEY));
      return localStorage.getItem(BRIGHTNESS_STORAGE_KEY) !== null && v >= 0 && v <= 100 ? v : Math.round(DEFAULT_PLUCK_BRIGHTNESS * 100);
    } catch { return Math.round(DEFAULT_PLUCK_BRIGHTNESS * 100); }
  });
  // 기타음 3밴드 EQ (dB)
  const [eq, setEqState] = useState(loadEq);
  useEffect(() => {
    setEq(eq);
    try { localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify(eq)); } catch { /* 저장 불가 환경 */ }
  }, [eq]);
  useEffect(() => {
    setPluckBrightness(brightness / 100);
    try { localStorage.setItem(BRIGHTNESS_STORAGE_KEY, String(brightness)); } catch { /* 저장 불가 환경 */ }
  }, [brightness]);
  const recordingStartTimeRef = useRef(null); // 실제 녹음 시작 시간(카운트인 종료 시점)
  const recordingStartAbsRef = useRef(null); // 녹음을 시작한 절대 위치 (틱)
  const lastRecordPressTimeRef = useRef(null); // 녹음 중 건반을 누른 정확한 퀀타이즈 시점

  const [activeUIKeys, setActiveUIKeys] = useState(new Set());
  const activeKeysRef = useRef(new Set()); 
  const chordAccumulatorRef = useRef(new Set()); 

  // 현재 입력/이동 단위 (틱)
  const currentStep = DURATION_STEPS[durIdx] * (isDotted ? 1.5 : 1);
  // 커서가 있는 마디의 박자표 (툴바 표시용)
  const cursorTimeSig = timeSigAt(score, cursor.mIndex);

  // JSON 파일로 내보내기
  const handleExportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(serializeScore(score, bpm), null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "guitar_tab_score.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    showStatus("악보를 파일로 저장했습니다.");
  };

  // JSON 파일 불러오기
  const handleImportJSON = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        // 구버전(박 단위, 4/4 고정) 파일도 자동 변환됨
        const data = loadScoreData(JSON.parse(event.target.result));
        if (data) {
          setScore(data.measures);
          if (data.bpm) setBpm(data.bpm);
          setSelectedNotes([]);
          setCursor({ mIndex: 0, time: 0 });
          showStatus("악보를 불러왔습니다.");
        } else {
          showStatus("악보 파일(JSON) 형식이 아닙니다.", true);
        }
      } catch (err) {
        showStatus("악보 파일(JSON) 형식이 아닙니다.", true);
      }
    };
    reader.readAsText(file);
    e.target.value = null; // 같은 파일을 다시 불러올 수 있도록 input 초기화
    e.target.blur();       // 포커스가 남으면 단축키가 동작하지 않음
  };

  // 새 악보 (완전 초기화)
  const handleResetScore = () => {
    if (window.confirm("지금 악보를 지우고 새 악보를 시작할까요? 저장하지 않은 내용은 사라집니다.")) {
      setScore(createEmptyScore());
      setSelectedNotes([]);
      setCursor({ mIndex: 0, time: 0 });
      showStatus("새 악보를 시작했습니다.");
    }
  };

  // 박자표 변경: 커서가 있는 마디부터 끝까지 적용
  //    마디가 짧아져서 밖으로 밀려나는 노트가 있으면 변경하지 않음
  const handleTimeSigChange = (num, den) => {
    const newTimeSig = { num, den };
    const newLen = timeSigLength(newTimeSig);
    const fromIdx = Math.min(cursor.mIndex, score.length - 1);

    const overflow = score.slice(fromIdx).some(m => m.beats.some(b => b.time >= newLen));
    if (overflow) {
      showStatus("마디 길이를 넘는 노트가 있어 박자를 바꿀 수 없습니다.", true);
      return;
    }

    setScore(prev => prev.map((m, i) => (i >= fromIdx ? { ...m, timeSig: { ...newTimeSig } } : m)));
    if (cursor.time >= newLen) setCursor({ mIndex: cursor.mIndex, time: 0 });
    showStatus(`${fromIdx + 1}번 마디부터 ${num}/${den} 박자로 변경했습니다.`);
  };

  // 테마 적용 (문서 전체에 걸어서 바탕색까지 바뀜)
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* 저장 불가 환경 */ }
  }, [theme]);

  // 모드 전환 (단축키와 도구 줄 버튼이 같이 씀). 선택 모드로 들어가면 커서에서 가장 가까운 노트를 선택
  const changeMode = (next) => {
    if (next === editorMode) return;
    if (next === 'SELECT') {
      const allNotes = collectAllNotes(score);
      if (allNotes.length > 0) {
        const closestNote = allNotes.find(n => n.mIndex > cursor.mIndex || (n.mIndex === cursor.mIndex && n.time >= cursor.time)) || allNotes[allNotes.length - 1];
        setSelectedNotes([closestNote]);
      }
    } else {
      setSelectedNotes([]);
    }
    setEditorMode(next);
  };

  // 상태 줄 오른쪽에 잠시 메시지 표시 (오류는 붉게)
  const showStatus = (text, isError = false) => {
    clearTimeout(statusTimerRef.current);
    setStatus({ text, isError });
    statusTimerRef.current = setTimeout(() => setStatus(null), STATUS_CLEAR_MS);
  };

  // 진행 바: 재생 위치(절대 틱)를 화면 좌표로 바꿔 세로선을 직접 옮김
  //    매 프레임 React 렌더링을 일으키지 않도록 DOM 스타일만 수정
  const updatePlayhead = (abs, playScore) => {
    const el = playheadRef.current;
    const area = scoreAreaRef.current;
    if (!el || !area) return;

    const { mIndex, time } = fromAbs(playScore, abs);
    const lines = layoutRef.current;
    for (let li = 0; li < lines.length; li++) {
      for (let ci = 0; ci < lines[li].length; ci++) {
        const ch = lines[li][ci];
        if (ch.mIndex !== mIndex || time < ch.timeStart || time >= ch.timeEnd) continue;
        const svg = chunkElsRef.current[`${li}-${ci}`];
        if (!svg) continue;

        const areaRect = area.getBoundingClientRect();
        const r = svg.getBoundingClientRect();
        const inner = r.width - SIDE_PADDING * 2;
        const x = r.left - areaRect.left + SIDE_PADDING + ((time - ch.timeStart) / (ch.timeEnd - ch.timeStart)) * inner;
        el.style.display = 'block';
        el.style.left = `${x - 1}px`;
        el.style.top = `${r.top - areaRect.top + TOP_PADDING - 7}px`;

        // 다음 줄로 넘어가면 화면을 따라 스크롤 (하단 건반 패널에 가리지 않게)
        if (playheadLineRef.current !== li) {
          playheadLineRef.current = li;
          if (r.top < 0 || r.bottom > window.innerHeight - 200) {
            window.scrollBy({ top: r.top - 120, behavior: 'smooth' });
          }
        }
        return;
      }
    }
    el.style.display = 'none'; // 악보 밖 (녹음 중 아직 없는 마디 등)
  };

  // 재생 종료. hardStop이면 예약된 소리까지 끊고, 아니면(곡이 자연스럽게 끝남) 여운을 남김
  const finishPlayback = useCallback((hardStop) => {
    playTokenRef.current += 1;
    const pb = playbackRef.current;
    if (pb) {
      clearInterval(pb.schedTimer);
      cancelAnimationFrame(pb.rafId);
      if (hardStop) stopBus(pb.bus);
      playbackRef.current = null;
    }
    if (playheadRef.current) playheadRef.current.style.display = 'none';
    playheadLineRef.current = null;
    setPlaybackState('STOPPED');

    if (prePlaybackCursorRef.current) {
      setCursor(prePlaybackCursorRef.current);
      prePlaybackCursorRef.current = null;
    }
  }, []);

  // 정지 로직: 예약된 오디오 취소 및 커서 원래 위치로 복귀
  const handleStop = useCallback(() => finishPlayback(true), [finishPlayback]);

  // 재생 및 녹음 로직
  //    - 시간 기준은 오디오 시계(ctx.currentTime) 하나. 화면은 출력 지연을 뺀 "들리는 시각"으로 그림
  //    - 소리는 SCHEDULE_LOOKAHEAD_SEC 앞까지만 조금씩 예약 (메트로놈/녹음은 정지할 때까지 계속)
  const handlePlay = useCallback(async (playMode = 'ALL') => {
    const cursorToSave = prePlaybackCursorRef.current || cursor;
    handleStop();
    prePlaybackCursorRef.current = cursorToSave;

    const token = playTokenRef.current;
    const ctx = await resumeAudioCtx();
    if (token !== playTokenRef.current) return; // 준비하는 사이에 정지나 다른 재생이 들어옴
    const isRecording = playMode === 'RECORD';
    setPlaybackState(isRecording ? 'RECORDING' : 'PLAYING');
    setSelectedNotes([]);

    const playScore = score; // 재생 시작 시점의 악보 기준으로 계산
    const secondsPerTick = 60 / bpm / TPQ;
    const starts = buildMeasureStarts(playScore);

    // MEASURE 모드와 RECORD 모드는 커서가 있는 마디의 처음부터
    let startAbs = 0;
    if (playMode === 'CURSOR') {
      startAbs = toAbs(playScore, cursorToSave.mIndex, cursorToSave.time);
    } else if (playMode === 'MEASURE' || isRecording) {
      startAbs = toAbs(playScore, cursorToSave.mIndex, 0);
    }

    const bus = createBus();
    let ctxStartTime = ctx.currentTime + 0.1;

    // 카운트인: 녹음 모드일 때 시작 마디의 박자표대로 한 마디 대기
    if (isRecording) {
      const ts = timeSigAt(playScore, cursorToSave.mIndex);
      const unitSec = beatUnitTicks(ts) * secondsPerTick;
      for (let i = 0; i < ts.num; i++) {
        playMetronomeClick(ctxStartTime + i * unitSec, i === 0, bus);
      }
      ctxStartTime += ts.num * unitSec;
      recordingStartTimeRef.current = ctxStartTime;
      recordingStartAbsRef.current = startAbs;
    }
    const toSec = (abs) => ctxStartTime + (abs - startAbs) * secondsPerTick;

    // 붙임줄(tie)로 이어진 노트는 첫 조각에서 전체 길이로 한 번만 소리냄
    const tieGroups = {};
    playScore.forEach((measure, mIndex) => {
      measure.beats.forEach(beat => {
        if (!beat.tieId) return;
        const abs = starts[mIndex] + beat.time;
        const g = tieGroups[beat.tieId] || (tieGroups[beat.tieId] = { firstAbs: abs, total: 0 });
        g.firstAbs = Math.min(g.firstAbs, abs);
        g.total += beat.duration;
      });
    });

    // 재생할 소리 목록 (시간순)
    const events = [];
    let endAbs = startAbs;
    playScore.forEach((measure, mIndex) => {
      measure.beats.forEach(beat => {
        const absTime = starts[mIndex] + beat.time;
        if (absTime < startAbs) return;

        let durTicks = beat.duration;
        let skipSound = false;
        if (beat.tieId) {
          const g = tieGroups[beat.tieId];
          if (absTime === g.firstAbs) durTicks = g.total;            // 붙임줄 시작: 전체 길이
          else if (g.firstAbs >= startAbs) skipSound = true;        // 이미 앞 조각에서 소리냄
          else durTicks = g.total - (absTime - g.firstAbs);         // 재생 시작점이 붙임줄 중간
        }
        endAbs = Math.max(endAbs, absTime + beat.duration);
        if (skipSound) return;

        // 다운스트로크: 굵은 줄(6번)부터 순서대로 시차를 둠
        const entries = Object.entries(beat.notes)
          .map(([string, fret]) => [parseInt(string, 10), fret])
          .sort((a, b) => b[0] - a[0]);
        const strumStep = entries.length > 1
          ? Math.min(STRUM_STEP_SEC, (beat.duration * secondsPerTick * STRUM_MAX_RATIO) / (entries.length - 1))
          : 0;

        entries.forEach(([string, fret], i) => {
          const offsetSec = i * strumStep;
          if (fret === 'X') {
            events.push({ abs: absTime, offsetSec, string, mute: true });
            return;
          }
          // 노트별 울림 길이(sustain)가 있으면 우선 사용
          const noteTicks = (beat.sustain && beat.sustain[string]) || durTicks;
          events.push({ abs: absTime, offsetSec, string, midi: TUNING[string] + fret, ticks: noteTicks });
          endAbs = Math.max(endAbs, absTime + noteTicks);
        });
      });
    });
    events.sort((a, b) => (a.abs - b.abs) || (a.offsetSec - b.offsetSec));

    if (events.length === 0 && !isRecording) {
      stopBus(bus);
      handleStop();
      return;
    }
    const endSec = toSec(endAbs);

    // 메트로놈 위치 (시작 지점 이후 첫 박부터)
    let metro = null;
    if (isMetronome || isRecording) {
      const p = fromAbs(playScore, startAbs);
      const unit = beatUnitTicks(timeSigAt(playScore, p.mIndex));
      metro = { mIdx: p.mIndex, mStart: startAbs - p.time, t: Math.ceil(p.time / unit) * unit };
    }

    // 스케줄러: 앞으로 SCHEDULE_LOOKAHEAD_SEC 안에 나올 소리만 예약
    let nextEvent = 0;
    const voiceOnString = {}; // 줄마다 지금 울리고 있는 음 (같은 줄에 새 음이 오면 끊음)
    const schedule = () => {
      const horizon = ctx.currentTime + SCHEDULE_LOOKAHEAD_SEC;

      while (nextEvent < events.length && toSec(events[nextEvent].abs) < horizon) {
        const ev = events[nextEvent++];
        const t = toSec(ev.abs) + ev.offsetSec;
        // 실제 기타처럼 한 줄에는 한 소리만: 앞 음을 끊고 새 음(또는 뮤트)
        releaseVoice(voiceOnString[ev.string], t);
        if (ev.mute) {
          playPercussiveMute(t, bus);
          voiceOnString[ev.string] = null;
        } else {
          voiceOnString[ev.string] = playTone(ev.midi, t, ev.ticks * secondsPerTick, bus);
        }
      }

      if (metro) {
        for (;;) {
          const ts = timeSigAt(playScore, metro.mIdx);
          const len = timeSigLength(ts);
          if (metro.t >= len) { metro.mIdx += 1; metro.mStart += len; metro.t = 0; continue; }
          const t = toSec(metro.mStart + metro.t);
          if (t >= horizon) break;
          if (!isRecording && t >= endSec) break; // 일반 재생은 곡 끝까지만
          playMetronomeClick(t, metro.t === 0, bus);
          metro.t += beatUnitTicks(ts);
        }
      }
    };

    // 화면 루프: "지금 들리는 위치"에 진행 바를 그림
    const session = { bus, schedTimer: null, rafId: null };
    const frame = () => {
      if (playbackRef.current !== session) return;
      const heardSec = ctx.currentTime - getOutputLatency();

      // 곡이 끝나면(소리가 실제로 다 나온 뒤) 자연 종료. 여운은 끊지 않음
      if (!isRecording && heardSec >= endSec) {
        finishPlayback(false);
        return;
      }

      const abs = startAbs + Math.max(0, heardSec - ctxStartTime) / secondsPerTick;
      // 녹음이 악보 끝을 지나가면 마디를 늘려서 진행 바가 계속 보이게 함
      if (isRecording) {
        const m = fromAbs(playScore, abs).mIndex;
        if (m >= scoreLenRef.current) {
          setScore(prev => (prev.length > m ? prev : ensureMeasures(cloneScore(prev), m)));
        }
      }
      updatePlayhead(abs, playScore);
      session.rafId = requestAnimationFrame(frame);
    };

    playbackRef.current = session;
    schedule();
    session.schedTimer = setInterval(schedule, SCHEDULE_INTERVAL_MS);
    session.rafId = requestAnimationFrame(frame);
  }, [score, bpm, cursor, handleStop, finishPlayback, isMetronome]);

  // 줄바꿈 레이아웃: 마디 폭 = 박자표 길이 × 밀도 (짧은 음표가 있으면 넓게)
  const layout = useMemo(() => {
    const lines = [];
    let currentLineChunks = [];
    let currentRemaining = MAX_LINE_WIDTH;

    score.forEach((measure, mIndex) => {
      const len = measureLength(measure);
      const timeSig = getTimeSig(measure);
      // 첫 마디이거나 박자표가 바뀌는 마디에만 박자표 표시
      const showTimeSig = mIndex === 0 || !sameTimeSig(timeSig, getTimeSig(score[mIndex - 1]));

      let minDuration = len;
      measure.beats.forEach(b => { if (b.duration < minDuration) minDuration = b.duration; });

      // 4분음표당 UNIT 개수: 기본 1, 8분음표 이하가 있으면 2, 16분음표 이하가 있으면 4
      let density = 1;
      if (minDuration <= TPQ / 4) density = 4;
      else if (minDuration <= TPQ / 2) density = 2;
      const W = Math.min(MAX_LINE_WIDTH, Math.max(MIN_MEASURE_WIDTH, (len / TPQ) * density));

      let R = currentRemaining;
      if (R <= 0) { lines.push(currentLineChunks); currentLineChunks = []; R = MAX_LINE_WIDTH; }

      const base = { mIndex, measureId: measure.id, timeSig, showTimeSig };

      if (W <= R) {
        currentLineChunks.push({ ...base, beats: measure.beats, width: W, timeStart: 0, timeEnd: len, type: 'full' });
        currentRemaining = R - W;
      } else {
        const timeBoundary = len * (R / W);

        currentLineChunks.push({ ...base, beats: measure.beats.filter(b => b.time < timeBoundary), width: R, timeStart: 0, timeEnd: timeBoundary, type: 'start' });
        lines.push(currentLineChunks); currentLineChunks = [];

        const wRemaining = W - R;
        currentLineChunks.push({ ...base, showTimeSig: false, beats: measure.beats.filter(b => b.time >= timeBoundary), width: wRemaining, timeStart: timeBoundary, timeEnd: len, type: 'end' });
        currentRemaining = MAX_LINE_WIDTH - wRemaining;
      }
    });

    if (currentLineChunks.length > 0) lines.push(currentLineChunks);
    return lines;
  }, [score]);

  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { scoreLenRef.current = score.length; }, [score.length]);

  // 화면을 떠날 때 재생 정리
  useEffect(() => () => {
    const pb = playbackRef.current;
    if (pb) { clearInterval(pb.schedTimer); cancelAnimationFrame(pb.rafId); stopBus(pb.bus); }
  }, []);

  // 붙임줄 조각마다 앞/뒤 조각이 있는지 (위치 기준으로 판단: 마디 시작에서 출발하는 긴 음도 처리)
  const tieInfo = useMemo(() => {
    const starts = buildMeasureStarts(score);
    const range = {};
    score.forEach((m, mIndex) => m.beats.forEach(b => {
      if (!b.tieId) return;
      const abs = starts[mIndex] + b.time;
      const r = range[b.tieId] || (range[b.tieId] = { min: abs, max: abs });
      r.min = Math.min(r.min, abs);
      r.max = Math.max(r.max, abs);
    }));
    const info = {};
    score.forEach((m, mIndex) => m.beats.forEach(b => {
      if (!b.tieId) return;
      const abs = starts[mIndex] + b.time;
      const r = range[b.tieId];
      info[`${mIndex}-${b.time}`] = { hasPrev: abs > r.min, hasNext: abs < r.max };
    }));
    return info;
  }, [score]);

  // 통상 입력과 실시간 녹음을 모두 처리하는 범용 insertChord
  //    마디 경계를 넘는 길이는 마디마다 잘라서 붙임줄(tieId)로 연결
  const insertChord = (keysToProcess, overrideTime = null) => {
    const targetDur = currentStep;

    // overrideTime이 주어지면(녹음 중) 퀀타이즈된 위치 사용, 아니면 현재 커서 사용
    const basePos = overrideTime || cursor;
    const nextCursor = moveCursor(score, basePos, targetDur);

    setScore(prev => {
      const newScore = cloneScore(prev);
      const startAbs = toAbs(newScore, basePos.mIndex, basePos.time);
      const segments = splitSpanByMeasures(newScore, startAbs, targetDur);
      ensureMeasures(newScore, fromAbs(newScore, startAbs + targetDur).mIndex);

      const tieId = segments.length > 1 ? Date.now().toString() : null;

      // 각 조각 위치에 비트를 찾거나 새로 만듦
      const segBeats = segments.map(seg => {
        const measure = newScore[seg.mIndex];
        let beat = measure.beats.find(b => b.time === seg.time);
        if (!beat) {
          beat = { time: seg.time, duration: seg.duration, notes: {}, tieId };
          measure.beats.push(beat);
        }
        return { measure, beat };
      });

      let collisionOccurred = false;
      let outOfRange = false;

      keysToProcess.forEach(key => {
        let midi = PIANO_MAP[key];
        if (isOctaveDown) midi -= 12;

        if (midi < 40) {
          outOfRange = true;
          return;
        }

        // 모든 조각에서 비어 있는 줄 중 가장 낮은 프렛
        let bestString = null, minFret = 999;
        for (let s = 1; s <= 6; s++) {
          const fret = midi - TUNING[s];
          if (fret >= 0 && fret <= 24 && fret < minFret && segBeats.every(({ beat }) => beat.notes[s] === undefined)) {
            minFret = fret; bestString = s;
          }
        }

        if (bestString) {
          segBeats.forEach(({ beat }) => { beat.notes[bestString] = minFret; });
        } else {
          collisionOccurred = true;
        }
      });

      if (outOfRange) showStatus("스탠다드 튜닝(E2) 범위를 벗어나는 저음입니다.", true);
      else if (collisionOccurred) showStatus("빈 줄이 없어서 입력하지 못했습니다.", true);

      // 노트가 하나도 안 들어간 비트는 제거
      segBeats.forEach(({ measure, beat }) => {
        if (Object.keys(beat.notes).length === 0) measure.beats = measure.beats.filter(b => b !== beat);
      });

      return newScore;
    });

    // 녹음 모드가 아닐 때만 커서를 물리적으로 전진시킴
    if (!overrideTime) {
      setCursor(nextCursor);
    }
  };

  // 선택된 노트들의 길이를 바꾸고, 바뀐 만큼 뒤의 노트를 모두 당기거나 미는 리플 편집
  //    computeNewDuration(beat) → 새 길이(틱) 또는 { error: 메시지 }
  //    syncDurIdx: 하단 입력 박자를 첫 선택 노트의 새 길이에 맞출지
  const applyRippleDurations = (computeNewDuration, { syncDurIdx = false } = {}) => {
    const starts = buildMeasureStarts(score);

    // 1. 모든 비트를 절대 시간(틱) 기준 1차원 배열로 풀어서 정렬 (기존 위치 추적용 데이터 포함)
    const allBeats = [];
    score.forEach((m, mIdx) => {
      m.beats.forEach(b => {
        allBeats.push({ ...b, absTime: starts[mIdx] + b.time, originalMIndex: mIdx, originalTime: b.time });
      });
    });
    allBeats.sort((a, b) => a.absTime - b.absTime);

    // 2. 선택된 노트들의 절대 시간 수집 (중복 제거)
    const selectedAbsTimes = new Set(selectedNotes.map(sel => starts[sel.mIndex] + sel.time));
    if (selectedAbsTimes.size === 0) return false;

    let cumulativeShift = 0; // 복수 노트 변경으로 인한 누적 밀림/당김 시간
    const shiftedBeats = [];

    // 3. 누적 리플 연산 및 방어 로직
    for (const b of allBeats) {
      const newAbsTime = b.absTime + cumulativeShift;

      // 방어 1: 0박자 이전으로 당겨지는 경우
      if (newAbsTime < 0) {
        showStatus("더 이상 노트를 앞으로 당길 수 없습니다 (0박자 미만).", true);
        return false;
      }

      let newDuration = b.duration;

      // 이 비트가 사용자가 선택한 비트라면 박자 변경 및 누적값 갱신
      if (selectedAbsTimes.has(b.absTime)) {
        const result = computeNewDuration(b);
        if (typeof result === 'object' && result.error) {
          showStatus(result.error, true);
          return false;
        }
        newDuration = result;
        cumulativeShift += newDuration - b.duration;
      }

      shiftedBeats.push({ ...b, absTime: newAbsTime, duration: newDuration });
    }

    // 4. 악보 재조립 및 화음 병합 (마디별 박자표는 그대로 유지)
    const rebuiltScore = score.map(m => makeMeasure(m.id, getTimeSig(m)));
    const maxAbs = shiftedBeats.reduce((mx, b) => Math.max(mx, b.absTime), 0);
    ensureMeasures(rebuiltScore, fromAbs(rebuiltScore, maxAbs).mIndex);

    shiftedBeats.forEach(b => {
      const { mIndex: mIdx, time: localTime } = fromAbs(rebuiltScore, b.absTime);

      const existingBeat = rebuiltScore[mIdx].beats.find(eb => eb.time === localTime);
      if (existingBeat) {
        existingBeat.notes = { ...existingBeat.notes, ...b.notes };
        if (b.sustain) existingBeat.sustain = { ...existingBeat.sustain, ...b.sustain };
        // 한 행에 화음이 부딪혀 겹쳤을 때 "가장 짧은 노트 기준" 반영
        existingBeat.duration = Math.min(existingBeat.duration, b.duration);
      } else {
        const beat = { time: localTime, duration: b.duration, notes: b.notes, tieId: b.tieId };
        if (b.sustain) beat.sustain = b.sustain;
        rebuiltScore[mIdx].beats.push(beat);
      }
    });

    // 5. 튕겨나감 없는 복수 선택 영역 좌표 재추적
    const nextSelectedNotes = selectedNotes.map(sel => {
      const matchingShiftedBeat = shiftedBeats.find(b =>
        b.originalMIndex === sel.mIndex && b.originalTime === sel.time
      );
      if (matchingShiftedBeat) {
        return { ...sel, ...fromAbs(rebuiltScore, matchingShiftedBeat.absTime), duration: matchingShiftedBeat.duration };
      }
      return sel;
    });

    // 6. 상태 일괄 동기화 (커서 위치 및 UI 길이)
    const rebuiltStarts = buildMeasureStarts(rebuiltScore);
    const sortedNextSelected = [...nextSelectedNotes].sort((a, b) =>
      (rebuiltStarts[a.mIndex] + a.time) - (rebuiltStarts[b.mIndex] + b.time));
    const firstSel = sortedNextSelected[0];

    if (syncDurIdx) {
      const firstBeat = rebuiltScore[firstSel.mIndex].beats.find(b => b.time === firstSel.time);
      if (firstBeat) {
        const idx = DURATION_STEPS.findIndex(d => d === firstBeat.duration || d * 1.5 === firstBeat.duration);
        if (idx !== -1) setDurIdx(idx);
      }
    }

    setScore(rebuiltScore);
    setSelectedNotes(nextSelectedNotes);
    setCursor({ mIndex: firstSel.mIndex, time: firstSel.time });
    return true;
  };

  // [버튼] 선택한 노트들의 길이를 현재 입력 박자(하단 표시)로 맞춤 (리플 편집)
  const handleSetSelectedLength = () => {
    if (editorMode !== 'SELECT') return;
    if (selectedNotes.length === 0) { showStatus("선택된 노트가 없습니다.", true); return; }
    if (applyRippleDurations(() => currentStep)) {
      showStatus(`선택한 노트를 ${formatBeats(currentStep)}박으로 맞췄습니다.`);
    }
  };

  // [버튼] 선택한 노트를 다음 노트가 있는 위치까지 늘림 (뒤 노트는 움직이지 않음)
  //    - 한 열의 노트를 전부 선택: 열의 길이 자체를 늘림. 마디를 넘으면 붙임줄로 나눔
  //    - 화음 중 일부만 선택: 그 노트들의 울림 길이(sustain)만 늘림
  const handleExtendToNextNote = () => {
    if (editorMode !== 'SELECT') return;
    if (selectedNotes.length === 0) { showStatus("선택된 노트가 없습니다.", true); return; }

    const starts = buildMeasureStarts(score);
    const noteAbsTimes = [];
    score.forEach((m, mIdx) => m.beats.forEach(b => {
      if (Object.keys(b.notes).length > 0) noteAbsTimes.push(starts[mIdx] + b.time);
    }));
    noteAbsTimes.sort((a, b) => a - b);

    // 선택을 열(비트) 단위로 묶음
    const groups = new Map();
    selectedNotes.forEach(sel => {
      const key = `${sel.mIndex}-${sel.time}`;
      if (!groups.has(key)) groups.set(key, { mIndex: sel.mIndex, time: sel.time, strings: new Set() });
      groups.get(key).strings.add(sel.string);
    });

    const newScore = cloneScore(score);
    let changed = 0;
    let lastOnes = 0;

    groups.forEach(g => {
      const beat = newScore[g.mIndex] && newScore[g.mIndex].beats.find(b => b.time === g.time);
      if (!beat) return;
      const abs = starts[g.mIndex] + g.time;
      const nextAbs = noteAbsTimes.find(a => a > abs);
      if (nextAbs === undefined) { lastOnes += 1; return; }
      const gap = nextAbs - abs;

      const allSelected = Object.keys(beat.notes).every(s => g.strings.has(Number(s)));
      if (allSelected) {
        // 다음 노트까지 빈 구간이므로, 마디 경계에서 나눠 붙임줄 조각을 만들어도 겹치지 않음
        const segments = splitSpanByMeasures(newScore, abs, gap);
        beat.duration = segments[0].duration;
        if (beat.sustain) {
          g.strings.forEach(s => { delete beat.sustain[s]; });
          if (Object.keys(beat.sustain).length === 0) delete beat.sustain;
        }
        if (segments.length > 1) {
          const tieId = beat.tieId || `${Date.now()}-${abs}`;
          beat.tieId = tieId;
          segments.slice(1).forEach(seg => {
            newScore[seg.mIndex].beats.push({ time: seg.time, duration: seg.duration, notes: { ...beat.notes }, tieId });
          });
        }
      } else {
        beat.sustain = { ...(beat.sustain || {}) };
        g.strings.forEach(s => { beat.sustain[s] = gap; });
      }
      changed += 1;
    });

    if (changed === 0) {
      showStatus("뒤에 노트가 없어서 늘릴 수 없습니다.", true);
      return;
    }
    setScore(newScore);
    showStatus(lastOnes > 0
      ? "다음 노트까지 늘렸습니다. (뒤에 노트가 없는 노트는 그대로 둠)"
      : "다음 노트까지 늘렸습니다.");
  };

  const handleSelectModeInput = (e) => {
    // Delete / Backspace: 선택된 노트만 삭제
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (selectedNotes.length === 0) return;

      setScore(prev => {
        const newScore = cloneScore(prev);
        
        selectedNotes.forEach(sel => {
          const measure = newScore[sel.mIndex];
          if (!measure) return;
          
          const beatIdx = measure.beats.findIndex(b => b.time === sel.time);
          if (beatIdx !== -1) {
            const beat = measure.beats[beatIdx];
            
            // 해당 줄(String)의 노트만 삭제 (화음의 다른 노트는 보존)
            delete beat.notes[sel.string];
            
            // 만약 지우고 났더니 해당 박자에 남은 노트가 하나도 없다면 비트 자체를 삭제
            if (Object.keys(beat.notes).length === 0) {
              measure.beats.splice(beatIdx, 1);
            }
          }
        });
        return newScore;
      });

      setSelectedNotes([]); // 삭제 후 선택 해제
      return;
    }

    const allNotes = collectAllNotes(score);
    if (allNotes.length === 0) return;

    if (selectedNotes.length === 0) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        const firstNote = allNotes.find(n => n.mIndex > cursor.mIndex || (n.mIndex === cursor.mIndex && n.time >= cursor.time)) || allNotes[allNotes.length - 1];
        setSelectedNotes([firstNote]);
      }
      return;
    }

    // ← →: 다음/이전 노트 선택 (Shift: 여러 개 선택)
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const isNext = e.key === 'ArrowRight';
      const referenceNote = isNext ? selectedNotes[selectedNotes.length - 1] : selectedNotes[0];
      const currentIndex = allNotes.findIndex(n => n.mIndex === referenceNote.mIndex && n.time === referenceNote.time && n.string === referenceNote.string);

      if (isNext && currentIndex !== -1 && currentIndex < allNotes.length - 1) {
        const targetNote = allNotes[currentIndex + 1];
        if (e.shiftKey) {
          if (!selectedNotes.some(n => n.mIndex === targetNote.mIndex && n.time === targetNote.time && n.string === targetNote.string)) {
            setSelectedNotes(prev => [...prev, targetNote]);
          }
        } else {
          setSelectedNotes([targetNote]);
        }
      } else if (!isNext && currentIndex > 0) {
        const targetNote = allNotes[currentIndex - 1];
        if (e.shiftKey) {
          if (!selectedNotes.some(n => n.mIndex === targetNote.mIndex && n.time === targetNote.time && n.string === targetNote.string)) {
            setSelectedNotes(prev => [targetNote, ...prev]);
          }
        } else {
          setSelectedNotes([targetNote]);
        }
      }
      return;
    }

    // ↑ ↓: 음정 조절 (0프렛 아래로 내려가면 다른 줄로 옮김, 24프렛 제한 없음)
    if (!e.ctrlKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const amount = e.shiftKey ? 12 : 1;
      const delta = e.key === 'ArrowUp' ? amount : -amount;

      let canMove = true;
      let errorMessage = "";
      const plannedMoves = [];

      // 이동 경로 확보를 위해 선택된 노트들을 이동 방향에 따라 정렬 (충돌 방지)
      const sortedSelected = [...selectedNotes].sort((a, b) => delta < 0 ? b.string - a.string : a.string - b.string);

      const beatState = {}; 
      
      sortedSelected.forEach(sel => {
        const key = `${sel.mIndex}-${sel.time}`;
        if (!beatState[key]) {
          const measure = score[sel.mIndex];
          const beat = measure && measure.beats.find(b => b.time === sel.time);
          beatState[key] = beat ? { ...beat.notes } : {};
          // 본인들이 이동할 빈자리를 만들기 위해 현재 상태에서 임시 제외
          selectedNotes.forEach(s => {
            if (s.mIndex === sel.mIndex && s.time === sel.time) delete beatState[key][s.string];
          });
        }

        if (sel.fret === 'X') {
          plannedMoves.push(sel);
          beatState[key][sel.string] = 'X';
          return;
        }

        const currentPitch = TUNING[sel.string] + sel.fret;
        const targetPitch = currentPitch + delta;

        if (targetPitch < 40) {
          canMove = false; errorMessage = "기타(E2)로 연주할 수 없는 낮은 음입니다."; return;
        }

        let bestString = null;
        let newFret = -1;
        // 하행(delta<0)이면 더 두꺼운 줄(+1)로, 상행이면 얇은 줄(-1) 방향으로 탐색
        const searchDir = delta < 0 ? 1 : -1; 

        for (let s = sel.string; s >= 1 && s <= 6; s += searchDir) {
          let f = targetPitch - TUNING[s];
          // 빈 줄을 찾을 때까지 탐색 (최대 프렛 제한 없음)
          if (f >= 0 && beatState[key][s] === undefined) {
            bestString = s;
            newFret = f;
            break;
          }
        }

        if (bestString === null) {
          canMove = false; errorMessage = "이동할 수 있는 빈 줄이 없습니다."; return;
        }

        beatState[key][bestString] = newFret;
        plannedMoves.push({ ...sel, string: bestString, fret: newFret });
      });

      if (!canMove) { showStatus(errorMessage, true); return; }

      // 옮긴 노트를 바로 들려줌
      const now = getAudioCtx().currentTime;
      plannedMoves.forEach(m => {
        if (m.fret === 'X') {
          playPercussiveMute(now);
        } else {
          const midi = TUNING[m.string] + m.fret;
          playTone(midi, now, 0.4);
        }
      });

      setSelectedNotes(plannedMoves);
      setScore(prev => {
        const newScore = cloneScore(prev);
        selectedNotes.forEach(sel => {
          const beat = newScore[sel.mIndex].beats.find(b => b.time === sel.time);
          if (beat) delete beat.notes[sel.string];
        });
        plannedMoves.forEach(m => {
          const beat = newScore[m.mIndex].beats.find(b => b.time === m.time);
          if (beat) beat.notes[m.string] = m.fret;
        });
        return newScore;
      });
      return;
    }

    // Ctrl + ↑ ↓: 같은 음을 다른 줄로 옮김 (자리가 있으면 건너뜀, 0프렛 아래면 한 옥타브 올림)
    if (e.ctrlKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const stringDelta = e.key === 'ArrowUp' ? -1 : 1; 
      
      let canMove = true;
      let errorMessage = "";
      const plannedMoves = [];

      const sortedSelected = [...selectedNotes].sort((a, b) => stringDelta > 0 ? b.string - a.string : a.string - b.string);
      const beatState = {}; 

      sortedSelected.forEach(sel => {
        const key = `${sel.mIndex}-${sel.time}`;
        if (!beatState[key]) {
          const measure = score[sel.mIndex];
          const beat = measure && measure.beats.find(b => b.time === sel.time);
          beatState[key] = beat ? { ...beat.notes } : {};
          selectedNotes.forEach(s => {
            if (s.mIndex === sel.mIndex && s.time === sel.time) delete beatState[key][s.string];
          });
        }

        let bestString = null;
        // 이동하려는 방향(stringDelta)으로 빈 줄을 찾을 때까지 한 칸씩 전진
        for (let s = sel.string + stringDelta; s >= 1 && s <= 6; s += stringDelta) {
          if (beatState[key][s] === undefined) {
            bestString = s;
            break;
          }
        }

        if (bestString === null) {
          canMove = false; errorMessage = "더 이상 이동할 빈 줄이 없습니다."; return;
        }

        let newFret = sel.fret;
        if (newFret !== 'X') {
          const currentPitch = TUNING[sel.string] + sel.fret;
          newFret = currentPitch - TUNING[bestString];
          
          // 0프렛 미만으로 감소하면 0 이상이 될 때까지 12프렛(1옥타브) 단위로 덧셈
          while (newFret < 0) {
            newFret += 12;
          }
        }

        beatState[key][bestString] = newFret;
        plannedMoves.push({ ...sel, string: bestString, fret: newFret });
      });

      if (!canMove) { showStatus(errorMessage, true); return; }

      const now = getAudioCtx().currentTime;
      plannedMoves.forEach(m => {
        if (m.fret === 'X') {
          playPercussiveMute(now);
        } else {
          const midi = TUNING[m.string] + m.fret;
          playTone(midi, now, 0.4);
        }
      });

      setSelectedNotes(plannedMoves);
      setScore(prev => {
        const newScore = cloneScore(prev);
        selectedNotes.forEach(sel => {
          const beat = newScore[sel.mIndex].beats.find(b => b.time === sel.time);
          if (beat) delete beat.notes[sel.string];
        });
        plannedMoves.forEach(m => {
          const beat = newScore[m.mIndex].beats.find(b => b.time === m.time);
          if (beat) beat.notes[m.string] = m.fret;
        });
        return newScore;
      });
      return;
    }

    
    // - / =: 선택된 노트 길이 조절 (리플 편집)
    if (e.key === '-' || e.key === '=') {
      const stepChange = e.key === '=' ? 1 : -1;
      applyRippleDurations((b) => {
        let currentDurIdx = DURATION_STEPS.findIndex(d => d === b.duration || d * 1.5 === b.duration);
        if (currentDurIdx === -1) currentDurIdx = durIdx;
        const nextDurIdx = currentDurIdx + stepChange;

        // 방어 2: 가장 짧은/긴 박자 제한
        if (nextDurIdx < 0) return { error: "가장 짧은 박자 제한에 도달하여 더 이상 줄일 수 없습니다." };
        if (nextDurIdx >= DURATION_STEPS.length) return { error: "더 이상 박자를 늘릴 수 없습니다." };
        return DURATION_STEPS[nextDurIdx] * (isDotted ? 1.5 : 1);
      }, { syncDurIdx: true });
      return;
    }
  };

  
  // 2. 기호 모드 (SYMBOL) 컨트롤러
  const handleSymbolModeInput = (e) => {
    const key = e.key;
    // 숫자 1~6을 누르면 해당 줄에 뮤트(X) 기호 추가
    if (['1', '2', '3', '4', '5', '6'].includes(key)) {
      const stringNum = parseInt(key, 10);
      setScore(prev => {
        const newScore = cloneScore(prev);
        ensureMeasures(newScore, cursor.mIndex);
        const cMeasure = newScore[cursor.mIndex];

        // 마디 끝을 넘지 않도록 길이 제한
        const duration = Math.min(currentStep, measureLength(cMeasure) - cursor.time);
        let beat = cMeasure.beats.find(b => b.time === cursor.time);
        if (!beat) {
          beat = { time: cursor.time, duration, notes: {} };
          cMeasure.beats.push(beat);
        }
        
        beat.notes[stringNum] = 'X';
        return newScore;
      });
    }
  };

  const handleKeyDown = useCallback((e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    // 단축키 안내가 열려 있으면 Esc로 닫기만 하고 편집 키는 막음
    if (isHelpOpen) {
      if (e.key === 'Escape') setIsHelpOpen(false);
      return;
    }

    // 스페이스바: 재생 / 녹음 / 정지 토글
    if (e.key === ' ') {
      e.preventDefault();
      // 키보드(Tab)로 버튼에 포커스가 가 있어도 그 버튼이 눌리지 않게 함
      if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
      if (playbackState === 'PLAYING' || playbackState === 'RECORDING') {
        handleStop();
      } else {
        handlePlay('MEASURE');
      }
      return;
    }

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
    
    // 모드 전환
    if (e.key === '`') {
      e.preventDefault();
      changeMode(editorMode === 'SELECT' ? 'INPUT' : 'SELECT');
      return;
    }
    if (e.key === ']') {
      e.preventDefault();
      changeMode(editorMode === 'SYMBOL' ? 'INPUT' : 'SYMBOL');
      return;
    }

    // 모드별 분기
    if (editorMode === 'SELECT') {
      handleSelectModeInput(e);
      return;
    }
    if (editorMode === 'SYMBOL') {
      handleSymbolModeInput(e);
      return;
    }

    // 입력 모드: 음 입력과 커서 이동
    const key = e.key.toLowerCase();
    
    // 화면 스크롤 방지
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();

    // Shift: 한 옥타브 아래로 입력 켜기/끄기
    if (e.key === 'Shift') {
      e.preventDefault();
      setIsOctaveDown(prev => !prev);
      return;
    }

    if (PIANO_MAP[key] !== undefined && !e.repeat) {
      // 녹음 모드일 때 첫 건반을 누른 순간의 "정확한 시간"을 측정하여 퀀타이즈(스냅)
      if (playbackState === 'RECORDING' && chordAccumulatorRef.current.size === 0) {
        // 사용자는 출력 지연만큼 늦게 들리는 메트로놈에 맞춰 누르므로 지연을 빼고 계산
        const elapsedSec = getAudioCtx().currentTime - getOutputLatency() - recordingStartTimeRef.current;
        const elapsedTicks = elapsedSec > 0 ? elapsedSec / (60 / bpm / TPQ) : 0; // 카운트인 종료 이후

        // 마디 시작을 기준으로 입력 단위(step) 그리드에 가장 가까운 곳으로 반올림
        const pressAbs = recordingStartAbsRef.current + elapsedTicks;
        const pos = fromAbs(score, Math.floor(pressAbs));
        const snapped = Math.round((pos.time + (pressAbs - Math.floor(pressAbs))) / currentStep) * currentStep;

        lastRecordPressTimeRef.current = snapped >= measureLengthAt(score, pos.mIndex)
          ? { mIndex: pos.mIndex + 1, time: 0 }
          : { mIndex: pos.mIndex, time: snapped };
      }

      activeKeysRef.current.add(key);
      chordAccumulatorRef.current.add(key);
      setActiveUIKeys(new Set(activeKeysRef.current));

      // 키를 누르는 즉시 소리로 확인
      let midi = PIANO_MAP[key];
      if (isOctaveDown) midi -= 12;

      if (midi >= 40) {
        playTone(midi, getAudioCtx().currentTime, 0.4);
      }
      return;
    }

    // - / = 또는 ↓ / ↑: 입력 길이 조절
    if (key === '-' || e.key === 'ArrowDown') setDurIdx(p => Math.max(0, p - 1));
    if (key === '=' || e.key === 'ArrowUp') setDurIdx(p => Math.min(DURATION_STEPS.length - 1, p + 1));
    if (key === '\\') setIsDotted(p => !p);

    if (e.key === 'Delete' || e.key === 'Backspace') {
      setScore(prev => {
        const newScore = cloneScore(prev);
        const measure = newScore[cursor.mIndex];
        if (!measure) return newScore;

        const beatIndex = measure.beats.findIndex(b => b.time === cursor.time);
        if (beatIndex !== -1) {
          const targetTieId = measure.beats[beatIndex].tieId;
          measure.beats.splice(beatIndex, 1); 
          if (targetTieId) {
            newScore.forEach(m => { m.beats = m.beats.filter(b => b.tieId !== targetTieId); });
          }
        }
        return newScore;
      });
    }

    if (e.key === 'ArrowRight') {
      const next = moveCursor(score, cursor, currentStep);
      // 커서가 악보 끝을 넘어가면 마디를 새로 만듦 (마지막 마디의 박자표를 이어받음)
      setScore(prev => (next.mIndex >= prev.length ? ensureMeasures(cloneScore(prev), next.mIndex) : prev));
      setCursor(next);
    }

    if (e.key === 'ArrowLeft') {
      setCursor(moveCursor(score, cursor, -currentStep));
    }
  }, [score, cursor, durIdx, isDotted, currentStep, bpm, isOctaveDown, editorMode, selectedNotes, playbackState, handlePlay, handleStop, isHelpOpen]);

  const handleKeyUp = useCallback((e) => {
    const key = e.key.toLowerCase();
    if (PIANO_MAP[key] !== undefined) {
      activeKeysRef.current.delete(key);
      setActiveUIKeys(new Set(activeKeysRef.current));

      if (activeKeysRef.current.size === 0 && chordAccumulatorRef.current.size > 0) {
        const keysToProcess = new Set(chordAccumulatorRef.current);
        chordAccumulatorRef.current.clear(); 
        
        // 녹음 중일 땐 퀀타이즈된 시간으로 전달, 아닐 땐 일반 입력
        if (playbackState === 'RECORDING' && lastRecordPressTimeRef.current) {
           insertChord(keysToProcess, lastRecordPressTimeRef.current);
           lastRecordPressTimeRef.current = null;
        } else {
           insertChord(keysToProcess);
        }
      }
    }
  }, [score, cursor, currentStep, isOctaveDown, playbackState]);

  // 버튼을 마우스로 눌러도 포커스를 가져가지 않게 함 (클릭은 그대로 동작)
  //    포커스가 남아 있으면 스페이스바를 눌렀을 때 그 버튼이 다시 눌리는 문제가 있었음
  useEffect(() => {
    const keepFocusOff = (e) => { if (e.target.closest && e.target.closest('button')) e.preventDefault(); };
    document.addEventListener('mousedown', keepFocusOff, true);
    return () => document.removeEventListener('mousedown', keepFocusOff, true);
  }, []);

  // 키보드 이벤트 등록
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);

  const PianoKey = ({ whiteLabel, blackLabel }) => {
    const wKey = whiteLabel.toLowerCase();
    const bKey = blackLabel?.toLowerCase();
    return (
      <div className={`piano-key${activeUIKeys.has(wKey) ? ' down' : ''}`}>
        {whiteLabel.toUpperCase()}
        {blackLabel && (
          <div className={`black${bKey && activeUIKeys.has(bKey) ? ' down' : ''}`}>{blackLabel.toUpperCase()}</div>
        )}
      </div>
    );
  };

  const isSelectMode = editorMode === 'SELECT';
  const isRecording = playbackState === 'RECORDING';
  const cursorBeat = Math.round((cursor.time / beatUnitTicks(cursorTimeSig) + 1) * 100) / 100;

  return (
    <div className="app">

      {/* 도구 줄 */}
      <div className="toolbar" role="toolbar" aria-label="편집 도구">

        <div className="tool-group">
          <div className="seg" role="group" aria-label="편집 모드">
            {MODES.map(m => (
              <button key={m.id} aria-pressed={editorMode === m.id} onClick={() => changeMode(m.id)}
                title={`${m.label} 모드 (${m.key})`}>{m.label}</button>
            ))}
          </div>
        </div>

        <div className="tool-group" role="group" aria-label="재생">
          <button className="tbtn" onClick={() => handlePlay('ALL')} title="처음부터 재생"><IconPlayFromStart /></button>
          <button className="tbtn" onClick={() => handlePlay('MEASURE')} title="커서가 있는 마디부터 재생 (Space)"><IconPlayMeasure /></button>
          <button className="tbtn" onClick={() => handlePlay('CURSOR')} title="커서 위치부터 재생"><IconPlay /></button>
          <button className={`tbtn${isRecording ? ' is-recording' : ''}`} onClick={() => handlePlay('RECORD')}
            title="커서가 있는 마디부터 실시간 녹음 (한 마디 카운트인)"><IconRecord /></button>
          <button className="tbtn" onClick={handleStop} title="정지 (Space)"><IconStop /></button>
          <button className="tbtn" aria-pressed={isMetronome} onClick={() => setIsMetronome(!isMetronome)} title="메트로놈 켜기/끄기"><IconMetronome /></button>
        </div>

        <div className="tool-group">
          <span className="tool-label">BPM</span>
          <input
            className="field bpm"
            type="number"
            value={bpm}
            onChange={(e) => setBpm(Number(e.target.value))}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
            aria-label="BPM"
          />
          <span className="tool-label" style={{ marginLeft: '8px' }} title="커서가 있는 마디부터 끝까지 적용">박자</span>
          <select
            className="field"
            value={cursorTimeSig.num}
            onChange={(e) => { handleTimeSigChange(Number(e.target.value), cursorTimeSig.den); e.target.blur(); }}
            aria-label="박자표 분자"
          >
            {Array.from({ length: MAX_TIME_SIG_NUM }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>/</span>
          <select
            className="field"
            value={cursorTimeSig.den}
            onChange={(e) => { handleTimeSigChange(cursorTimeSig.num, Number(e.target.value)); e.target.blur(); }}
            aria-label="박자표 분모"
          >
            {TIME_SIG_DENOMINATORS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>

        {/* 선택 모드에서만 쓰는 편집 (한 번 누르면 한 번 실행) */}
        <div className="tool-group" role="group" aria-label="선택한 노트 편집">
          <button className="tbtn" onClick={handleSetSelectedLength} disabled={!isSelectMode}
            title={`선택한 노트 길이를 현재 박자(${formatBeats(currentStep)}박)로 맞추고 뒤 노트를 당기거나 밂 (선택 모드)`}>
            <IconSetLength />{formatBeats(currentStep)}박으로
          </button>
          <button className="tbtn" onClick={handleExtendToNextNote} disabled={!isSelectMode}
            title="선택한 노트를 다음 노트가 있는 위치까지 늘림 (선택 모드)">
            <IconExtend />다음 노트까지
          </button>
        </div>

        <div className="tool-group">
          <div className="seg" role="group" aria-label="음색">
            <button aria-pressed={toneMode === TONE_BASIC} onClick={() => setToneModeState(TONE_BASIC)} title="음색: 삼각파">삼각파</button>
            <button aria-pressed={toneMode === TONE_PLUCK} onClick={() => setToneModeState(TONE_PLUCK)} title="음색: 기타음">기타음</button>
          </div>
          {/* 톤과 EQ는 기타음에만 적용되므로 그때만 보여줌 */}
          {toneMode === TONE_PLUCK && (
            <>
              <label className="tool-label" style={{ display: 'flex', alignItems: 'center', gap: '4px', marginLeft: '6px' }}
                title="톤: 기타음의 고음 차단 (왼쪽일수록 먹먹)">
                톤
                <input className="tone-range" type="range" min="0" max="100" value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                  onPointerUp={(e) => e.currentTarget.blur()} />
              </label>
              <Knob label="L" title="Low (200Hz 이하)" value={eq.low} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={DEFAULT_EQ.low}
                onChange={(v) => setEqState(p => ({ ...p, low: v }))} />
              <Knob label="M" title="Mid (800Hz 부근)" value={eq.mid} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={DEFAULT_EQ.mid}
                onChange={(v) => setEqState(p => ({ ...p, mid: v }))} />
              <Knob label="H" title="High (2.5kHz 이상)" value={eq.high} min={EQ_MIN_DB} max={EQ_MAX_DB} defaultValue={DEFAULT_EQ.high}
                onChange={(v) => setEqState(p => ({ ...p, high: v }))} />
            </>
          )}
        </div>

        <div className="spacer" />

        <div className="tool-group" role="group" aria-label="파일">
          <label className="tbtn" title="저장해 둔 악보 파일(JSON) 열기">
            <IconOpen />
            <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportJSON} />
          </label>
          <button className="tbtn" onClick={handleExportJSON} title="악보를 파일(JSON)로 저장"><IconSave /></button>
          <button className="tbtn" onClick={handleResetScore} title="새 악보 (지금 악보를 지우고 새로 시작)"><IconNew /></button>
        </div>

        <div className="tool-group end">
          <button className="tbtn" onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
            title={theme === 'dark' ? '밝은 화면으로' : '어두운 화면으로'}>
            {theme === 'dark' ? <IconSun /> : <IconMoon />}
          </button>
          <button className="tbtn" onClick={() => setIsHelpOpen(true)} title="단축키 안내"><IconHelp /></button>
        </div>
      </div>

      {/* 작업 영역: 회색 바탕 위의 악보 종이 */}
      <div className="workspace">
        <div className="page" ref={scoreAreaRef}>
          <div ref={playheadRef} className="playhead" style={{ height: `${PLAYHEAD_HEIGHT}px` }} />

          {layout.map((lineChunks, lineIdx) => (
            <div key={`line-${lineIdx}`} className="score-line">

              {/* 줄 머리: 시스템 시작 세로줄 + TAB 표시 */}
              <svg width={CLEF_WIDTH} height={HEIGHT} aria-hidden="true">
                {[...Array(STRING_COUNT)].map((_, i) => (
                  <line key={i} x1="0" y1={TOP_PADDING + i * STRING_SPACING} x2={CLEF_WIDTH} y2={TOP_PADDING + i * STRING_SPACING} style={{ stroke: 'var(--staff)' }} strokeWidth="1" />
                ))}
                <line x1="0.75" y1={TOP_PADDING} x2="0.75" y2={TOP_PADDING + STRING_SPACING * 5} style={{ stroke: 'var(--ink)' }} strokeWidth="1.5" />
                {/* 글자마다 그 자리의 줄만 종이색으로 지움 */}
                {['T', 'A', 'B'].map((ch, i) => (
                  <g key={ch}>
                    <rect x="9" y={TOP_PADDING + 20 + i * 22} width="14" height="16" style={{ fill: 'var(--page)' }} />
                    <text x="16" y={TOP_PADDING + 33 + i * 22} textAnchor="middle" fontSize="17" fontWeight="700"
                      style={{ fill: 'var(--ink)', fontFamily: FRET_FONT }}>{ch}</text>
                  </g>
                ))}
              </svg>

              {lineChunks.map((chunk, chunkIdx) => {
                const svgWidth = chunk.width * UNIT;
                const timeRange = chunk.timeEnd - chunk.timeStart;
                const isCursorHere = cursor.mIndex === chunk.mIndex && cursor.time >= chunk.timeStart && cursor.time < chunk.timeEnd;
                const innerWidth = svgWidth - (SIDE_PADDING * 2);
                let cursorX = 0;
                if (isCursorHere) cursorX = SIDE_PADDING + ((cursor.time - chunk.timeStart) / timeRange) * innerWidth;
                const startsMeasure = chunk.type === 'full' || chunk.type === 'start';
                const endsMeasure = chunk.type === 'full' || chunk.type === 'end';

                return (
                  <svg
                    key={`chunk-${chunk.measureId}-${chunkIdx}`}
                    ref={(el) => {
                      const k = `${lineIdx}-${chunkIdx}`;
                      if (el) chunkElsRef.current[k] = el; else delete chunkElsRef.current[k];
                    }}
                    width={svgWidth}
                    height={HEIGHT}
                    style={{ overflow: 'visible', cursor: editorMode === 'INPUT' ? 'pointer' : 'default' }}
                    onClick={(e) => {
                      // 입력 모드에서만 클릭으로 커서 이동
                      if (editorMode !== 'INPUT') return;

                      const rect = e.currentTarget.getBoundingClientRect();
                      const clickX = e.clientX - rect.left;

                      let timeRatio = (clickX - SIDE_PADDING) / innerWidth;
                      if (timeRatio < 0) timeRatio = 0;
                      if (timeRatio > 0.999) timeRatio = 0.999;

                      // 설정된 박자 단위(step)에 맞춰 내림 연산 후 스냅
                      const exactTime = chunk.timeStart + timeRatio * timeRange;
                      setCursor({ mIndex: chunk.mIndex, time: Math.floor(exactTime / currentStep) * currentStep });
                    }}
                  >
                    {[...Array(STRING_COUNT)].map((_, i) => (
                      <line key={i} x1="0" y1={TOP_PADDING + i * STRING_SPACING} x2={svgWidth} y2={TOP_PADDING + i * STRING_SPACING} style={{ stroke: 'var(--staff)' }} strokeWidth="1" />
                    ))}

                    {endsMeasure && <line x1={svgWidth} y1={TOP_PADDING} x2={svgWidth} y2={TOP_PADDING + STRING_SPACING * 5} style={{ stroke: 'var(--ink)' }} strokeWidth="1.2" />}

                    {/* 마디 번호 */}
                    {startsMeasure && (
                      <text x="2" y={TOP_PADDING - 8} fontSize="10" fontStyle="italic" style={{ fill: 'var(--muted)' }}>{chunk.mIndex + 1}</text>
                    )}

                    {/* 박자표 (첫 마디 또는 박자가 바뀌는 마디): 분자 위, 분모 아래로 겹쳐 씀 */}
                    {chunk.showTimeSig && (
                      <g style={{ fill: 'var(--ink)', fontFamily: FRET_FONT }} fontWeight="700" fontSize="11" textAnchor="middle">
                        <text x={SIDE_PADDING} y={TOP_PADDING - 21}>{chunk.timeSig.num}</text>
                        <text x={SIDE_PADDING} y={TOP_PADDING - 10}>{chunk.timeSig.den}</text>
                      </g>
                    )}

                    {isCursorHere && <rect x={cursorX - 9} y={TOP_PADDING - 7} width="18" height={STRING_SPACING * 5 + 19} style={{ fill: 'var(--accent-soft)' }} />}

                    {chunk.beats.map((beat, bIdx) => {
                      const xPos = SIDE_PADDING + ((beat.time - chunk.timeStart) / timeRange) * innerWidth;
                      return (
                        <g key={bIdx}>
                          {Object.entries(beat.notes).map(([string, fret]) => {
                            const strIdx = parseInt(string, 10) - 1;
                            const yPos = TOP_PADDING + strIdx * STRING_SPACING;

                            const tie = tieInfo[`${chunk.mIndex}-${beat.time}`];
                            const isTieStart = !!(tie && tie.hasNext); // 다음 조각으로 이어짐
                            const isTieEnd = !!(tie && tie.hasPrev);   // 앞 조각에서 이어져 옴

                            const isLastChunk = chunkIdx === lineChunks.length - 1;
                            const isFirstChunk = chunkIdx === 0;
                            const isSelected = selectedNotes.some(sel => sel.mIndex === chunk.mIndex && sel.time === beat.time && sel.string === strIdx + 1);
                            const tieStyle = { stroke: 'var(--ink)', fill: 'none' };
                            const label = String(fret);
                            const boxW = label.length > 1 ? 16 : 11;

                            return (
                              <g key={string}>
                                {/* 붙임줄: 같은 줄 안에서 다음 마디로 */}
                                {isTieStart && !isLastChunk && (
                                  <path d={`M ${xPos + 6} ${yPos + 10} Q ${(xPos + svgWidth + SIDE_PADDING) / 2} ${yPos + 20} ${svgWidth + SIDE_PADDING - 6} ${yPos + 10}`}
                                    style={tieStyle} strokeWidth="1.2" strokeLinecap="round" />
                                )}
                                {/* 붙임줄: 줄 끝에서 다음 줄로 나감 */}
                                {isTieStart && isLastChunk && (
                                  <path d={`M ${xPos + 6} ${yPos + 10} Q ${xPos + 30} ${yPos + 19} ${svgWidth + 15} ${yPos + 16}`}
                                    style={tieStyle} strokeWidth="1.2" strokeLinecap="round" />
                                )}
                                {/* 붙임줄: 앞 줄에서 들어옴 */}
                                {isTieEnd && isFirstChunk && (
                                  <path d={`M -15 ${yPos + 16} Q ${xPos - 30} ${yPos + 19} ${xPos - 6} ${yPos + 10}`}
                                    style={tieStyle} strokeWidth="1.2" strokeLinecap="round" />
                                )}

                                {/* 프렛 번호: 뒤의 줄을 종이색으로 지우고 씀 (선택 시 반전) */}
                                <rect x={xPos - boxW / 2} y={yPos - 7} width={boxW} height="14" rx="1.5"
                                  style={{ fill: isSelected ? 'var(--accent)' : 'var(--page)' }} />
                                <text x={xPos} y={yPos + 4.5} fontSize="13" fontWeight="600" textAnchor="middle"
                                  style={{ fill: isSelected ? 'var(--accent-text)' : 'var(--ink)', fontFamily: FRET_FONT }}>
                                  {label}
                                </text>
                              </g>
                            );
                          })}
                        </g>
                      );
                    })}
                  </svg>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* 상태 줄 + 건반 */}
      <div className="statusbar">
        <div className="status-row">
          <span className="status-cell">모드 <b>{MODES.find(m => m.id === editorMode).label}</b></span>
          <span className="status-cell">{MODE_HINTS[editorMode]}</span>
          <span className="status-cell">길이 <b>{formatBeats(currentStep)}박</b> <kbd>-</kbd><kbd>=</kbd></span>
          <span className={`status-cell${isDotted ? ' on' : ''}`}>점음표 <b>{isDotted ? '켬' : '끔'}</b> <kbd>\</kbd></span>
          <span className={`status-cell${isOctaveDown ? ' on' : ''}`}>한 옥타브 아래 <b>{isOctaveDown ? '켬' : '끔'}</b> <kbd>Shift</kbd></span>
          <span className="status-cell">위치 <b>{cursor.mIndex + 1}마디 {cursorBeat}박</b></span>
          <span className={`status-msg${status && status.isError ? ' error' : ''}`} role="status" aria-live="polite">
            {status ? status.text : ''}
          </span>
        </div>

        <div className="keyboard" aria-hidden="true">
          <div className="key-row">
            {TOP_ROW.map((keyData) => <PianoKey key={keyData.w} whiteLabel={keyData.w} blackLabel={keyData.b} />)}
          </div>
          <div className="key-row">
            {BOTTOM_ROW.map((keyData) => <PianoKey key={keyData.w} whiteLabel={keyData.w} blackLabel={keyData.b} />)}
          </div>
        </div>
      </div>

      {/* 단축키 안내 */}
      {isHelpOpen && (
        <div className="sheet-backdrop" onClick={() => setIsHelpOpen(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="단축키 안내" tabIndex={-1} autoFocus onClick={e => e.stopPropagation()}>
            <h2>단축키</h2>

            <h3>입력 모드</h3>
            <table><tbody>
              <tr><td><kbd>Z</kbd> ~ <kbd>/</kbd></td><td>아래쪽 건반 (C3부터)</td></tr>
              <tr><td><kbd>Q</kbd> ~ <kbd>P</kbd></td><td>위쪽 건반 (C4부터)</td></tr>
              <tr><td><kbd>-</kbd> <kbd>=</kbd> 또는 <kbd>↓</kbd> <kbd>↑</kbd></td><td>입력 길이 바꾸기</td></tr>
              <tr><td><kbd>\</kbd></td><td>점음표 켜기/끄기</td></tr>
              <tr><td><kbd>Shift</kbd></td><td>한 옥타브 아래로 입력 켜기/끄기</td></tr>
              <tr><td><kbd>←</kbd> <kbd>→</kbd>, 클릭</td><td>커서 이동</td></tr>
              <tr><td><kbd>Del</kbd> <kbd>Backspace</kbd></td><td>커서 위치의 노트 지우기</td></tr>
            </tbody></table>

            <h3>선택 모드 (<kbd>`</kbd>로 들어가고 나옴)</h3>
            <table><tbody>
              <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>다음/이전 노트 선택, <kbd>Shift</kbd>와 함께 누르면 여러 개 선택</td></tr>
              <tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>반음씩 올리고 내리기 (자리가 없으면 다른 줄로)</td></tr>
              <tr><td><kbd>Shift</kbd>+<kbd>↑</kbd> <kbd>↓</kbd></td><td>한 옥타브 올리고 내리기</td></tr>
              <tr><td><kbd>Ctrl</kbd>+<kbd>↑</kbd> <kbd>↓</kbd></td><td>같은 음을 다른 줄로 옮기기</td></tr>
              <tr><td><kbd>-</kbd> <kbd>=</kbd></td><td>길이 바꾸기 (뒤 노트가 따라 움직임)</td></tr>
              <tr><td>{formatBeats(currentStep)}박으로 버튼</td><td>선택한 노트를 현재 입력 길이로 맞추기</td></tr>
              <tr><td>다음 노트까지 버튼</td><td>다음 노트가 나올 때까지 늘리기 (화음은 선택한 음만)</td></tr>
              <tr><td><kbd>Del</kbd> <kbd>Backspace</kbd></td><td>선택한 노트 지우기</td></tr>
            </tbody></table>

            <h3>기호 모드 (<kbd>]</kbd>로 들어가고 나옴)</h3>
            <table><tbody>
              <tr><td><kbd>1</kbd> ~ <kbd>6</kbd></td><td>해당 줄에 뮤트(X)</td></tr>
            </tbody></table>

            <h3>재생</h3>
            <table><tbody>
              <tr><td><kbd>Space</kbd></td><td>커서가 있는 마디부터 재생, 다시 누르면 정지</td></tr>
            </tbody></table>

            <div className="close-row">
              <button className="tbtn" onClick={() => setIsHelpOpen(false)}>닫기 <kbd>Esc</kbd></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}