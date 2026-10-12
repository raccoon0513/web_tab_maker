import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';



// --- 초기 샘플 데이터 설정 ---
const initialScore = [
  { id: 1, beats: [] },
  { id: 2, beats: [] },
  { id: 3, beats: [] }
];

// --- 상수 모음 ---
const UNIT = 50; 
const MAX_LINE_WIDTH = 24; 
const SIDE_PADDING = 20;
const STRING_COUNT = 6;
const STRING_SPACING = 20;
const TOP_PADDING = 30;
const HEIGHT = TOP_PADDING + STRING_SPACING * 5 + 30; 

const TUNING = { 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 };

// 💡 오디오 컨텍스트 및 타이머 전역 관리
let audioCtx = null;
let playbackTimers = [];

// 💡 삼각파(Triangle)와 볼륨 감쇠(ADSR)를 이용한 기타 튕기는 소리 합성
const playTone = (midi, startTime, durationInSeconds) => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  const frequency = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  osc.type = 'triangle'; 
  osc.frequency.value = frequency;

  // 소리 볼륨(엔벨롭) 깎기: 치는 순간 커지고 서서히 줄어듦
  gainNode.gain.setValueAtTime(0, startTime);
  gainNode.gain.linearRampToValueAtTime(0.8, startTime + 0.02); 
  gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + durationInSeconds + 0.5); // 여음을 위해 0.5초 추가

  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  osc.start(startTime);
  osc.stop(startTime + durationInSeconds + 0.5);
};

// 💡 화이트 노이즈와 대역통과 필터를 이용한 퍼커시브(챱챱) 소리 합성
const playPercussiveMute = (startTime) => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  
  // 1. 0.05초 길이의 지직거리는 노이즈(백색 소음) 버퍼 생성
  const bufferSize = audioCtx.sampleRate * 0.05; 
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;

  // 2. 대역통과 필터(Bandpass)로 기타 줄 때리는 대역의 소리만 예쁘게 깎아냄
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1200; // 챱챱거리는 질감을 살리는 주파수 대역
  filter.Q.value = 1;

  // 3. 엔벨롭 (아주 짧고 강하게 끊어침)
  const gainNode = audioCtx.createGain();
  gainNode.gain.setValueAtTime(1.5, startTime); 
  gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.04); 

  noise.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  noise.start(startTime);
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

const DURATION_STEPS = [0.25, 0.5, 1, 2, 4]; 

// 💡 수정됨: 실제 피아노 배열에 맞춘 건반 UI 구조 (E, B 다음엔 흑건 없음)
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

export default function TabEditor() {
  // 💡 1. 로컬 스토리지(캐시)에서 데이터 자동 불러오기 (지연 초기화)
  const [score, setScore] = useState(() => {
    const savedScore = localStorage.getItem('tabEditorScore');
    if (savedScore) {
      try {
        return JSON.parse(savedScore);
      } catch (e) {
        console.error("캐시 데이터를 읽는 중 오류가 발생했습니다.", e);
      }
    }
    return [ { id: 1, beats: [] } ];
  });

  // 💡 2. score 상태가 바뀔 때마다 자동으로 캐시에 저장
  useEffect(() => {
    localStorage.setItem('tabEditorScore', JSON.stringify(score));
  }, [score]);
  const [editorMode, setEditorMode] = useState('INPUT'); // 'INPUT', 'SELECT', 'SYMBOL'
  const [selectedNotes, setSelectedNotes] = useState([]); // 선택된 노트 배열: [{ mIndex, time, string }]
  const [isDebugMode, setIsDebugMode] = useState(false); // 박자 시각화 토글
  
  const [cursor, setCursor] = useState({ mIndex: 0, time: 0 });
  const [durIdx, setDurIdx] = useState(2); 
  const [isDotted, setIsDotted] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  
  // 💡 재생 관련 상태 (준비 단계)
  const [bpm, setBpm] = useState(120);
  const [playbackState, setPlaybackState] = useState('STOPPED'); // 'STOPPED', 'PLAYING', 'PAUSED'
  const [isOctaveDown, setIsOctaveDown] = useState(false);

  const [activeUIKeys, setActiveUIKeys] = useState(new Set());
  const activeKeysRef = useRef(new Set()); 
  const chordAccumulatorRef = useRef(new Set()); 

  // 💡 3. JSON 파일로 내보내기
  const handleExportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(score, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "guitar_tab_score.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
    showToast("JSON 파일로 저장되었습니다.");
  };

  // 💡 4. JSON 파일 불러오기
  const handleImportJSON = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        if (Array.isArray(parsed)) {
          setScore(parsed);
          setSelectedNotes([]);
          setCursor({ mIndex: 0, time: 0 });
          showToast("악보를 성공적으로 불러왔습니다.");
        }
      } catch (err) {
        showToast("잘못된 형식의 파일입니다.");
      }
    };
    reader.readAsText(file);
    e.target.value = null; // 같은 파일을 다시 불러올 수 있도록 input 초기화
  };

  // 💡 5. 악보 완전 초기화
  const handleResetScore = () => {
    if (window.confirm("모든 악보 데이터가 삭제됩니다. 정말 초기화하시겠습니까?")) {
      setScore([ { id: 1, beats: [] } ]);
      setSelectedNotes([]);
      setCursor({ mIndex: 0, time: 0 });
      showToast("악보가 초기화되었습니다.");
    }
  };

  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2000);
  };

  // 💡 정지 로직: 예약된 오디오와 시각적 커서 타이머 모두 초기화
  const handleStop = useCallback(() => {
    if (audioCtx) {
      audioCtx.close(); 
      audioCtx = null;
    }
    playbackTimers.forEach(clearTimeout);
    playbackTimers = [];
    setPlaybackState('STOPPED');
  }, []);

  // 💡 재생 로직: 악보를 읽어 시간순으로 오디오 스케줄링
  const handlePlay = useCallback((fromCursor = false) => {
    handleStop(); // 기존 재생 중이던 소리 강제 종료
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    setPlaybackState('PLAYING');
    setSelectedNotes([]); // 재생 중 선택 박스 방해 방지

    const secondsPerBeat = 60 / bpm;
    const startAbsoluteTime = fromCursor ? (cursor.mIndex * 4 + cursor.time) : 0; 
    const ctxStartTime = audioCtx.currentTime + 0.1; 

    let maxEndTime = 0;

    score.forEach((measure, mIndex) => {
      measure.beats.forEach(beat => {
        const absTime = mIndex * 4 + beat.time;
        
        if (absTime >= startAbsoluteTime) {
          const timeOffset = absTime - startAbsoluteTime; 
          const startTimeInSec = ctxStartTime + (timeOffset * secondsPerBeat);
          const durationInSec = beat.duration * secondsPerBeat;

          // 1. 화음 내의 모든 노트를 동시에 스케줄링
          Object.entries(beat.notes).forEach(([string, fret]) => {
            if (fret === 'X') {
              // 💡 'X'일 때는 음표 대신 퍼커시브 챱챱 사운드 재생
              playPercussiveMute(startTimeInSec);
            } else {
              // 일반 숫자 프렛일 때는 기존 기타 사운드 재생
              const strNum = parseInt(string, 10);
              const midi = TUNING[strNum] + fret;
              playTone(midi, startTimeInSec, durationInSec);
            }
          });

          // 2. 소리가 나는 타이밍에 맞춰 파란색 진행 바(Cursor) 이동
          const timer = setTimeout(() => {
            setCursor({ mIndex: measure.id - 1, time: beat.time });
          }, (startTimeInSec - audioCtx.currentTime) * 1000);
          playbackTimers.push(timer);

          if (startTimeInSec + durationInSec > maxEndTime) {
            maxEndTime = startTimeInSec + durationInSec;
          }
        }
      });
    });

    const endTimer = setTimeout(() => {
      setPlaybackState('STOPPED');
    }, (maxEndTime - audioCtx.currentTime) * 1000);
    playbackTimers.push(endTimer);

  }, [score, bpm, cursor, handleStop]);
  const layout = useMemo(() => {
    const lines = [];
    let currentLineChunks = [];
    let currentRemaining = MAX_LINE_WIDTH;

    score.forEach((measure, mIndex) => {
      let minDuration = 4; 
      measure.beats.forEach(b => { if (b.duration < minDuration) minDuration = b.duration; });

      let W = 4;
      if (minDuration <= 0.25) W = 16;
      else if (minDuration <= 0.5) W = 8;
      
      let R = currentRemaining;

      if (R === 0) { lines.push(currentLineChunks); currentLineChunks = []; R = MAX_LINE_WIDTH; }

      if (W <= R) {
        currentLineChunks.push({ mIndex, measureId: measure.id, beats: measure.beats, width: W, timeStart: 0, timeEnd: 4, type: 'full' });
        currentRemaining = R - W;
      } else {
        const splitRatio = R / W; 
        const timeBoundary = 4 * splitRatio; 

        currentLineChunks.push({ mIndex, measureId: measure.id, beats: measure.beats.filter(b => b.time < timeBoundary), width: R, timeStart: 0, timeEnd: timeBoundary, type: 'start' });
        lines.push(currentLineChunks); currentLineChunks = [];
        
        let wRemaining = W - R;
        currentLineChunks.push({ mIndex, measureId: measure.id, beats: measure.beats.filter(b => b.time >= timeBoundary), width: wRemaining, timeStart: timeBoundary, timeEnd: 4, type: 'end' });
        currentRemaining = MAX_LINE_WIDTH - wRemaining;
      }
    });

    if (currentLineChunks.length > 0) lines.push(currentLineChunks);
    return lines;
  }, [score]);

  const insertChord = (keysToProcess) => {
    const targetDur = DURATION_STEPS[durIdx] * (isDotted ? 1.5 : 1);
    
    // 💡 1. 입력 후 이동할 다음 커서 위치를 먼저 계산 (여러 마디를 넘어가도 안전하게 처리)
    let nextTime = cursor.time + targetDur;
    let nextMIndex = cursor.mIndex;
    while (nextTime >= 4) { 
      nextMIndex += 1; 
      nextTime -= 4; 
    }

    setScore(prev => {
      let newScore = JSON.parse(JSON.stringify(prev));
      
      const remainingTime = 4 - cursor.time;
      const tieNeeded = targetDur > remainingTime;

      // 💡 2. 현재 마디, 붙임줄 목적지 마디, 그리고 이동할 다음 빈 마디까지 넉넉하게 미리 생성
      const maxNeededIndex = Math.max(cursor.mIndex + (tieNeeded ? 1 : 0), nextMIndex);
      while (newScore.length <= maxNeededIndex) {
        newScore.push({ id: newScore.length + 1, beats: [] });
      }
      
      let cMeasure = newScore[cursor.mIndex];
      const durPart1 = tieNeeded ? remainingTime : targetDur;
      const durPart2 = tieNeeded ? targetDur - remainingTime : 0;
      const tieId = tieNeeded ? Date.now().toString() : null;

      let b1 = cMeasure.beats.find(b => b.time === cursor.time);
      if (!b1) {
        b1 = { time: cursor.time, duration: durPart1, notes: {}, tieId };
        cMeasure.beats.push(b1);
      }

      let nMeasure = null, b2 = null;
      if (tieNeeded) {
        nMeasure = newScore[cursor.mIndex + 1];
        b2 = nMeasure.beats.find(b => b.time === 0);
        if (!b2) {
          b2 = { time: 0, duration: durPart2, notes: {}, tieId };
          nMeasure.beats.push(b2);
        }
      }

      let collisionOccurred = false;
      let outOfRange = false; // 💡 저음 한계 초과 플래그

      keysToProcess.forEach(key => {
        let midi = PIANO_MAP[key];
        
        // 💡 옥타브 다운 모드가 켜져 있다면 MIDI 값을 12 낮춤
        if (isOctaveDown) midi -= 12;

        if (midi < 40) {
          outOfRange = true; // 스탠다드 튜닝(E2 = 40) 범위 미달
          return;
        }

        let bestString = null, minFret = 999;

        for (let s = 1; s <= 6; s++) {
          const fret = midi - TUNING[s];
          if (fret >= 0 && fret <= 24) {
            const b1Clear = b1.notes[s] === undefined;
            const b2Clear = tieNeeded ? b2.notes[s] === undefined : true;
            
            if (b1Clear && b2Clear && fret < minFret) {
              minFret = fret;
              bestString = s;
            }
          }
        }

        if (bestString) {
          b1.notes[bestString] = minFret;
          if (tieNeeded) b2.notes[bestString] = minFret;
        } else {
          collisionOccurred = true;
        }

        
      });

      if (outOfRange) {
        showToast("스탠다드 튜닝(E2) 범위를 벗어나는 저음입니다.");
      } else if (collisionOccurred) {
        showToast("입력할 자리가 없습니다!");
      }

      if (Object.keys(b1.notes).length === 0) cMeasure.beats = cMeasure.beats.filter(b => b !== b1);
      if (tieNeeded && Object.keys(b2.notes).length === 0) nMeasure.beats = nMeasure.beats.filter(b => b !== b2);

      return newScore;
    });

    // 💡 3. 계산해둔 다음 위치로 커서 이동
    setCursor({ mIndex: nextMIndex, time: nextTime });
  };

  const handleSelectModeInput = (e) => {
    // 💡 [기능 0] Delete / Backspace: 선택된 노트만 정밀 삭제
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (selectedNotes.length === 0) return;

      setScore(prev => {
        let newScore = JSON.parse(JSON.stringify(prev));
        
        selectedNotes.forEach(sel => {
          const measure = newScore[sel.mIndex];
          if (!measure) return;
          
          const beatIdx = measure.beats.findIndex(b => b.time === sel.time);
          if (beatIdx !== -1) {
            const beat = measure.beats[beatIdx];
            
            // 💡 해당 줄(String)의 노트만 삭제 (화음의 다른 노트는 보존)
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

    let allNotes = [];
    score.forEach((measure) => {
      measure.beats.forEach((beat) => {
        Object.entries(beat.notes).forEach(([str, fret]) => {
          allNotes.push({ mIndex: measure.id - 1, time: beat.time, string: parseInt(str), fret, duration: beat.duration });
        });
      });
    });

    if (allNotes.length === 0) return;

    allNotes.sort((a, b) => {
      if (a.mIndex !== b.mIndex) return a.mIndex - b.mIndex;
      if (a.time !== b.time) return a.time - b.time;
      return a.string - b.string;
    });

    if (selectedNotes.length === 0) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        const firstNote = allNotes.find(n => n.mIndex > cursor.mIndex || (n.mIndex === cursor.mIndex && n.time >= cursor.time)) || allNotes[allNotes.length - 1];
        setSelectedNotes([firstNote]);
      }
      return;
    }

    // 💡 [기능 1] 방향키 좌/우: 순차 탐색 (Shift 누를 시 복수 선택)
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

    // 💡 [기능 2] 상/하: 음정 조절 (0프렛 미만 시 자동 줄바꿈, 24프렛 제한 해제)
    if (!e.ctrlKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const amount = e.shiftKey ? 12 : 1;
      const delta = e.key === 'ArrowUp' ? amount : -amount;

      let canMove = true;
      let errorMessage = "";
      const plannedMoves = [];

      // 💡 이동 경로 확보를 위해 선택된 노트들을 이동 방향에 따라 정렬 (충돌 방지)
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
        // 💡 하행(delta<0)이면 더 두꺼운 줄(+1)로, 상행이면 얇은 줄(-1) 방향으로 탐색
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

      if (!canMove) { showToast(errorMessage); return; }

      setSelectedNotes(plannedMoves);
      setScore(prev => {
        let newScore = JSON.parse(JSON.stringify(prev));
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

    // 💡 [기능 3] Ctrl + 상/하: 프렛 유지 줄 이동 (충돌 시 다음 줄 탐색, 0프렛 미만 시 12프렛 보정)
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
        // 💡 이동하려는 방향(stringDelta)으로 빈 줄을 찾을 때까지 한 칸씩 전진
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
          
          // 💡 0프렛 미만으로 감소하면 0 이상이 될 때까지 12프렛(1옥타브) 단위로 덧셈
          while (newFret < 0) {
            newFret += 12;
          }
        }

        beatState[key][bestString] = newFret;
        plannedMoves.push({ ...sel, string: bestString, fret: newFret });
      });

      if (!canMove) { showToast(errorMessage); return; }

      setSelectedNotes(plannedMoves);
      setScore(prev => {
        let newScore = JSON.parse(JSON.stringify(prev));
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

    
    // 💡 [기능 4] - / = : 선택된 복수 노트 길이 동시 조절 및 누적 리플 편집
    if (e.key === '-' || e.key === '=') {
      const stepChange = e.key === '=' ? 1 : -1;
      let newScore = JSON.parse(JSON.stringify(score));
      
      // 1. 모든 비트를 1차원 배열로 풀어서 시간순 정렬 (기존 위치 추적용 데이터 포함)
      let allBeats = [];
      newScore.forEach((m, mIdx) => {
        m.beats.forEach(b => {
          const absTime = Math.round((mIdx * 4 + b.time) * 1000) / 1000;
          allBeats.push({ ...b, absTime, originalMIndex: mIdx, originalTime: b.time });
        });
      });
      allBeats.sort((a, b) => a.absTime - b.absTime);

      // 2. 선택된 노트들의 절대 시간 수집 (중복 제거)
      const selectedAbsTimes = new Set();
      selectedNotes.forEach(sel => {
        selectedAbsTimes.add(Math.round((sel.mIndex * 4 + sel.time) * 1000) / 1000);
      });

      if (selectedAbsTimes.size === 0) return;

      let canMove = true;
      let errorMessage = "";
      let cumulativeShift = 0; // 💡 복수 노트 변경으로 인한 누적 밀림/당김 시간
      let shiftedBeats = [];

      // 3. 누적 리플 연산 및 방어 로직
      for (let i = 0; i < allBeats.length; i++) {
        let b = allBeats[i];
        let newAbsTime = Math.round((b.absTime + cumulativeShift) * 1000) / 1000;
        
        // 방어 1: 0박자 이전으로 당겨지는 경우
        if (newAbsTime < 0) {
          canMove = false;
          errorMessage = "더 이상 노트를 앞으로 당길 수 없습니다 (0박자 미만).";
          break;
        }

        let newDuration = b.duration;

        // 이 비트가 사용자가 선택한 비트라면 박자 변경 및 누적값 갱신
        if (selectedAbsTimes.has(b.absTime)) {
          let currentDurIdx = DURATION_STEPS.findIndex(d => d === b.duration || d * 1.5 === b.duration);
          if (currentDurIdx === -1) currentDurIdx = durIdx; 

          const nextDurIdx = currentDurIdx + stepChange;
          
          // 💡 방어 2: 가장 짧은 박자(32분음표 제한 등) 미만으로 내려가면 취소
          if (nextDurIdx < 0) {
            canMove = false;
            errorMessage = "가장 짧은 박자 제한에 도달하여 더 이상 줄일 수 없습니다.";
            break;
          }
          if (nextDurIdx >= DURATION_STEPS.length) {
            canMove = false;
            errorMessage = "더 이상 박자를 늘릴 수 없습니다.";
            break;
          }

          newDuration = DURATION_STEPS[nextDurIdx] * (isDotted ? 1.5 : 1);
          const timeDelta = Math.round((newDuration - b.duration) * 1000) / 1000;
          
          cumulativeShift = Math.round((cumulativeShift + timeDelta) * 1000) / 1000;
        }
        
        shiftedBeats.push({ ...b, absTime: newAbsTime, duration: newDuration });
      }

      if (!canMove) {
        showToast(errorMessage);
        return;
      }

      // 4. 악보 재조립 및 화음 병합
      let maxMIndex = 0;
      shiftedBeats.forEach(b => maxMIndex = Math.max(maxMIndex, Math.floor(b.absTime / 4)));

      let rebuiltScore = Array.from({ length: Math.max(newScore.length, maxMIndex + 1) }, (_, i) => ({ id: i + 1, beats: [] }));

      shiftedBeats.forEach(b => {
        const mIdx = Math.floor(b.absTime / 4);
        const localTime = Math.round((b.absTime % 4) * 1000) / 1000; 

        const existingBeat = rebuiltScore[mIdx].beats.find(eb => eb.time === localTime);
        if (existingBeat) {
           existingBeat.notes = { ...existingBeat.notes, ...b.notes };
           // 💡 한 행에 화음이 부딪혀 겹쳤을 때 "가장 짧은 노트 기준" 반영
           existingBeat.duration = Math.min(existingBeat.duration, b.duration);
        } else {
           rebuiltScore[mIdx].beats.push({
             time: localTime,
             duration: b.duration,
             notes: b.notes,
             tieId: b.tieId
           });
        }
      });

      // 5. 튕겨나감 없는 복수 선택 영역 좌표 재추적
      const nextSelectedNotes = selectedNotes.map(sel => {
        const matchingShiftedBeat = shiftedBeats.find(b => 
          b.originalMIndex === sel.mIndex && Math.round(b.originalTime * 1000)/1000 === Math.round(sel.time * 1000)/1000
        );
        if (matchingShiftedBeat) {
          const newAbsTime = matchingShiftedBeat.absTime;
          return { ...sel, mIndex: Math.floor(newAbsTime / 4), time: Math.round((newAbsTime % 4) * 1000) / 1000 };
        }
        return sel; 
      });

      // 6. 상태 일괄 동기화 (커서 위치 및 UI 길이)
      const sortedNextSelected = [...nextSelectedNotes].sort((a, b) => (a.mIndex * 4 + a.time) - (b.mIndex * 4 + b.time));
      const nextCursor = { mIndex: sortedNextSelected[0].mIndex, time: sortedNextSelected[0].time };

      let newDurIdx = durIdx;
      if (sortedNextSelected.length > 0) {
        const firstSel = sortedNextSelected[0];
        const firstBeat = rebuiltScore[firstSel.mIndex].beats.find(b => b.time === firstSel.time);
        if (firstBeat) {
           const idx = DURATION_STEPS.findIndex(d => d === firstBeat.duration || d * 1.5 === firstBeat.duration);
           if (idx !== -1) newDurIdx = idx;
        }
      }

      setScore(rebuiltScore);
      setDurIdx(newDurIdx);
      setSelectedNotes(nextSelectedNotes);
      setCursor(nextCursor);
      
      return;
    }
  };

  
  // 💡 2. 기호 모드 (SYMBOL) 컨트롤러
  const handleSymbolModeInput = (e) => {
    const key = e.key;
    // 숫자 1~6을 누르면 해당 줄에 뮤트(X) 기호 추가
    if (['1', '2', '3', '4', '5', '6'].includes(key)) {
      const stringNum = parseInt(key, 10);
      const step = DURATION_STEPS[durIdx] * (isDotted ? 1.5 : 1);
      
      setScore(prev => {
        let newScore = JSON.parse(JSON.stringify(prev));
        let cMeasure = newScore[cursor.mIndex];
        
        if (!cMeasure) {
          while (newScore.length <= cursor.mIndex) {
            newScore.push({ id: newScore.length + 1, beats: [] });
          }
          cMeasure = newScore[cursor.mIndex];
        }
        
        let beat = cMeasure.beats.find(b => b.time === cursor.time);
        if (!beat) {
          beat = { time: cursor.time, duration: step, notes: {} };
          cMeasure.beats.push(beat);
        }
        
        beat.notes[stringNum] = 'X';
        return newScore;
      });
    }
  };


  const handleKeyDown = useCallback((e) => {
    // 💡 [기능 개선] 입력창(BPM 등)에 글씨를 쓰고 있을 때는 단축키를 완전히 무시
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // 💡 [기능 개선] 화면 스크롤 방지 (스페이스바, 방향키 등)
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
      e.preventDefault();
    }
    
    // 2. 모드 전환
    // 💡 2. 모드 전환
    if (e.key === '`') {
      e.preventDefault();
      if (editorMode === 'SELECT') {
        setEditorMode('INPUT');
        setSelectedNotes([]);
      } else {
        setEditorMode('SELECT');
        
        // 💡 선택 모드 진입과 동시에 가장 가까운 노트 자동 포커스
        let allNotes = [];
        score.forEach((measure) => {
          measure.beats.forEach((beat) => {
            Object.entries(beat.notes).forEach(([str, fret]) => {
              allNotes.push({ mIndex: measure.id - 1, time: beat.time, string: parseInt(str), fret, duration: beat.duration });
            });
          });
        });

        if (allNotes.length > 0) {
          allNotes.sort((a, b) => {
            if (a.mIndex !== b.mIndex) return a.mIndex - b.mIndex;
            if (a.time !== b.time) return a.time - b.time;
            return a.string - b.string;
          });
          const closestNote = allNotes.find(n => n.mIndex > cursor.mIndex || (n.mIndex === cursor.mIndex && n.time >= cursor.time)) || allNotes[allNotes.length - 1];
          setSelectedNotes([closestNote]);
        }
      }
      return;
    }
    if (e.key === ']') {
      e.preventDefault();
      setEditorMode(prev => prev === 'SYMBOL' ? 'INPUT' : 'SYMBOL');
      return;
    }

    // 3. 모드별 분기
    if (editorMode === 'SELECT') {
      handleSelectModeInput(e);
      return;
    }
    if (editorMode === 'SYMBOL') {
      handleSymbolModeInput(e);
      return;
    }

    // --- 아래부터는 기존 INPUT 모드 (입력 및 커서 이동) ---
    const key = e.key.toLowerCase();
    
    // 💡 화면 스크롤 방지
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();

    // 💡 [단축키 추가] Shift 키로 Bass(1옥타브 하향) 토글
    if (e.key === 'Shift') {
      e.preventDefault();
      setIsOctaveDown(prev => !prev);
      return;
    }

    if (PIANO_MAP[key] !== undefined && !e.repeat) {
      activeKeysRef.current.add(key);
      chordAccumulatorRef.current.add(key);
      setActiveUIKeys(new Set(activeKeysRef.current));
      return;
    }

    // 💡 수정됨: - / = 와 함께 ArrowDown / ArrowUp 에도 박자 조절 기능 매핑
    if (key === '-' || e.key === 'ArrowDown') setDurIdx(p => Math.max(0, p - 1));
    if (key === '=' || e.key === 'ArrowUp') setDurIdx(p => Math.min(DURATION_STEPS.length - 1, p + 1));
    if (key === '\\') setIsDotted(p => !p);

    if (e.key === 'Delete' || e.key === 'Backspace') {
      setScore(prev => {
        let newScore = JSON.parse(JSON.stringify(prev));
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

    const step = DURATION_STEPS[durIdx] * (isDotted ? 1.5 : 1);
    
    if (e.key === 'ArrowRight') {
      let nextTime = cursor.time + step;
      let nextMIndex = cursor.mIndex;
      while (nextTime >= 4) { 
        nextMIndex += 1; 
        nextTime -= 4; 
      }
      setScore(prev => {
        if (nextMIndex >= prev.length) {
          let newScore = [...prev];
          while (newScore.length <= nextMIndex) {
            newScore.push({ id: newScore.length + 1, beats: [] });
          }
          return newScore;
        }
        return prev;
      });
      setCursor({ mIndex: nextMIndex, time: nextTime });
    }
    
    if (e.key === 'ArrowLeft') {
      let nextTime = cursor.time - step;
      let nextMIndex = cursor.mIndex;
      if (nextTime < 0 && nextMIndex > 0) { nextMIndex -= 1; nextTime += 4; }
      else if (nextTime < 0) { nextTime = 0; }
      setCursor({ mIndex: nextMIndex, time: nextTime });
    }
  }, [score, cursor, durIdx, isDotted, editorMode, selectedNotes]);

  const handleKeyUp = useCallback((e) => {
    // (기존 handleKeyUp 코드 그대로 유지)
    const key = e.key.toLowerCase();
    if (PIANO_MAP[key] !== undefined) {
      activeKeysRef.current.delete(key);
      setActiveUIKeys(new Set(activeKeysRef.current));

      if (activeKeysRef.current.size === 0 && chordAccumulatorRef.current.size > 0) {
        insertChord(new Set(chordAccumulatorRef.current));
        chordAccumulatorRef.current.clear(); 
      }
    }
  }, [cursor, durIdx, isDotted]);

  // 💡 4. 이벤트 리스너 등록 (깔끔하게 분리됨)
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
    const isWActive = activeUIKeys.has(wKey);
    const isBActive = bKey && activeUIKeys.has(bKey);

    return (
      <div style={{
        position: 'relative', width: '38px', height: '35px',  // 💡 높이 90px -> 35px로 축소
        backgroundColor: isWActive ? '#3b82f6' : '#fff', 
        border: '1px solid #ccc', borderRadius: '0 0 4px 4px', 
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center', 
        paddingBottom: '3px', fontWeight: 'bold', fontSize: '11px',
        color: isWActive ? '#fff' : '#666', zIndex: 1
      }}>
        {whiteLabel.toUpperCase()}
        
        {blackLabel && (
          <div style={{
            position: 'absolute', top: 0, right: '-12px', 
            width: '24px', height: '20px', // 💡 흑건 높이 55px -> 20px로 축소
            backgroundColor: isBActive ? '#3b82f6' : '#222', 
            borderRadius: '0 0 3px 3px', 
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center', 
            paddingBottom: '2px', color: '#fff', fontSize: '9px', zIndex: 10
          }}>
            {blackLabel.toUpperCase()}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ padding: '40px', fontFamily: 'sans-serif', backgroundColor: '#f5f5f5', minHeight: '100vh', color: '#333', paddingBottom: '300px' }}>
      
      {toastMsg && (
        <div style={{ position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', backgroundColor: '#ef4444', color: '#fff', padding: '10px 20px', borderRadius: '8px', zIndex: 1000, boxShadow: '0 4px 6px rgba(0,0,0,0.1)', fontWeight: 'bold' }}>
          {toastMsg}
        </div>
      )}

      {/* 💡 왼쪽 엣지 헬프 버튼 (복구됨) */}
      <div 
        onClick={() => setIsHelpOpen(true)}
        style={{
          position: 'fixed', left: 0, top: '50%', transform: 'translateY(-50%)',
          width: '28px', height: '100px', backgroundColor: '#333', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', borderTopRightRadius: '8px', borderBottomRightRadius: '8px',
          boxShadow: '2px 0 8px rgba(0,0,0,0.2)', zIndex: 1000, transition: 'background-color 0.2s'
        }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#555'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#333'}
      >
        <span style={{ writingMode: 'vertical-rl', fontSize: '13px', letterSpacing: '3px', fontWeight: 'bold' }}>HELP</span>
      </div>

      {/* 💡 헬프 팝업 모달 (최신 단축키 반영) */}
      {isHelpOpen && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, 
          backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 2000, 
          display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)'
        }} onClick={() => setIsHelpOpen(false)}>
          <div style={{
            backgroundColor: '#fff', padding: '30px', borderRadius: '12px', 
            width: '450px', boxShadow: '0 10px 25px rgba(0,0,0,0.2)'
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, borderBottom: '2px solid #eee', paddingBottom: '15px' }}>조작법 가이드</h3>
            
            <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: '10px' }}>
                <h4 style={{ color: '#3b82f6', marginBottom: '5px' }}>🎵 통상 (INPUT) 모드</h4>
                <ul style={{ paddingLeft: '20px', marginTop: 0, fontSize: '14px', color: '#444', lineHeight: '1.6' }}>
                  <li><b>키보드 Z ~ /</b> : 피아노 건반 (하단)</li>
                  <li><b>키보드 Q ~ P</b> : 피아노 건반 (상단)</li>
                  <li><b>- / +</b> : 커서 이동 단위(박자) 변경</li>
                  <li><b>\ (백슬래쉬)</b> : 점음표 토글</li>
                  <li><b>Shift</b> : 1옥타브 하향 입력 토글 (Bass)</li>
                  <li><b>방향키</b> : 커서 이동 (마우스 클릭 스냅 지원)</li>
                  <li><b>Del / Backspace</b> : 커서 위치의 노트 삭제</li>
                </ul>

                <h4 style={{ color: '#10b981', marginBottom: '5px' }}>🖱️ 선택 (SELECT) 모드 <span style={{fontSize:'12px', color:'#888'}}>( ` 백틱 키로 진입 )</span></h4>
                <ul style={{ paddingLeft: '20px', marginTop: 0, fontSize: '14px', color: '#444', lineHeight: '1.6' }}>
                  <li><b>방향키 좌/우</b> : 노트 순차 탐색 (화음 포함)</li>
                  <li><b>방향키 위/아래</b> : 음정 조절 (자동 줄바꿈 적용)</li>
                  <li><b>Shift + 위/아래</b> : 1 옥타브 조절</li>
                  <li><b>Ctrl + 위/아래</b> : 프렛 유지 줄 이동 (옥타브 보정)</li>
                  <li><b>- / +</b> : 선택된 노트 길이 조절 (리플 편집)</li>
                </ul>

                <h4 style={{ color: '#f59e0b', marginBottom: '5px' }}>🎸 특수 기호 (SYMBOL) 모드 <span style={{fontSize:'12px', color:'#888'}}>( ] 키로 진입 )</span></h4>
                <ul style={{ paddingLeft: '20px', marginTop: 0, fontSize: '14px', color: '#444', lineHeight: '1.6' }}>
                  <li><b>1 ~ 6</b> : 해당 줄에 뮤트음(X) 삽입</li>
                </ul>
            </div>

            <button 
              onClick={() => setIsHelpOpen(false)}
              style={{ marginTop: '20px', padding: '10px 16px', width: '100%', backgroundColor: '#3b82f6', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '15px' }}
            >닫기</button>
          </div>
        </div>
      )}
      
      {/* 💡 퀵 가이드 및 모드 상태 인디케이터 (스크롤해도 우측 상단에 고정) */}
      <div style={{ 
        position: 'fixed', top: '20px', right: '20px', 
        backgroundColor: editorMode === 'INPUT' ? '#3b82f6' : (editorMode === 'SELECT' ? '#10b981' : '#f59e0b'), 
        color: '#fff', padding: '14px 20px', borderRadius: '12px', 
        boxShadow: '0 4px 15px rgba(0,0,0,0.2)', zIndex: 1000,
        display: 'flex', flexDirection: 'column', gap: '8px', transition: 'background-color 0.3s'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', fontSize: '15px' }}>
          <div style={{ width: '10px', height: '10px', backgroundColor: '#fff', borderRadius: '50%', opacity: 0.9 }} />
          {editorMode === 'INPUT' && '통상 (INPUT) 모드'}
          {editorMode === 'SELECT' && '선택 (SELECT) 모드'}
          {editorMode === 'SYMBOL' && '특수 기호 (SYMBOL) 모드'}
        </div>
        <div style={{ fontSize: '12px', opacity: 0.9, lineHeight: '1.5', whiteSpace: 'pre-wrap' }}>
          {editorMode === 'INPUT' && '클릭 : 커서 스냅 이동\nShift : 1옥타브 하향 토글(Bass)\n방향키 ↕ : 박자 조절\n건반(Z~P) : 음표 입력'}
          {editorMode === 'SELECT' && '방향키 ↔ : 순차 탐색\n방향키 ↕ : 음정 조절 (자동 줄바꿈)\nCtrl + ↕ : 줄 이동 (+옥타브 보정)\n- / = : 리플 편집'}
          {editorMode === 'SYMBOL' && '숫자 1~6 : 뮤트(X) 입력'}
        </div>
      </div>

      {/* 💡 상단 툴바 영역 (제목 삭제 및 좌측 정렬) */}
      <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', marginBottom: '20px', gap: '15px' }}>
        
        {/* 🎵 재생 컨트롤 패널 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', backgroundColor: '#e5e7eb', padding: '6px 16px', borderRadius: '30px', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.05)' }}>
          <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#555' }}>BPM:</span>
          <input 
            type="number" 
            value={bpm} 
            onChange={(e) => setBpm(Number(e.target.value))}
            style={{ width: '50px', padding: '4px', border: '1px solid #ccc', borderRadius: '4px', textAlign: 'center', fontWeight: 'bold' }}
          />
          <div style={{ width: '2px', height: '20px', backgroundColor: '#ccc', margin: '0 4px' }} />
          
          <button onClick={() => handlePlay(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', display: 'flex', alignItems: 'center', opacity: playbackState === 'PLAYING' ? 0.5 : 1 }} title="처음부터 재생">⏪</button>
          <button onClick={() => handlePlay(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', display: 'flex', alignItems: 'center', opacity: playbackState === 'PLAYING' ? 0.5 : 1 }} title="커서 위치부터 재생">▶️</button>
          <button onClick={handleStop} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', display: 'flex', alignItems: 'center', color: playbackState === 'PLAYING' ? '#ef4444' : 'inherit' }} title="정지">⏹️</button>
        </div>
        
        {/* 💾 데이터 관리 버튼 그룹 */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={handleExportJSON} style={{ padding: '8px 12px', backgroundColor: '#4b5563', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}>💾 저장</button>
          <label style={{ padding: '8px 12px', backgroundColor: '#4b5563', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}>
            📂 불러오기 <input type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportJSON} />
          </label>
          <button onClick={handleResetScore} style={{ padding: '8px 12px', backgroundColor: '#ef4444', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px' }}>🗑️ 초기화</button>
        </div>
      </div>
      
      <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', boxShadow: '0 2px 10px rgba(0,0,0,0.1)' }}>
        {layout.map((lineChunks, lineIdx) => (
          <div key={`line-${lineIdx}`} style={{ display: 'flex', width: `${MAX_LINE_WIDTH * UNIT}px`, marginBottom: '40px', position: 'relative' }}>
            {lineChunks.map((chunk, chunkIdx) => {
              const svgWidth = chunk.width * UNIT;
              const timeRange = chunk.timeEnd - chunk.timeStart;
              const isCursorHere = cursor.mIndex === chunk.mIndex && cursor.time >= chunk.timeStart && cursor.time < chunk.timeEnd;
              const innerWidth = svgWidth - (SIDE_PADDING * 2); 
              let cursorX = 0;
              if (isCursorHere) cursorX = SIDE_PADDING + ((cursor.time - chunk.timeStart) / timeRange) * innerWidth;

              return (
                <svg 
                  key={`chunk-${chunk.measureId}-${chunkIdx}`} 
                  width={svgWidth} 
                  height={HEIGHT} 
                  style={{ overflow: 'visible', cursor: editorMode === 'INPUT' ? 'pointer' : 'default' }}
                  onClick={(e) => {
                    // 💡 INPUT 모드일 때만 클릭 이동 허용
                    if (editorMode !== 'INPUT') return;
                    
                    const rect = e.currentTarget.getBoundingClientRect();
                    const clickX = e.clientX - rect.left;
                    const innerWidth = svgWidth - (SIDE_PADDING * 2); 
                    
                    let timeRatio = (clickX - SIDE_PADDING) / innerWidth;
                    if (timeRatio < 0) timeRatio = 0;
                    if (timeRatio > 0.999) timeRatio = 0.999; 
                    
                    const exactTime = chunk.timeStart + timeRatio * timeRange;
                    const step = DURATION_STEPS[durIdx] * (isDotted ? 1.5 : 1);
                    
                    // 💡 설정된 박자 단위(step)에 맞춰 내림 연산 후 스냅
                    const snappedTime = Math.round(Math.floor(exactTime / step) * step * 1000) / 1000;
                    
                    setCursor({ mIndex: chunk.mIndex, time: snappedTime });
                  }}
                >
                  {[...Array(STRING_COUNT)].map((_, i) => (
                    <line key={i} x1="0" y1={TOP_PADDING + i * STRING_SPACING} x2={svgWidth} y2={TOP_PADDING + i * STRING_SPACING} stroke="#aaa" strokeWidth="1" />
                  ))}

                  {(chunk.type === 'full' || chunk.type === 'start') && <line x1="0" y1={TOP_PADDING} x2="0" y2={TOP_PADDING + STRING_SPACING * 5} stroke="#333" strokeWidth="2" />}
                  {(chunk.type === 'full' || chunk.type === 'end') && <line x1={svgWidth} y1={TOP_PADDING} x2={svgWidth} y2={TOP_PADDING + STRING_SPACING * 5} stroke="#333" strokeWidth="2" />}

                  {isCursorHere && <rect x={cursorX - 10} y={TOP_PADDING - 15} width="20" height={STRING_SPACING * 5 + 30} fill="rgba(0, 120, 255, 0.15)" rx="4" />}

                  {chunk.beats.map((beat, bIdx) => {
                    const xPos = SIDE_PADDING + ((beat.time - chunk.timeStart) / timeRange) * innerWidth;
                    return (
                      <g key={bIdx}>
                        {Object.entries(beat.notes).map(([string, fret]) => {
                          const strIdx = parseInt(string, 10) - 1;
                          const yPos = TOP_PADDING + strIdx * STRING_SPACING;
                          
                          const isTieStart = beat.tieId && beat.time > 0;
                          const isTieEnd = beat.tieId && beat.time === 0;
                          
                          const isLastChunk = chunkIdx === lineChunks.length - 1;
                          const isFirstChunk = chunkIdx === 0;

                          const isSelected = selectedNotes.some(sel => sel.mIndex === chunk.mIndex && sel.time === beat.time && sel.string === strIdx + 1);

                          return (
                            <g key={string}>
                              {/* 1. 같은 줄에서 이어지는 경우 */}
                              {isTieStart && !isLastChunk && (
                                <path 
                                  d={`M ${xPos + 8} ${yPos + 12} Q ${(xPos + svgWidth + SIDE_PADDING) / 2} ${yPos + 24} ${svgWidth + SIDE_PADDING - 8} ${yPos + 12}`} 
                                  fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" 
                                />
                              )}
                              
                              {/* 2. 줄바꿈 직전 나가는 이음줄 */}
                              {isTieStart && isLastChunk && (
                                <path 
                                  d={`M ${xPos + 8} ${yPos + 12} Q ${xPos + 30} ${yPos + 22} ${svgWidth + 15} ${yPos + 18}`} 
                                  fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" 
                                />
                              )}
                              
                              {/* 3. 줄바꿈 직후 들어오는 이음줄 */}
                              {isTieEnd && isFirstChunk && (
                                <path 
                                  d={`M -15 ${yPos + 18} Q ${xPos - 30} ${yPos + 22} ${xPos - 8} ${yPos + 12}`} 
                                  fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" 
                                />
                              )}

                              {/* 노트 배경 및 텍스트 (선택 시 파란색으로 반전) */}
                              <rect x={xPos - 8} y={yPos - 8} width="16" height="16" fill={isSelected ? "#3b82f6" : "#fff"} rx="3" />
                              <text x={xPos} y={yPos + 5} fontSize="14" fill={isSelected ? "#fff" : "#000"} textAnchor="middle" fontWeight="bold">
                                {fret}
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

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, backgroundColor: '#2b2b2b', padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', borderTop: '4px solid #000', zIndex: 100 }}>
        
        {/* 💡 상태 표시줄 (Shift Bass 상태 추가됨) */}
        <div style={{ display: 'flex', gap: '20px', color: '#aaa', fontSize: '13px', marginBottom: '8px', backgroundColor: '#1a1a1a', padding: '8px 20px', borderRadius: '20px' }}>
          <span><kbd style={{color:'#fff'}}>-</kbd> <kbd style={{color:'#fff'}}>+</kbd> 이동: <b>{DURATION_STEPS[durIdx]}박</b></span>
          <span><kbd style={{color:'#fff'}}>\</kbd> 점음표: <b style={{color: isDotted ? '#3b82f6' : '#aaa'}}>{isDotted ? 'ON' : 'OFF'}</b></span>
          <span><kbd style={{color:'#fff'}}>Shift</kbd> Bass: <b style={{color: isOctaveDown ? '#3b82f6' : '#aaa'}}>{isOctaveDown ? 'ON' : 'OFF'}</b></span>
          <span><kbd style={{color:'#fff'}}>←</kbd> <kbd style={{color:'#fff'}}>→</kbd> 커서</span>
          <span><kbd style={{color:'#fff'}}>Del</kbd> 삭제</span>
        </div>

        {/* 윗줄 건반 */}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
          {TOP_ROW.map((keyData) => (
            <PianoKey key={keyData.w} whiteLabel={keyData.w} blackLabel={keyData.b} />
          ))}
        </div>

        {/* 아랫줄 건반 */}
        <div style={{ display: 'flex', gap: '4px' }}>
          {BOTTOM_ROW.map((keyData) => (
            <PianoKey key={keyData.w} whiteLabel={keyData.w} blackLabel={keyData.b} />
          ))}
        </div>
      </div>
    </div>
  );
}