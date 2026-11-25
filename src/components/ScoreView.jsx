// 악보 화면: VexFlow가 줄마다 오선보/TAB을 그리고, 그 위 투명한 층에서 커서·선택·클릭을 처리
//
// 좌표는 모두 notation.js의 engrave 결과에서 가져온다. 그래서 오선보만, 둘 다, TAB만 세 가지 보기에서
// 커서·선택·클릭·재생 진행 바가 같은 코드로 동작한다.

import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { Renderer } from 'vexflow/bravura';
import { engrave, timeToX, xToTime } from '../lib/notation';

const CURSOR_HALF_WIDTH = 9;
const CURSOR_MARGIN = 7; // 줄 위아래로 넘치는 정도

// 테마 색을 CSS 변수에서 읽어 VexFlow에 넘김 (VexFlow는 색을 직접 받아야 함)
//   el: 악보 안의 요소. 테마는 .app의 data-theme로 정해지므로 문서 루트가 아니라 그 안에서 읽어야
//   테마를 바꾼 바로 그 렌더링에서 새 색을 얻음
const readColors = (el) => {
  const css = getComputedStyle(el);
  const v = (name) => css.getPropertyValue(name).trim();
  return { ink: v('--ink'), staff: v('--staff'), page: v('--page'), danger: v('--play') };
};

// 마디가 보이는 세로 범위 (오선 맨 위 줄 ~ TAB 맨 아래 줄)
export const measureSpanY = (m) => {
  const ys = [...(m.staffLines || []), ...(m.tabLines || [])];
  return [Math.min(...ys) - CURSOR_MARGIN, Math.max(...ys) + CURSOR_MARGIN];
};

// 엔그레이빙 결과에서 (마디, 위치)가 있는 줄과 마디 찾기
export const findMeasure = (engraving, mIndex) => {
  for (let li = 0; li < engraving.lines.length; li++) {
    const m = engraving.lines.at(li).measures.find((mm) => mm.mIndex === mIndex);
    if (m) return { lineIndex: li, measure: m };
  }
  return null;
};

export default function ScoreView({
  score, view, tieInfo, theme, notation, cursor, selectedNotes, step, clickable, onPickPosition, engravingRef, lineElsRef,
}) {
  const engraving = useMemo(() => engrave(score, view, tieInfo, theme, notation), [score, view, tieInfo, theme, notation]);
  const vfRefs = useRef([]);
  const drawnRef = useRef([]); // 줄마다 마지막으로 그린 { line, theme } (바뀐 줄만 다시 그림)

  // 진행 바 계산용으로 바깥(App)에 최신 엔그레이빙을 알려 줌
  useLayoutEffect(() => {
    if (engravingRef) engravingRef.current = engraving;
  }, [engraving, engravingRef]);

  // VexFlow로 줄마다 그리기 (악보나 테마가 바뀔 때)
  useLayoutEffect(() => {
    const first = vfRefs.current.find(Boolean);
    if (!first) return;
    const colors = readColors(first);
    engraving.lines.forEach((line, i) => {
      const el = vfRefs.current[i];
      if (!el) return;
      const drawn = drawnRef.current[i];
      if (drawn && drawn.line === line && drawn.theme === theme && el.firstChild) return;
      drawnRef.current[i] = { line, theme };
      el.innerHTML = '';
      const renderer = new Renderer(el, Renderer.Backends.SVG);
      renderer.resize(line.width, line.height);
      line.draw(renderer.getContext(), colors);
    });
  }, [engraving, theme]);

  const isSelected = (mIndex, time, id) =>
    selectedNotes.some((s) => s.mIndex === mIndex && s.time === time && s.id === id);

  // 클릭한 위치 → (마디, 박자 단위로 내림한 위치)
  const handleClick = (e, line) => {
    if (!clickable) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const m = line.measures.find((mm) => x >= mm.x0 && x < mm.x1);
    if (!m) return;
    const time = Math.min(Math.max(0, xToTime(m, x)), m.len - 1);
    onPickPosition({ mIndex: m.mIndex, time: Math.floor(time / step) * step });
  };

  return (
    <>
      {engraving.lines.map((line, li) => (
        <div
          key={li}
          className="score-line"
          style={{ width: line.width, height: line.height }}
          ref={(el) => { if (lineElsRef) lineElsRef.current[li] = el; }}
        >
          <div className="vf-layer" ref={(el) => { vfRefs.current[li] = el; }} />

          <svg
            className="score-overlay"
            width={line.width}
            height={line.height}
            style={{ cursor: clickable ? 'pointer' : 'default' }}
            onClick={(e) => handleClick(e, line)}
          >
            {line.measures.map((m) => {
              const [y0, y1] = measureSpanY(m);
              const cursorHere = cursor.mIndex === m.mIndex && cursor.time < m.len;
              const numberY = (m.staffLines ? m.staffLines[0] : m.tabLines[0]) - 12;
              return (
                <g key={m.mIndex}>
                  {/* 마디 번호 */}
                  <text x={m.x0 + 3} y={numberY} fontSize="10" fontStyle="italic" style={{ fill: 'var(--muted)' }}>
                    {m.mIndex + 1}
                  </text>

                  {cursorHere && (
                    <rect
                      x={timeToX(m, cursor.time) - CURSOR_HALF_WIDTH} y={y0}
                      width={CURSOR_HALF_WIDTH * 2} height={y1 - y0}
                      style={{ fill: 'var(--accent-soft)' }}
                    />
                  )}

                  {/* 기타로 칠 수 없는 음(줄이 없음): TAB 그 자리 위에 빨간 표시 */}
                  {m.tabLines && m.events.filter((ev) => ev.notes.some((n) => n.unplaced)).map((ev) => (
                    <text key={`u-${ev.time}`} x={ev.tabX ?? ev.staffX ?? ev.x} y={m.tabLines[0] - 5} fontSize="12" fontWeight="700"
                      textAnchor="middle" className="unplaced-mark" style={{ fill: 'var(--play)' }}>
                      <title>기타로 칠 수 없는 음 (E2보다 낮거나 줄이 모자람)</title>?
                    </text>
                  ))}

                  {/* 선택한 음: TAB은 숫자를 반전, 오선보는 음표 머리에 표시 */}
                  {m.events.map((ev) => ev.notes.map((n) => {
                    if (!isSelected(m.mIndex, ev.time, n.id)) return null;
                    const label = String(n.fret);
                    const w = label.length > 1 ? 16 : 11;
                    return (
                      <g key={`${ev.time}-${n.id}`} className="selected-note">
                        {n.tabY !== null && (
                          <>
                            <rect x={ev.tabX - w / 2} y={n.tabY - 7} width={w} height="14" rx="1.5" style={{ fill: 'var(--accent)' }} />
                            <text x={ev.tabX} y={n.tabY + 4.5} fontSize="12" fontWeight="600" textAnchor="middle"
                              className="fret-text" style={{ fill: 'var(--accent-text)' }}>{label}</text>
                          </>
                        )}
                        {n.staffY !== null && (
                          <ellipse cx={ev.staffX} cy={n.staffY} rx="7.5" ry="5.5"
                            style={{ fill: 'var(--accent)', fillOpacity: 0.45, stroke: 'var(--accent)', strokeWidth: 1.5 }} />
                        )}
                      </g>
                    );
                  }))}
                </g>
              );
            })}
          </svg>
        </div>
      ))}
    </>
  );
}
