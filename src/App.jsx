import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  IconPlayFromStart, IconPlayMeasure, IconPlay, IconRecord, IconStop, IconMetronome,
  IconSetLength, IconExtend, IconOpen, IconSave, IconNew, IconSun, IconMoon, IconHelp, IconMidi,
} from './components/Icons';
import { parseMidi, summarizeTrack, countMeasures, pitchName } from './lib/midiImport';
import { VIEW_STAFF, VIEW_BOTH, VIEW_TAB, DEFAULT_NOTATION, pitchLabel, timeToX } from './lib/notation';
import ScoreView, { findMeasure, measureSpanY } from './components/ScoreView';
import PianoRoll from './components/PianoRoll';
import { buildScoreTimeline, measureTime, measureAt } from './lib/tutorial';
import {
  getAudioCtx, getOutputLatency, resumeAudioCtx, createBus, stopBus,
  playTone, playPercussiveMute, playMetronomeClick, releaseVoice,
  setToneMode, TONE_BASIC, TONE_PLUCK, setPluckBrightness, DEFAULT_PLUCK_BRIGHTNESS,
  setEq, DEFAULT_EQ, EQ_MIN_DB, EQ_MAX_DB,
} from './lib/audio';
import {
  TPQ, DURATION_STEPS, TIME_SIG_DENOMINATORS, MAX_TIME_SIG_NUM,
  getTimeSig, timeSigLength, beatUnitTicks, measureLength, measureLengthAt, timeSigAt,
  makeMeasure, createEmptyScore, cloneScore, ensureMeasures,
  buildMeasureStarts, toAbs, fromAbs, moveCursor, splitSpanByMeasures,
  loadScoreData, serializeScore, formatBeats,
} from './lib/scoreModel';
import { STANDARD_TUNING as TUNING, LOWEST_PITCH, noteOnString, lowestFretString, noteId, findNoteById, assignStrings } from './lib/guitar';
import { PIANO_LOWEST, PIANO_HIGHEST } from './lib/tutorial';

// --- 상수 모음 ---
const DEFAULT_BPM = 120;
const STORAGE_KEY = 'tabEditorScore';


// 재생 스케줄링: 소리는 이 시간만큼 앞서서만 예약 (긴 곡도 한꺼번에 예약하지 않음)
const SCHEDULE_LOOKAHEAD_SEC = 1.5;
const SCHEDULE_INTERVAL_MS = 100;

// 스트럼: 재생 시 화음을 6번줄 → 1번줄 순서(다운스트로크)로 조금씩 늦게 침
const STRUM_STEP_SEC = 0.012;     // 줄 사이 간격
const STRUM_MAX_RATIO = 0.4;      // 전체 스트럼이 음 길이의 이 비율을 넘지 않게 (빠른 패시지 보호)
const TONE_STORAGE_KEY = 'tabEditorTone';
const BRIGHTNESS_STORAGE_KEY = 'tabEditorToneBrightness';
const EQ_STORAGE_KEY = 'tabEditorEq';

const THEME_STORAGE_KEY = 'tabEditorTheme';
const VIEW_STORAGE_KEY = 'tabEditorView';

const VIEW_TUTORIAL = 'tutorial'; // 튜토: 악보를 피아노 튜토리얼로 (편집 없음, 악보에 음이 있을 때만)
const VIEWS = [
  { id: VIEW_STAFF, label: '오선보' },
  { id: VIEW_BOTH, label: '둘 다' },
  { id: VIEW_TAB, label: 'TAB' },
  { id: VIEW_TUTORIAL, label: '튜토' },
];
const loadView = () => {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    if (VIEWS.some(v => v.id === saved)) return saved;
  } catch { /* 저장된 값 없음 */ }
  return VIEW_BOTH;
};

// 오선보 종류: 높은음(기타 관례) / 큰보표(피아노). 큰보표는 나누는 음 이상이 위 줄
const NOTATION_STORAGE_KEY = 'tabEditorNotation';
const SPLIT_CHOICES = Array.from({ length: 72 - 36 + 1 }, (_, i) => 72 - i); // C5 ~ C2 (높은 음부터)
const loadNotation = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTATION_STORAGE_KEY));
    if (saved && typeof saved.grand === 'boolean' && SPLIT_CHOICES.includes(saved.split)) return saved;
  } catch { /* 저장된 값 없음 */ }
  return DEFAULT_NOTATION;
};
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
      // 읽을 수 없는 형식(예: 더 새 버전에서 저장한 캐시)은 빈 악보로 덮어쓰기 전에 따로 보관
      localStorage.setItem(`${STORAGE_KEY}.unreadable`, saved);
    }
  } catch (e) {
    console.error("캐시 데이터를 읽는 중 오류가 발생했습니다.", e);
  }
  return { measures: createEmptyScore(), bpm: null, source: null, instrument: 'guitar' };
};

const GUITAR_MAX_NOTES = 6; // 기타가 동시에 낼 수 있는 최대 음 수 (원곡 표에서 넘는 트랙을 표시)

// 초 → '1:04'
const formatDuration = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

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

// 원곡(MIDI에서 가져온 음) 정보: 제목, 템포, 박자, 길이, 트랙 표
const SourcePanel = ({ source, onClear }) => {
  const firstTempo = source.tempos[0].bpm;
  const firstSig = source.timeSignatures[0];
  const tempoChanges = source.tempos.length - 1;
  const sigChanges = source.timeSignatures.length - 1;

  return (
    <section className="source-panel" aria-label="원곡">
      <div className="source-head">
        <span className="source-title">원곡 <b>{source.title}</b></span>
        <span>템포 <b>{firstTempo}</b>{tempoChanges > 0 && ` (${tempoChanges}번 바뀜)`}</span>
        <span>박자 <b>{firstSig.num}/{firstSig.den}</b>{sigChanges > 0 && ` (${sigChanges}번 바뀜)`}</span>
        <span>길이 <b>{countMeasures(source)}마디</b>, {formatDuration(source.durationSec)}</span>
        <span className="spacer" />
        <button className="tbtn" onClick={onClear}>원곡 지우기</button>
      </div>
      <table className="source-tracks">
        <thead>
          <tr><th>트랙</th><th>악기</th><th className="num">채널</th><th className="num">음 개수</th><th>음역</th><th className="num">동시 최대</th></tr>
        </thead>
        <tbody>
          {source.tracks.map(track => {
            const sum = summarizeTrack(track);
            const overGuitar = !track.isDrum && sum.maxPolyphony > GUITAR_MAX_NOTES;
            return (
              <tr key={track.id}>
                <td>{track.name}</td>
                <td>{track.isDrum ? '드럼' : track.instrument}</td>
                <td className="num">{track.channel}</td>
                <td className="num">{sum.noteCount}</td>
                <td>{track.isDrum ? '타악기' : `${pitchName(sum.lowest)} ~ ${pitchName(sum.highest)}`}</td>
                <td className={`num${overGuitar ? ' over' : ''}`}
                  title={overGuitar ? `기타는 동시에 최대 ${GUITAR_MAX_NOTES}음까지 낼 수 있습니다` : undefined}>
                  {sum.maxPolyphony}음
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
};

// 음의 실제 높이 (뮤트는 그 줄의 개방현)
const soundOf = (n) => (n.mute ? TUNING[n.string] : n.pitch);

// 악보의 모든 노트를 (마디, 위치, 줄) 순으로 펼친 목록
const collectAllNotes = (score) => {
  const allNotes = [];
  score.forEach((measure, mIndex) => {
    measure.beats.forEach((beat) => {
      beat.notes.forEach((note) => {
        allNotes.push({ mIndex, time: beat.time, id: noteId(note), string: note.string, pitch: note.pitch, mute: !!note.mute, duration: beat.duration });
      });
    });
  });
  allNotes.sort((a, b) => {
    if (a.mIndex !== b.mIndex) return a.mIndex - b.mIndex;
    if (a.time !== b.time) return a.time - b.time;
    // 한 비트 안: 가는 줄(높은 음)부터. 줄이 없는 음은 음 높이로
    if (a.string != null && b.string != null) return a.string - b.string;
    return soundOf(b) - soundOf(a);
  });
  return allNotes;
};

export default function TabEditor() {
  // 캐시(localStorage)에서 악보와 BPM 불러오기 (구버전 데이터는 자동 변환)
  const [initialData] = useState(loadCachedData);
  const [score, setScore] = useState(initialData.measures);
  const [bpm, setBpm] = useState(initialData.bpm || DEFAULT_BPM);
  // MIDI에서 가져온 원곡. 기타 악보와 따로 보관하고, 가져오기는 기타 악보를 건드리지 않음
  const [source, setSource] = useState(initialData.source);
  // 악기: 기타는 E2 이상·한 박자 6음(줄 수)까지, TAB 있음 / 피아노는 제한 없음, 큰보표만 (Guitar Pro의 트랙 악기처럼)
  const [instrument, setInstrument] = useState(initialData.instrument || 'guitar');
  const isPiano = instrument === 'piano';

  // 악보나 BPM이 바뀔 때마다 자동으로 캐시에 저장
  // 원곡이 아주 크면 브라우저 저장 한도를 넘을 수 있으므로 실패해도 앱은 계속 동작
  const [cacheFull, setCacheFull] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeScore(score, bpm, source, instrument)));
      setCacheFull(false);
    } catch {
      setCacheFull(true);
    }
  }, [score, bpm, source, instrument]);
  const [editorMode, setEditorMode] = useState('INPUT'); // 'INPUT', 'SELECT', 'SYMBOL'
  const [selectedNotes, setSelectedNotes] = useState([]); // 선택된 노트 배열: [{ mIndex, time, id, string, pitch }] (id: guitar.js noteId)
  const [isDebugMode, setIsDebugMode] = useState(false); // 박자 시각화 토글
  
  const [cursor, setCursor] = useState({ mIndex: 0, time: 0 });
  const [durIdx, setDurIdx] = useState(2); 
  const [isDotted, setIsDotted] = useState(false);
  const [status, setStatus] = useState(null); // 상태 줄 메시지 { text, isError }
  const statusTimerRef = useRef(null);
  const [theme, setTheme] = useState(loadTheme);
  // 보기: 오선보만 / 둘 다 / TAB만
  const [view, setView] = useState(loadView);
  const [notation, setNotation] = useState(loadNotation);
  useEffect(() => {
    try { localStorage.setItem(NOTATION_STORAGE_KEY, JSON.stringify(notation)); } catch { /* 저장 불가 환경 */ }
  }, [notation]);
  // 튜토는 악보에 칠 음(뮤트 제외)이 하나라도 있어야 볼 수 있음
  const hasPitchedNotes = useMemo(() => score.some(m => m.beats.some(b => b.notes.some(n => !n.mute))), [score]);
  // 튜토를 골라 뒀어도 악보에 음이 없으면 악보 화면을 보여줌 (고른 값은 그대로 저장)
  const isTutorialView = view === VIEW_TUTORIAL && hasPitchedNotes;
  // 튜토: 악보를 초 단위 타임라인으로 (악보 BPM 기준). 편집 중엔 계산하지 않음
  const timeline = useMemo(() => (isTutorialView ? buildScoreTimeline(score, bpm) : null), [isTutorialView, score, bpm]);
  // 실제로 그릴 악보 보기: 튜토를 골랐으면 둘 다, 피아노는 TAB이 없으므로 오선보만
  const scoreView = isPiano ? VIEW_STAFF : (view === VIEW_TUTORIAL ? VIEW_BOTH : view);
  // 실제로 그릴 오선보 종류: 피아노는 큰보표 고정, 기타는 칠 수 없는 음을 빨간색으로
  const drawNotation = useMemo(() => (isPiano
    ? { grand: true, split: notation.split, markUnplaced: false }
    : { grand: notation.grand, split: notation.split, markUnplaced: true }), [isPiano, notation]);
  const rollRef = useRef(null); // PianoRoll 조작 손잡이 { getTime, setTime, START_TIME }
  // 튜토로 들어가면 커서가 있는 마디에서 시작 (첫 음이 건반 조금 위에서 떨어지도록 1초 앞)
  const TUTORIAL_LEAD_SEC = 1;
  const cursorMeasureRef = useRef(0);
  cursorMeasureRef.current = cursor.mIndex;
  useEffect(() => {
    const roll = rollRef.current;
    if (!isTutorialView || !roll || !timeline) return;
    const m = cursorMeasureRef.current;
    roll.setTime(m === 0 ? roll.START_TIME : measureTime(timeline, m) - TUTORIAL_LEAD_SEC);
  }, [isTutorialView, timeline]);
  useEffect(() => {
    try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch { /* 저장 불가 환경 */ }
  }, [view]);
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
  const lineElsRef = useRef([]);         // 악보 줄 DOM (진행 바 좌표 계산용)
  const engravingRef = useRef(null);     // 최신 악보 배치 결과 (notation.js의 engrave)
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
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(serializeScore(score, bpm, source, instrument), null, 2));
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
          setSource(data.source);
          setInstrument(data.instrument);
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
    if (window.confirm("지금 악보와 가져온 원곡을 지우고 새 악보를 시작할까요? 저장하지 않은 내용은 사라집니다.")) {
      setScore(createEmptyScore());
      setSource(null);
      setSelectedNotes([]);
      setCursor({ mIndex: 0, time: 0 });
      showStatus("새 악보를 시작했습니다.");
    }
  };

  // MIDI 파일 가져오기 → 원곡으로 보관 (기타 악보는 그대로)
  const handleImportMidi = async (e) => {
    const file = e.target.files[0];
    e.target.value = null; // 같은 파일을 다시 고를 수 있게
    e.target.blur();
    if (!file) return;

    let parsed;
    try {
      parsed = parseMidi(await file.arrayBuffer(), file.name);
    } catch (err) {
      showStatus(err.message === 'NO_NOTES'
        ? "이 MIDI 파일에는 음이 없습니다."
        : "MIDI 파일을 읽지 못했습니다. 파일이 손상됐거나 MIDI 형식이 아닙니다.", true);
      return;
    }

    if (source && !window.confirm(`지금 원곡(${source.title})을 ${parsed.title}(으)로 바꿀까요?`)) return;
    setSource(parsed);
    const noteCount = parsed.tracks.reduce((sum, t) => sum + t.notes.length, 0);
    showStatus(`원곡을 가져왔습니다: 트랙 ${parsed.tracks.length}개, 음 ${noteCount}개`);
  };

  const handleClearSource = () => {
    if (!window.confirm("가져온 원곡을 지울까요? 기타 악보는 그대로 남습니다.")) return;
    setSource(null);
    showStatus("원곡을 지웠습니다.");
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

  // 악기 전환
  //   기타 → 피아노: 음은 그대로, 줄 정보도 지우지 않음 (다시 기타로 오면 TAB이 그대로)
  //   피아노 → 기타: 줄이 맞는 음은 그대로, 나머지는 가장 낮은 프렛에 배치. 못 놓는 음은 빨간색으로 남김
  const changeInstrument = (next) => {
    if (next === instrument) return;
    if (playbackState !== 'STOPPED') handleStop();
    setSelectedNotes([]);
    if (next === 'piano') {
      if (editorMode === 'SYMBOL') setEditorMode('INPUT');
      setInstrument('piano');
      showStatus("피아노로 바꿨습니다. 음 범위와 개수 제한이 없고, 큰보표로 봅니다.");
      return;
    }
    const { measures, unplaced } = assignStrings(score);
    setScore(measures);
    setInstrument('guitar');
    showStatus(unplaced > 0
      ? `기타로 바꿨습니다. 기타로 칠 수 없는 음 ${unplaced}개는 빨간색으로 표시했습니다 (E2보다 낮거나 줄이 모자람).`
      : "기타로 바꿨습니다. 모든 음을 줄에 배치했습니다.", unplaced > 0);
  };

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
    const engraving = engravingRef.current;
    if (!el || !area || !engraving) return;

    const { mIndex, time } = fromAbs(playScore, abs);
    const found = findMeasure(engraving, mIndex);
    const lineEl = found && lineElsRef.current[found.lineIndex];
    if (!found || !lineEl) {
      el.style.display = 'none'; // 악보 밖 (녹음 중 아직 없는 마디 등)
      return;
    }

    const areaRect = area.getBoundingClientRect();
    const r = lineEl.getBoundingClientRect();
    const [y0, y1] = measureSpanY(found.measure);
    el.style.display = 'block';
    el.style.left = `${r.left - areaRect.left + timeToX(found.measure, time) - 1}px`;
    el.style.top = `${r.top - areaRect.top + y0}px`;
    el.style.height = `${y1 - y0}px`;

    // 다음 줄로 넘어가면 화면을 따라 스크롤 (하단 건반 패널에 가리지 않게)
    if (playheadLineRef.current !== found.lineIndex) {
      playheadLineRef.current = found.lineIndex;
      if (r.top < 0 || r.bottom > window.innerHeight - 200) {
        window.scrollBy({ top: r.top - 120, behavior: 'smooth' });
      }
    }
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

        // 기타: 다운스트로크처럼 굵은 줄(6번, 낮은 음)부터 시차를 둠. 피아노: 동시에
        const entries = [...beat.notes].sort((a, b) => (!isPiano && a.string != null && b.string != null
          ? b.string - a.string
          : soundOf(a) - soundOf(b)));
        const strumStep = !isPiano && entries.length > 1
          ? Math.min(STRUM_STEP_SEC, (beat.duration * secondsPerTick * STRUM_MAX_RATIO) / (entries.length - 1))
          : 0;

        entries.forEach((note, i) => {
          const offsetSec = i * strumStep;
          if (note.mute) {
            events.push({ abs: absTime, offsetSec, voice: `s${note.string}`, mute: true });
            return;
          }
          // 노트별 울림 길이(sustain)가 있으면 우선 사용
          const noteTicks = note.sustain || durTicks;
          // 기타는 줄마다 한 소리, 피아노(또는 줄 없는 음)는 건반마다 한 소리
          const voice = !isPiano && note.string != null ? `s${note.string}` : `p${note.pitch}`;
          events.push({ abs: absTime, offsetSec, voice, midi: note.pitch, ticks: noteTicks });
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
    const voiceOnString = {}; // 줄(피아노는 건반)마다 지금 울리고 있는 음 (같은 자리에 새 음이 오면 끊음)
    const schedule = () => {
      const horizon = ctx.currentTime + SCHEDULE_LOOKAHEAD_SEC;

      while (nextEvent < events.length && toSec(events[nextEvent].abs) < horizon) {
        const ev = events[nextEvent++];
        const t = toSec(ev.abs) + ev.offsetSec;
        // 실제 기타처럼 한 줄에는 한 소리만: 앞 음을 끊고 새 음(또는 뮤트)
        releaseVoice(voiceOnString[ev.voice], t);
        if (ev.mute) {
          playPercussiveMute(t, bus);
          voiceOnString[ev.voice] = null;
        } else {
          voiceOnString[ev.voice] = playTone(ev.midi, t, ev.ticks * secondsPerTick, bus);
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
  }, [score, bpm, cursor, handleStop, finishPlayback, isMetronome, isPiano]);

  // 튜토 재생: 튜토 화면의 지금 위치부터, 화면에 떨어지는 막대 그대로 소리냄
  //    - 정지하면 그 자리에 멈춤 (다시 누르면 이어서). 끝까지 갔으면 처음부터
  const handlePlayTutorial = useCallback(async (fromStart = false) => {
    const roll = rollRef.current;
    if (!timeline || !roll) return;
    handleStop();
    const token = playTokenRef.current;
    const ctx = await resumeAudioCtx();
    if (token !== playTokenRef.current) return;

    let startPos = fromStart ? roll.START_TIME : roll.getTime();
    if (startPos >= timeline.duration - 0.05) startPos = roll.START_TIME;
    roll.setTime(startPos);
    setPlaybackState('PLAYING');

    const bus = createBus();
    const ctxStart = ctx.currentTime + 0.1;
    const toCtx = (sec) => ctxStart + (sec - startPos);

    // 시작 위치에서 이미 울리고 있던 음은 남은 길이만큼, 그 뒤 음은 처음부터
    const events = timeline.notes.filter(n => n.end > startPos + 0.01);
    let next = 0;
    const voiceOnPitch = {}; // 같은 음이 겹치면 앞 소리를 끊음 (피아노도 같은 건반은 다시 누르면 새로 울림)
    const schedule = () => {
      const horizon = ctx.currentTime + SCHEDULE_LOOKAHEAD_SEC;
      while (next < events.length && toCtx(Math.max(events[next].start, startPos)) < horizon) {
        const n = events[next++];
        const from = Math.max(n.start, startPos);
        const t = toCtx(from);
        releaseVoice(voiceOnPitch[n.pitch], t);
        voiceOnPitch[n.pitch] = playTone(n.pitch, t, n.end - from, bus);
      }
    };

    const session = { bus, schedTimer: null, rafId: null };
    const frame = () => {
      if (playbackRef.current !== session) return;
      const heard = startPos + Math.max(0, ctx.currentTime - getOutputLatency() - ctxStart);
      roll.setTime(Math.min(heard, timeline.duration));
      if (heard >= timeline.duration) {
        finishPlayback(false);
        return;
      }
      session.rafId = requestAnimationFrame(frame);
    };

    playbackRef.current = session;
    schedule();
    session.schedTimer = setInterval(schedule, SCHEDULE_INTERVAL_MS);
    session.rafId = requestAnimationFrame(frame);
  }, [timeline, handleStop, finishPlayback]);

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
          beat = { time: seg.time, duration: seg.duration, notes: [], tieId };
          measure.beats.push(beat);
        }
        return { measure, beat };
      });

      let collisionOccurred = false;
      let outOfRange = false;

      keysToProcess.forEach(key => {
        let midi = PIANO_MAP[key];
        if (isOctaveDown) midi -= 12;

        // 피아노: 줄 없이 음 높이만. 같은 음이 이미 있으면 그대로 둠
        if (isPiano) {
          if (midi < PIANO_LOWEST || midi > PIANO_HIGHEST) { outOfRange = true; return; }
          segBeats.forEach(({ beat }) => {
            if (!beat.notes.some(n => !n.mute && n.pitch === midi)) beat.notes.push({ pitch: midi });
          });
          return;
        }

        if (midi < LOWEST_PITCH) {
          outOfRange = true;
          return;
        }

        // 모든 조각에서 비어 있는 줄 중 가장 낮은 프렛
        const bestString = lowestFretString(midi, (s) => segBeats.every(({ beat }) => !noteOnString(beat, s)));

        if (bestString) {
          segBeats.forEach(({ beat }) => { beat.notes.push({ pitch: midi, string: bestString }); });
        } else {
          collisionOccurred = true;
        }
      });

      if (outOfRange) showStatus(isPiano ? "피아노 건반(A0~C8) 범위를 벗어나는 음입니다." : "스탠다드 튜닝(E2) 범위를 벗어나는 저음입니다.", true);
      else if (collisionOccurred) showStatus("빈 줄이 없어서 입력하지 못했습니다.", true);

      // 노트가 하나도 안 들어간 비트는 제거
      segBeats.forEach(({ measure, beat }) => {
        if (beat.notes.length === 0) measure.beats = measure.beats.filter(b => b !== beat);
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
        // 같은 음(같은 줄, 또는 줄 없는 같은 높이)이면 뒤에 온 노트가 이김
        const incoming = new Set(b.notes.map(noteId));
        existingBeat.notes = [...existingBeat.notes.filter(n => !incoming.has(noteId(n))), ...b.notes];
        // 한 행에 화음이 부딪혀 겹쳤을 때 "가장 짧은 노트 기준" 반영
        existingBeat.duration = Math.min(existingBeat.duration, b.duration);
      } else {
        rebuiltScore[mIdx].beats.push({ time: localTime, duration: b.duration, notes: b.notes, tieId: b.tieId });
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
      if (b.notes.length > 0) noteAbsTimes.push(starts[mIdx] + b.time);
    }));
    noteAbsTimes.sort((a, b) => a - b);

    // 선택을 열(비트) 단위로 묶음
    const groups = new Map();
    selectedNotes.forEach(sel => {
      const key = `${sel.mIndex}-${sel.time}`;
      if (!groups.has(key)) groups.set(key, { mIndex: sel.mIndex, time: sel.time, ids: new Set() });
      groups.get(key).ids.add(sel.id);
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

      const allSelected = beat.notes.every(n => g.ids.has(noteId(n)));
      if (allSelected) {
        // 다음 노트까지 빈 구간이므로, 마디 경계에서 나눠 붙임줄 조각을 만들어도 겹치지 않음
        const segments = splitSpanByMeasures(newScore, abs, gap);
        beat.duration = segments[0].duration;
        beat.notes.forEach(n => { delete n.sustain; });
        if (segments.length > 1) {
          const tieId = beat.tieId || `${Date.now()}-${abs}`;
          beat.tieId = tieId;
          segments.slice(1).forEach(seg => {
            newScore[seg.mIndex].beats.push({ time: seg.time, duration: seg.duration, notes: beat.notes.map(n => ({ ...n })), tieId });
          });
        }
      } else {
        beat.notes.forEach(n => { if (g.ids.has(noteId(n))) n.sustain = gap; });
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

  // 선택된 노트들을 옮길 계획을 세움 (아무것도 바꾸지 않음)
  //   moveOne(note, sel, isFree, isPitchFree) → { note: 옮긴 뒤의 노트 } 또는 { error }
  //     isFree(줄): 그 줄이 비었는지 / isPitchFree(음높이): 같은 높이의 음이 없는지 (피아노)
  //   lowFirst: 낮은 음(굵은 줄) 쪽 노트부터 처리할지. 같은 비트 안에서 노트끼리 자리를 비켜 주는 순서
  // 반환: { moves: [{ sel, note }] } 또는 { error }
  const planNoteMoves = (moveOne, lowFirst) => {
    const height = (sel) => (sel.string != null && !isPiano ? -sel.string : soundOf(sel));
    const ordered = [...selectedNotes].sort((a, b) => (lowFirst ? height(a) - height(b) : height(b) - height(a)));
    const occupied = {}; // 비트마다 차 있는 줄과 음높이
    const moves = [];

    for (const sel of ordered) {
      const beat = score[sel.mIndex] && score[sel.mIndex].beats.find(b => b.time === sel.time);
      const note = beat && findNoteById(beat, sel.id);
      if (!note) continue;

      const key = `${sel.mIndex}-${sel.time}`;
      if (!occupied[key]) {
        // 선택된 노트들은 어차피 옮겨 가므로 처음에는 빈자리로 봄
        const movingHere = new Set(selectedNotes.filter(s => s.mIndex === sel.mIndex && s.time === sel.time).map(s => s.id));
        const staying = beat.notes.filter(n => !movingHere.has(noteId(n)));
        occupied[key] = {
          strings: new Set(staying.map(n => n.string).filter(st => st != null)),
          pitches: new Set(staying.filter(n => !n.mute).map(n => n.pitch)),
        };
      }

      const occ = occupied[key];
      const result = moveOne(note, sel, (st) => !occ.strings.has(st), (p) => !occ.pitches.has(p));
      if (result.error) return { error: result.error };
      if (result.note.string != null) occ.strings.add(result.note.string);
      if (!result.note.mute) occ.pitches.add(result.note.pitch);
      moves.push({ sel, note: result.note });
    }
    return { moves };
  };

  // 계획한 이동을 악보에 적용하고, 옮긴 노트를 바로 들려줌
  const applyNoteMoves = (moves) => {
    const now = getAudioCtx().currentTime;
    moves.forEach(({ note }) => (note.mute ? playPercussiveMute(now) : playTone(note.pitch, now, 0.4)));

    setSelectedNotes(moves.map(({ sel, note }) => ({ ...sel, id: noteId(note), string: note.string, pitch: note.pitch, mute: !!note.mute })));
    setScore(prev => {
      const newScore = cloneScore(prev);
      const beatOf = (sel) => newScore[sel.mIndex] && newScore[sel.mIndex].beats.find(b => b.time === sel.time);
      // 먼저 전부 빼고 나서 넣어야 서로 자리를 바꾸는 이동도 안전함
      moves.forEach(({ sel }) => {
        const beat = beatOf(sel);
        if (beat) beat.notes = beat.notes.filter(n => noteId(n) !== sel.id);
      });
      moves.forEach(({ sel, note }) => {
        const beat = beatOf(sel);
        if (beat) beat.notes.push({ ...note });
      });
      return newScore;
    });
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
            
            // 선택한 노트만 삭제 (화음의 다른 노트는 보존)
            beat.notes = beat.notes.filter(n => noteId(n) !== sel.id);

            // 만약 지우고 났더니 해당 박자에 남은 노트가 하나도 없다면 비트 자체를 삭제
            if (beat.notes.length === 0) {
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
      const same = (a, b) => a.mIndex === b.mIndex && a.time === b.time && a.id === b.id;
      const currentIndex = allNotes.findIndex(n => same(n, referenceNote));

      if (isNext && currentIndex !== -1 && currentIndex < allNotes.length - 1) {
        const targetNote = allNotes[currentIndex + 1];
        if (e.shiftKey) {
          if (!selectedNotes.some(n => same(n, targetNote))) {
            setSelectedNotes(prev => [...prev, targetNote]);
          }
        } else {
          setSelectedNotes([targetNote]);
        }
      } else if (!isNext && currentIndex > 0) {
        const targetNote = allNotes[currentIndex - 1];
        if (e.shiftKey) {
          if (!selectedNotes.some(n => same(n, targetNote))) {
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

      // 내려갈 때는 낮은 음(굵은 줄) 쪽 노트부터, 올라갈 때는 높은 음 쪽부터 처리해야 서로 자리를 비켜 줌
      const plan = planNoteMoves((note, sel, isFree, isPitchFree) => {
        if (note.mute) return { note }; // 뮤트는 음높이가 없으므로 그대로
        const targetPitch = note.pitch + delta;

        // 피아노: 음 높이만 바꿈 (줄 정보는 그대로 둠: 기타로 돌아갈 때 다시 맞춤)
        if (isPiano) {
          if (targetPitch < PIANO_LOWEST || targetPitch > PIANO_HIGHEST) return { error: "피아노 건반(A0~C8) 범위를 벗어납니다." };
          if (!isPitchFree(targetPitch)) return { error: "같은 높이의 음이 이미 있습니다." };
          return { note: { ...note, pitch: targetPitch } };
        }
        // 기타인데 줄이 없는 음(빨간 음): 옮긴 높이로 줄에 놓을 수 있으면 놓음
        if (note.string == null) {
          if (!isPitchFree(targetPitch)) return { error: "같은 높이의 음이 이미 있습니다." };
          const s = targetPitch >= LOWEST_PITCH ? lowestFretString(targetPitch, isFree) : null;
          return { note: s ? { ...note, pitch: targetPitch, string: s } : { ...note, pitch: targetPitch } };
        }
        if (targetPitch < LOWEST_PITCH) return { error: "기타(E2)로 연주할 수 없는 낮은 음입니다." };

        // 내려가면 굵은 줄(+1) 쪽으로, 올라가면 가는 줄(-1) 쪽으로 빈 줄을 찾음
        const dir = delta < 0 ? 1 : -1;
        for (let s = sel.string; s >= 1 && s <= 6; s += dir) {
          if (targetPitch - TUNING[s] >= 0 && isFree(s)) return { note: { ...note, pitch: targetPitch, string: s } };
        }
        return { error: "이동할 수 있는 빈 줄이 없습니다." };
      }, delta < 0);

      if (plan.error) { showStatus(plan.error, true); return; }
      applyNoteMoves(plan.moves);
      return;
    }

    // Ctrl + ↑ ↓: 같은 음을 다른 줄로 옮김 (자리가 있으면 건너뜀, 0프렛 아래면 한 옥타브 올림)
    if (e.ctrlKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (isPiano) { showStatus("피아노에는 줄이 없습니다. 줄 이동은 기타 악보에서만 됩니다.", true); return; }
      if (selectedNotes.some(sel => sel.string == null)) {
        showStatus("줄이 없는 음(빨간 음)이 있습니다. ↑↓로 음 높이를 옮기면 칠 수 있는 줄에 놓입니다.", true);
        return;
      }
      const stringDelta = e.key === 'ArrowUp' ? -1 : 1;

      const plan = planNoteMoves((note, sel, isFree) => {
        // 옮기려는 방향으로 빈 줄을 찾을 때까지 한 칸씩 전진
        let target = null;
        for (let s = sel.string + stringDelta; s >= 1 && s <= 6; s += stringDelta) {
          if (isFree(s)) { target = s; break; }
        }
        if (target === null) return { error: "더 이상 이동할 빈 줄이 없습니다." };
        if (note.mute) return { note: { ...note, string: target } };

        // 그 줄의 개방현보다 낮으면 칠 수 없으므로 한 옥타브씩 올림
        let pitch = note.pitch;
        while (pitch < TUNING[target]) pitch += 12;
        return { note: { ...note, pitch, string: target } };
      }, stringDelta > 0);

      if (plan.error) { showStatus(plan.error, true); return; }
      applyNoteMoves(plan.moves);
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
    if (isPiano) return; // 뮤트(X)는 기타 줄 기호
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
          beat = { time: cursor.time, duration, notes: [] };
          cMeasure.beats.push(beat);
        }

        // 그 줄에 있던 음은 뮤트로 바뀜
        beat.notes = [...beat.notes.filter(n => n.string !== stringNum), { string: stringNum, mute: true }];
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
      } else if (isTutorialView) {
        handlePlayTutorial();
      } else {
        handlePlay('MEASURE');
      }
      return;
    }

    // 튜토에서는 악보가 안 보이므로 편집 키를 막음
    if (isTutorialView) return;

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) e.preventDefault();
    
    // 모드 전환
    if (e.key === '`') {
      e.preventDefault();
      changeMode(editorMode === 'SELECT' ? 'INPUT' : 'SELECT');
      return;
    }
    if (e.key === ']') {
      e.preventDefault();
      if (isPiano) { showStatus("기호(뮤트 X)는 기타 악보에서만 씁니다.", true); return; }
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
  }, [score, cursor, durIdx, isDotted, currentStep, bpm, isOctaveDown, editorMode, selectedNotes, playbackState, handlePlay, handleStop, isHelpOpen, isTutorialView, handlePlayTutorial, isPiano]);

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
  }, [score, cursor, currentStep, isOctaveDown, playbackState, isPiano]);

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
    <div className="app" data-theme={theme}>

      {/* 도구 줄 */}
      <div className="toolbar" role="toolbar" aria-label="편집 도구">

        <div className="tool-group">
          <div className="seg" role="group" aria-label="편집 모드">
            {MODES.map(m => (
              <button key={m.id} aria-pressed={editorMode === m.id} onClick={() => changeMode(m.id)} disabled={isTutorialView || (isPiano && m.id === 'SYMBOL')}
                title={`${m.label} 모드 (${m.key})`}>{m.label}</button>
            ))}
          </div>
        </div>

        <div className="tool-group" role="group" aria-label="재생">
          {isTutorialView ? (
            <>
              <button className="tbtn" onClick={() => handlePlayTutorial(true)} title="튜토를 처음부터 재생"><IconPlayFromStart /></button>
              <button className="tbtn" onClick={() => handlePlayTutorial()} title="튜토를 지금 위치부터 재생 (Space)"><IconPlay /></button>
            </>
          ) : (
            <>
              <button className="tbtn" onClick={() => handlePlay('ALL')} title="처음부터 재생"><IconPlayFromStart /></button>
              <button className="tbtn" onClick={() => handlePlay('MEASURE')} title="커서가 있는 마디부터 재생 (Space)"><IconPlayMeasure /></button>
              <button className="tbtn" onClick={() => handlePlay('CURSOR')} title="커서 위치부터 재생"><IconPlay /></button>
              <button className={`tbtn${isRecording ? ' is-recording' : ''}`} onClick={() => handlePlay('RECORD')}
                title="커서가 있는 마디부터 실시간 녹음 (한 마디 카운트인)"><IconRecord /></button>
            </>
          )}
          <button className="tbtn" onClick={handleStop} title={isTutorialView ? '멈춤 (Space, 그 자리에서 멈춤)' : '정지 (Space)'}><IconStop /></button>
          <button className="tbtn" aria-pressed={isMetronome} onClick={() => setIsMetronome(!isMetronome)} disabled={isTutorialView} title="메트로놈 켜기/끄기"><IconMetronome /></button>
        </div>

        <div className="tool-group">
          <span className="tool-label">BPM</span>
          <input
            className="field bpm"
            type="number"
            value={bpm}
            onChange={(e) => setBpm(Number(e.target.value))}
            disabled={isTutorialView}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
            aria-label="BPM"
          />
          <span className="tool-label" style={{ marginLeft: '8px' }} title="커서가 있는 마디부터 끝까지 적용">박자</span>
          <select
            className="field"
            value={cursorTimeSig.num}
            onChange={(e) => { handleTimeSigChange(Number(e.target.value), cursorTimeSig.den); e.target.blur(); }}
            disabled={isTutorialView}
            aria-label="박자표 분자"
          >
            {Array.from({ length: MAX_TIME_SIG_NUM }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>/</span>
          <select
            className="field"
            value={cursorTimeSig.den}
            onChange={(e) => { handleTimeSigChange(cursorTimeSig.num, Number(e.target.value)); e.target.blur(); }}
            disabled={isTutorialView}
            aria-label="박자표 분모"
          >
            {TIME_SIG_DENOMINATORS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>

        {/* 선택 모드에서만 쓰는 편집 (한 번 누르면 한 번 실행) */}
        <div className="tool-group" role="group" aria-label="선택한 노트 편집">
          <button className="tbtn" onClick={handleSetSelectedLength} disabled={!isSelectMode || isTutorialView}
            title={`선택한 노트 길이를 현재 박자(${formatBeats(currentStep)}박)로 맞추고 뒤 노트를 당기거나 밂 (선택 모드)`}>
            <IconSetLength />{formatBeats(currentStep)}박으로
          </button>
          <button className="tbtn" onClick={handleExtendToNextNote} disabled={!isSelectMode || isTutorialView}
            title="선택한 노트를 다음 노트가 있는 위치까지 늘림 (선택 모드)">
            <IconExtend />다음 노트까지
          </button>
        </div>

        {/* 여기서 줄바꿈: 보기·음색·파일은 둘째 줄 */}
        <div className="toolbar-break" />

        <div className="tool-group">
          <div className="seg" role="group" aria-label="악기">
            <button aria-pressed={!isPiano} onClick={() => changeInstrument('guitar')} disabled={isTutorialView}
              title="기타: E2 이상, 한 박자 6음까지. TAB 있음">기타</button>
            <button aria-pressed={isPiano} onClick={() => changeInstrument('piano')} disabled={isTutorialView}
              title="피아노: 음 범위·개수 제한 없음. 큰보표로 봄 (TAB 없음)">피아노</button>
          </div>
        </div>

        <div className="tool-group">
          <div className="seg" role="group" aria-label="보기">
            {VIEWS.map(v => {
              const noNotes = v.id === VIEW_TUTORIAL && !hasPitchedNotes;
              const noTab = isPiano && (v.id === VIEW_TAB || v.id === VIEW_BOTH); // 피아노에는 TAB이 없음
              const pressed = v.id === VIEW_TUTORIAL ? isTutorialView : (!isTutorialView && scoreView === v.id);
              return (
                <button key={v.id} aria-pressed={pressed} disabled={noNotes || noTab}
                  onClick={() => {
                    if (playbackState !== 'STOPPED') handleStop();
                    // 튜토에서 악보로 돌아갈 때: 튜토에서 보던 마디로 커서를 옮김
                    if (isTutorialView && v.id !== VIEW_TUTORIAL && rollRef.current) {
                      const n = measureAt(timeline, Math.max(0, rollRef.current.getTime() + TUTORIAL_LEAD_SEC));
                      setCursor({ mIndex: Math.min(n - 1, score.length - 1), time: 0 });
                    }
                    setView(v.id);
                  }}
                  title={noNotes ? '튜토: 악보에 음을 넣으면 피아노 튜토리얼로 볼 수 있음'
                    : noTab ? `${v.label}: 피아노 악보에는 TAB이 없음`
                    : v.id === VIEW_TUTORIAL ? '보기: 악보를 피아노 튜토리얼로' : `보기: ${v.label}`}>
                  {v.label}
                </button>
              );
            })}
          </div>
          {/* 오선보가 보일 때만: 높은음 / 큰보표 (기타만), 큰보표면 나누는 음 */}
          {!isTutorialView && scoreView !== VIEW_TAB && (
            <>
              {!isPiano && <div className="seg" role="group" aria-label="오선보 종류" style={{ marginLeft: '8px' }}>
                <button aria-pressed={!notation.grand} onClick={() => setNotation({ ...notation, grand: false })}
                  title="높은음자리표 하나 (기타 관례: 실제 소리보다 한 옥타브 높게 적음)">높은음</button>
                <button aria-pressed={notation.grand} onClick={() => setNotation({ ...notation, grand: true })}
                  title="큰보표: 높은음자리표 + 낮은음자리표 (피아노 악보, 실제 소리 높이)">큰보표</button>
              </div>}
              {drawNotation.grand && (
                <>
                  <span className="tool-label" style={{ marginLeft: '8px' }} title="이 음부터 위는 높은음자리표, 아래는 낮은음자리표">나눔</span>
                  <select
                    className="field"
                    value={notation.split}
                    onChange={(e) => { setNotation({ ...notation, split: Number(e.target.value) }); e.target.blur(); }}
                    aria-label="큰보표 나누는 음"
                    title="이 음부터 위는 높은음자리표, 아래는 낮은음자리표"
                  >
                    {SPLIT_CHOICES.map(p => <option key={p} value={p}>{pitchLabel(p)}{p === 60 ? ' (가운데 도)' : ''}</option>)}
                  </select>
                </>
              )}
            </>
          )}
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
          <label className="tbtn" title="MIDI 파일을 원곡으로 가져오기 (기타 악보는 그대로)">
            <IconMidi />MIDI 가져오기
            <input type="file" accept=".mid,.midi,audio/midi,audio/x-midi" style={{ display: 'none' }} onChange={handleImportMidi} />
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
        <div className="sheet-column">
        {/* 원곡 정보는 악보 보기에서만 (튜토는 튜토리얼 화면만) */}
        {source && !isTutorialView && <SourcePanel source={source} onClear={handleClearSource} />}
        {cacheFull && (
          <p className="cache-warning" role="alert">
            원곡이 커서 브라우저에 자동 저장하지 못했습니다. 닫기 전에 저장 버튼으로 파일을 받아 두세요.
          </p>
        )}
        <div className="page" ref={scoreAreaRef}>
          {/* 재생 진행 바 (재생 중에만 표시, 위치는 updatePlayhead가 매 프레임 갱신) */}
          <div ref={playheadRef} className="playhead" />
          {isTutorialView ? (
            <PianoRoll timeline={timeline} theme={theme} playing={playbackState === 'PLAYING'} controlRef={rollRef} />
          ) : (
          <ScoreView
            score={score}
            view={scoreView}
            tieInfo={tieInfo}
            theme={theme}
            notation={drawNotation}
            cursor={cursor}
            selectedNotes={selectedNotes}
            step={currentStep}
            clickable={editorMode === 'INPUT'}
            onPickPosition={setCursor}
            engravingRef={engravingRef}
            lineElsRef={lineElsRef}
          />
          )}
        </div>
        </div>
      </div>

      {/* 상태 줄 + 건반 */}
      <div className="statusbar">
        <div className="status-row">
          {isTutorialView ? (
            <>
              <span className="status-cell">보기 <b>튜토</b></span>
              <span className="status-cell">재생/멈춤 <kbd>Space</kbd></span>
              <span className="status-cell">멈춰 있을 때 마우스 휠로 앞뒤 이동</span>
              <span className="status-cell">편집은 오선보·TAB 보기에서</span>
            </>
          ) : (<>
          <span className="status-cell">모드 <b>{MODES.find(m => m.id === editorMode).label}</b></span>
          <span className="status-cell">{MODE_HINTS[editorMode]}</span>
          <span className="status-cell">길이 <b>{formatBeats(currentStep)}박</b> <kbd>-</kbd><kbd>+</kbd></span>
          <span className={`status-cell${isDotted ? ' on' : ''}`}>점음표 <b>{isDotted ? '켬' : '끔'}</b> <kbd>\</kbd></span>
          <span className={`status-cell${isOctaveDown ? ' on' : ''}`}>한 옥타브 아래 <b>{isOctaveDown ? '켬' : '끔'}</b> <kbd>Shift</kbd></span>
          <span className="status-cell">위치 <b>{cursor.mIndex + 1}마디 {cursorBeat}박</b></span>
          </>)}
          <span className={`status-msg${status && status.isError ? ' error' : ''}`} role="status" aria-live="polite">
            {status ? status.text : ''}
          </span>
        </div>

        {/* 컴퓨터 키보드 안내: 악보 입력용이라 튜토에서는 숨김 */}
        {!isTutorialView && <div className="keyboard" aria-hidden="true">
          <div className="key-row">
            {TOP_ROW.map((keyData) => <PianoKey key={keyData.w} whiteLabel={keyData.w} blackLabel={keyData.b} />)}
          </div>
          <div className="key-row">
            {BOTTOM_ROW.map((keyData) => <PianoKey key={keyData.w} whiteLabel={keyData.w} blackLabel={keyData.b} />)}
          </div>
        </div>}
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

            <h3>보기</h3>
            <table><tbody>
              <tr><td>오선보 / 둘 다 / TAB</td><td>악보 표시 방식. 편집과 재생은 어느 보기에서나 같음</td></tr>
              <tr><td>기타 / 피아노</td><td>악기. 기타: E2 이상, 한 박자 6음까지, TAB 있음. 피아노: 음 범위·개수 제한 없음, 큰보표로 봄. 피아노 → 기타로 바꾸면 줄을 자동으로 정하고, 칠 수 없는 음은 빨간색(TAB 위 ?)으로 남김. ↑↓로 옮기면 줄에 놓임</td></tr>
              <tr><td>높은음 / 큰보표</td><td>오선보 종류. 높은음: 기타 관례대로 실제 소리보다 한 옥타브 높게 (음자리표 아래 8). 큰보표: 피아노 악보처럼 높은음자리표 + 낮은음자리표, 실제 소리 높이</td></tr>
              <tr><td>나눔</td><td>큰보표에서 이 음부터 위는 높은음자리표, 아래는 낮은음자리표</td></tr>
              <tr><td>(숫자)</td><td>TAB에서 앞 음에 붙임줄로 이어진 음 (다시 치지 않음)</td></tr>
              <tr><td>튜토</td><td>악보를 피아노 튜토리얼로: 떨어지는 막대가 건반에 닿을 때 그 음을 침. 커서가 있던 마디에서 시작하고, 악보로 돌아가면 튜토에서 보던 마디로 커서가 옴. 멈추면 그 자리에서 이어서, 멈춰 있을 때 마우스 휠로 앞뒤 이동. 편집은 다른 보기에서</td></tr>
            </tbody></table>

            <h3>파일</h3>
            <table><tbody>
              <tr><td>MIDI 가져오기</td><td>MIDI 파일의 음을 전부 원곡으로 보관 (기타 악보는 그대로)</td></tr>
              <tr><td>열기 / 저장</td><td>기타 악보와 원곡을 JSON 파일 하나로</td></tr>
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