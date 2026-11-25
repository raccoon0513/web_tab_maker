// 도구 줄 아이콘 (16px 격자, currentColor로 그려서 테마 색을 따름)

const Svg = ({ children, label }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true}
    role={label ? 'img' : undefined} aria-label={label}>
    {children}
  </svg>
);

// 처음부터 재생: 시작 막대 + 재생 삼각형
export const IconPlayFromStart = () => (
  <Svg><path d="M3 3v10" /><path d="M6 3.5v9l7-4.5z" fill="currentColor" /></Svg>
);

// 마디 처음부터 재생: 마디줄 두 개 사이의 재생 삼각형
export const IconPlayMeasure = () => (
  <Svg><path d="M2.5 3v10M13.5 3v10" /><path d="M5.5 4.5v7l5.5-3.5z" fill="currentColor" /></Svg>
);

// 커서부터 재생
export const IconPlay = () => (
  <Svg><path d="M4.5 3v10l8.5-5z" fill="currentColor" /></Svg>
);

export const IconRecord = () => (
  <Svg><circle cx="8" cy="8" r="4.5" fill="currentColor" stroke="none" /></Svg>
);

export const IconStop = () => (
  <Svg><rect x="4" y="4" width="8" height="8" fill="currentColor" stroke="none" /></Svg>
);

// 메트로놈: 사다리꼴 몸통 + 추
export const IconMetronome = () => (
  <Svg><path d="M5.5 2h5l2.5 12H3z" /><path d="M8 11l3.5-6.5" /><path d="M4.5 11h7" /></Svg>
);

// 선택한 노트 길이를 현재 박자로: 양쪽 끝 막대 사이 화살표
export const IconSetLength = () => (
  <Svg><path d="M2.5 4v8M13.5 4v8" /><path d="M5 8h6M6.5 6.2L5 8l1.5 1.8M9.5 6.2L11 8l-1.5 1.8" /></Svg>
);

// 다음 노트까지 늘리기: 막대를 향한 화살표
export const IconExtend = () => (
  <Svg><path d="M13 3.5v9" /><path d="M2.5 8h8M8 5.5L10.5 8 8 10.5" /></Svg>
);

export const IconOpen = () => (
  <Svg><path d="M1.5 4.5v8h12v-6.5h-6l-1.5-1.5z" /></Svg>
);

export const IconSave = () => (
  <Svg><path d="M8 2v7.5M5 6.5l3 3 3-3" /><path d="M2.5 10.5v3h11v-3" /></Svg>
);

export const IconNew = () => (
  <Svg><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M9.5 1.5v3h3" /></Svg>
);

export const IconSun = () => (
  <Svg>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
  </Svg>
);

export const IconMoon = () => (
  <Svg><path d="M12.5 10A5 5 0 0 1 6 3.5 5 5 0 1 0 12.5 10z" /></Svg>
);

export const IconHelp = () => (
  <Svg><circle cx="8" cy="8" r="6.2" /><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" /><circle cx="8" cy="11.6" r="0.4" fill="currentColor" /></Svg>
);

// MIDI 가져오기: 8분음표
export const IconMidi = () => (
  <Svg><path d="M6.5 12V3.5l6-1.5v8" /><circle cx="4.8" cy="12" r="1.8" fill="currentColor" /><circle cx="10.8" cy="10" r="1.8" fill="currentColor" /></Svg>
);
