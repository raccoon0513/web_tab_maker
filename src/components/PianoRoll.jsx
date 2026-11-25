// 튜토: 악보를 피아노 튜토리얼(떨어지는 막대 + 건반)로 보여주는 화면
//
// - 위에서 막대가 떨어져 아래 건반에 닿는 순간 그 음이 울린다. 막대 길이 = 음 길이
// - 그리기는 canvas: 음이 수천 개여도 매 프레임 다시 그릴 수 있게 React를 거치지 않음
// - 지금 시각(초)은 이 컴포넌트가 들고 있고, App은 controlRef로 읽고 바꾼다
//     controlRef.current = { getTime(), setTime(sec), START_TIME }
//   재생 중에는 App의 화면 루프가 매 프레임 setTime을 부름
// - 멈춰 있을 때 마우스 휠로 앞뒤 이동 (아래로 굴리면 앞으로)

import { useEffect, useLayoutEffect, useRef } from 'react';
import { keyRange, layoutKeys, notesInWindow, formatClock, measureAt } from '../lib/tutorial';

export const START_TIME = -1.5;     // 처음 위치: 첫 음이 건반 조금 위에서 떨어지기 시작
const PIXELS_PER_SEC = 140;         // 떨어지는 속도
const KEYBOARD_HEIGHT = 110;
const BLACK_KEY_HEIGHT = 0.62;      // 검은 건반 길이 (흰 건반 대비)
const WHEEL_SEC_PER_PX = 1 / 240;   // 휠 감도

const readColors = (el) => {
  const css = getComputedStyle(el);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    page: v('--page'), ink: v('--ink'), staff: v('--staff'), line: v('--line'), muted: v('--muted'),
    keyWhite: v('--key-white'), keyBlack: v('--key-black'),
    note: v('--roll-note'),
  };
};

const roundRect = (ctx, x, y, w, h, r) => {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
};

export default function PianoRoll({ timeline, theme, playing, controlRef }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const timeRef = useRef(START_TIME);
  const drawRef = useRef(() => {});
  const playingRef = useRef(playing);
  playingRef.current = playing;


  // App이 쓰는 조작 손잡이
  useLayoutEffect(() => {
    controlRef.current = {
      START_TIME,
      getTime: () => timeRef.current,
      setTime: (sec) => { timeRef.current = sec; drawRef.current(); },
    };
    return () => { controlRef.current = null; };
  }, [controlRef]);

  // 크기·곡·테마가 바뀌면 배치를 다시 계산하고 그리기 함수를 새로 만듦
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;

    const setup = () => {
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext('2d');
      const colors = readColors(wrap);
      const range = keyRange(timeline.lowest, timeline.highest);
      const { keys, whiteWidth } = layoutKeys(range, width);
      const rollH = height - KEYBOARD_HEIGHT; // 막대가 떨어지는 영역 높이 (아래 끝 = 건반 윗면 = 치는 순간)

      drawRef.current = () => {
        const t = timeRef.current;
        wrap.dataset.time = t.toFixed(2); // 지금 위치 (확인·테스트용)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = colors.page;
        ctx.fillRect(0, 0, width, height);

        // 화면에 보이는 시간 구간: 건반 윗면이 지금(t), 맨 위가 t + rollH/속도
        const top = t + rollH / PIXELS_PER_SEC;
        const yOf = (sec) => rollH - (sec - t) * PIXELS_PER_SEC;

        // 세로 안내선: 각 옥타브의 도(C)와 파(F) 위치 (건반과 막대를 눈으로 잇기 쉽게)
        ctx.strokeStyle = colors.line;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        for (let p = range.lo; p <= range.hi; p += 1) {
          if (p % 12 === 0 || p % 12 === 5) {
            const x = Math.round(keys[p].x) + 0.5;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, rollH); ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;

        // 가로 마디선 + 마디 번호
        ctx.font = '11px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
        ctx.textBaseline = 'bottom';
        timeline.measures.forEach((m) => {
          if (m.time < t || m.time > top) return;
          const y = Math.round(yOf(m.time)) + 0.5;
          ctx.strokeStyle = colors.line;
          ctx.globalAlpha = 0.6;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = colors.muted;
          ctx.fillText(String(m.number), 4, y - 2);
        });

        // 막대: 흰 건반 음 먼저, 검은 건반 음은 위에 (좁은 막대가 가려지지 않게)
        const visible = notesInWindow(timeline, t, top);
        const sounding = new Set(); // 지금 눌린 건반
        [false, true].forEach((blackPass) => {
          visible.forEach((n) => {
            const key = keys[n.pitch];
            if (!key || key.black !== blackPass) return;
            if (n.start <= t && n.end > t) sounding.add(n.pitch);
            const y1 = Math.min(rollH, yOf(n.start));
            const y0 = Math.max(-4, yOf(n.end));
            if (y1 - y0 < 1) return;
            const inset = key.black ? 0.5 : 1.5;
            ctx.globalAlpha = 0.55 + 0.45 * (n.velocity / 127);
            ctx.fillStyle = colors.note;
            roundRect(ctx, key.x + inset, y0, key.w - inset * 2, y1 - y0, 3);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = colors.page;
            ctx.lineWidth = 1;
            ctx.stroke();
          });
        });

        // 치는 선 (건반 윗면)
        ctx.fillStyle = colors.staff;
        ctx.fillRect(0, rollH - 2, width, 2);

        // 건반
        const ky = rollH;
        const blackH = KEYBOARD_HEIGHT * BLACK_KEY_HEIGHT;
        for (let p = range.lo; p <= range.hi; p += 1) {
          const k = keys[p];
          if (k.black) continue;
          ctx.fillStyle = sounding.has(p) ? colors.note : colors.keyWhite;
          ctx.fillRect(k.x, ky, k.w, KEYBOARD_HEIGHT);
          ctx.strokeStyle = colors.line;
          ctx.strokeRect(Math.round(k.x) + 0.5, ky + 0.5, Math.round(k.w), KEYBOARD_HEIGHT - 1);
          // 도(C)에 옥타브 이름: 건반 위치를 찾기 쉽게
          if (p % 12 === 0 && whiteWidth >= 14) {
            ctx.fillStyle = sounding.has(p) ? colors.page : colors.muted;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`C${p / 12 - 1}`, k.x + k.w / 2, ky + KEYBOARD_HEIGHT - 6);
            ctx.textAlign = 'left';
          }
        }
        for (let p = range.lo; p <= range.hi; p += 1) {
          const k = keys[p];
          if (!k.black) continue;
          ctx.fillStyle = sounding.has(p) ? colors.note : colors.keyBlack;
          roundRect(ctx, k.x, ky, k.w, blackH, 2);
          ctx.fill();
          if (sounding.has(p)) { ctx.strokeStyle = colors.keyBlack; ctx.stroke(); }
        }

        // 오른쪽 위: 지금 마디와 시간 (마디 번호는 왼쪽에 있으므로 겹치지 않게)
        const label = `${measureAt(timeline, Math.max(0, t))}마디   ${formatClock(t)} / ${formatClock(timeline.duration)}`;
        ctx.font = '600 12px "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
        ctx.textBaseline = 'top';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = colors.page;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(width - tw - 18, 6, tw + 12, 20);
        ctx.globalAlpha = 1;
        ctx.fillStyle = colors.ink;
        ctx.fillText(label, width - tw - 12, 10);
      };
      drawRef.current();
    };

    setup();
    const ro = new ResizeObserver(setup);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [timeline, theme]);

  // 휠: 멈춰 있을 때만 앞뒤 이동. 페이지가 같이 스크롤되지 않게 passive: false
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const onWheel = (e) => {
      if (playingRef.current) return;
      e.preventDefault();
      const next = timeRef.current + e.deltaY * WHEEL_SEC_PER_PX;
      timeRef.current = Math.min(timeline.duration, Math.max(START_TIME, next));
      drawRef.current();
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [timeline]);

  return (
    <div className="piano-roll" ref={wrapRef}>
      <canvas ref={canvasRef} aria-label="피아노 튜토리얼: 떨어지는 막대가 건반에 닿을 때 그 음을 칩니다" />
    </div>
  );
}

