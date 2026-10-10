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
  const [score, setScore] = useState(initialScore);
  const [cursor, setCursor] = useState({ mIndex: 0, time: 0 });
  const [durIdx, setDurIdx] = useState(2); 
  const [isDotted, setIsDotted] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  
  const [activeUIKeys, setActiveUIKeys] = useState(new Set());
  const activeKeysRef = useRef(new Set()); 
  const chordAccumulatorRef = useRef(new Set()); 

  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2000);
  };

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

      keysToProcess.forEach(key => {
        const midi = PIANO_MAP[key];
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

      if (collisionOccurred) showToast("입력할 자리가 없습니다!");

      if (Object.keys(b1.notes).length === 0) cMeasure.beats = cMeasure.beats.filter(b => b !== b1);
      if (tieNeeded && Object.keys(b2.notes).length === 0) nMeasure.beats = nMeasure.beats.filter(b => b !== b2);

      return newScore;
    });

    // 💡 3. 계산해둔 다음 위치로 커서 이동
    setCursor({ mIndex: nextMIndex, time: nextTime });
  };

  const handleKeyDown = useCallback((e) => {
    const key = e.key.toLowerCase();
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();

    if (PIANO_MAP[key] !== undefined && !e.repeat) {
      activeKeysRef.current.add(key);
      chordAccumulatorRef.current.add(key);
      setActiveUIKeys(new Set(activeKeysRef.current));
      return;
    }

    if (key === '-') setDurIdx(p => Math.max(0, p - 1));
    if (key === '=') setDurIdx(p => Math.min(DURATION_STEPS.length - 1, p + 1));
    if (key === '\\') setIsDotted(p => !p);

    if (e.key === 'Delete' || e.key === 'Backspace') {
      setScore(prev => {
        let newScore = JSON.parse(JSON.stringify(prev));
        const measure = newScore[cursor.mIndex];
        if (!measure) return newScore; // 💡 안전장치 추가

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
    
    // 💡 방향키 이동 시에도 빈 마디 자동 생성 보장
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
  }, [cursor, durIdx, isDotted]);

  const handleKeyUp = useCallback((e) => {
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
        position: 'relative', width: '38px', height: '90px', 
        backgroundColor: isWActive ? '#3b82f6' : '#fff', 
        border: '1px solid #ccc', borderRadius: '0 0 6px 6px', 
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center', 
        paddingBottom: '10px', fontWeight: 'bold', 
        color: isWActive ? '#fff' : '#666', zIndex: 1
      }}>
        {whiteLabel.toUpperCase()}
        
        {blackLabel && (
          <div style={{
            position: 'absolute', top: 0, right: '-12px', 
            width: '24px', height: '55px', 
            backgroundColor: isBActive ? '#3b82f6' : '#222', 
            borderRadius: '0 0 4px 4px', 
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center', 
            paddingBottom: '5px', color: '#fff', fontSize: '11px', zIndex: 10
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

      <h2 style={{ marginBottom: '10px' }}>Guitar TAB Editor (Pro)</h2>
      
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
                <svg key={`chunk-${chunk.measureId}-${chunkIdx}`} width={svgWidth} height={HEIGHT} style={{ overflow: 'visible' }}>
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
                          
                          // 💡 현재 노트가 이음줄의 시작인지 끝인지 파악
                          const isTieStart = beat.tieId && beat.time > 0;
                          const isTieEnd = beat.tieId && beat.time === 0;
                          
                          // 💡 줄바꿈(Line Break) 발생 여부 파악
                          const isLastChunk = chunkIdx === lineChunks.length - 1;
                          const isFirstChunk = chunkIdx === 0;

                          return (
                            <g key={string}>
                              {/* 1. 같은 줄에서 이어지는 경우: 다음 마디 노트까지 한 번에 부드럽게 이어지는 긴 호를 그림 */}
                              {isTieStart && !isLastChunk && (
                                <path 
                                  d={`M ${xPos + 8} ${yPos + 12} Q ${(xPos + svgWidth + SIDE_PADDING) / 2} ${yPos + 24} ${svgWidth + SIDE_PADDING - 8} ${yPos + 12}`} 
                                  fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" 
                                />
                              )}
                              
                              {/* 2. 줄바꿈 직전 나가는 이음줄: 오른쪽 허공으로 자연스럽게 끊어지듯 그려짐 */}
                              {isTieStart && isLastChunk && (
                                <path 
                                  d={`M ${xPos + 8} ${yPos + 12} Q ${xPos + 30} ${yPos + 22} ${svgWidth + 15} ${yPos + 18}`} 
                                  fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" 
                                />
                              )}
                              
                              {/* 3. 줄바꿈 직후 들어오는 이음줄: 이전 줄에서 넘어와 왼쪽 허공에서 나타나듯 그려짐 */}
                              {isTieEnd && isFirstChunk && (
                                <path 
                                  d={`M -15 ${yPos + 18} Q ${xPos - 30} ${yPos + 22} ${xPos - 8} ${yPos + 12}`} 
                                  fill="none" stroke="#333" strokeWidth="1.5" strokeLinecap="round" 
                                />
                              )}

                              {/* 노트 배경 및 텍스트 (이음줄 위를 덮어 깔끔하게 유지) */}
                              <rect x={xPos - 8} y={yPos - 8} width="16" height="16" fill="#fff" />
                              <text x={xPos} y={yPos + 5} fontSize="14" fill="#000" textAnchor="middle" fontWeight="bold">
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

      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, backgroundColor: '#2b2b2b', padding: '15px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', borderTop: '4px solid #000', zIndex: 100 }}>
        
        <div style={{ display: 'flex', gap: '20px', color: '#aaa', fontSize: '13px', marginBottom: '15px', backgroundColor: '#1a1a1a', padding: '8px 20px', borderRadius: '20px' }}>
          <span><kbd style={{color:'#fff'}}>-</kbd> <kbd style={{color:'#fff'}}>=</kbd> 이동: <b>{DURATION_STEPS[durIdx]}박</b></span>
          <span><kbd style={{color:'#fff'}}>\</kbd> 점음표: <b style={{color: isDotted ? '#3b82f6' : '#aaa'}}>{isDotted ? 'ON' : 'OFF'}</b></span>
          <span><kbd style={{color:'#fff'}}>←</kbd> <kbd style={{color:'#fff'}}>→</kbd> 커서</span>
          <span><kbd style={{color:'#fff'}}>Del</kbd> 삭제</span>
        </div>

        {/* 윗줄 건반 (2,3개 묶음 배치 적용) */}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
          {TOP_ROW.map((keyData) => (
            <PianoKey key={keyData.w} whiteLabel={keyData.w} blackLabel={keyData.b} />
          ))}
        </div>

        {/* 아랫줄 건반 (2,3개 묶음 배치 적용) */}
        <div style={{ display: 'flex', gap: '4px' }}>
          {BOTTOM_ROW.map((keyData) => (
            <PianoKey key={keyData.w} whiteLabel={keyData.w} blackLabel={keyData.b} />
          ))}
        </div>
      </div>
    </div>
  );
}