// 기타 전용 지식: 튜닝, 줄·프렛과 음높이의 관계, 빈 줄 찾기
//
// 악보 데이터는 악기를 모르는 "음높이(MIDI 번호)"를 기준으로 저장하고,
// 기타에서 어느 줄로 칠지는 노트의 string에 메모해 둔다. 프렛은 저장하지 않고 여기서 계산한다.
// (피아노를 추가할 때는 같은 자리에 piano.js를 두고 손 배정 같은 지식을 넣는다)

// 스탠다드 튜닝: 줄 번호(1 = 가장 가는 줄) → 개방현 음높이
export const STANDARD_TUNING = Object.freeze({ 1: 64, 2: 59, 3: 55, 4: 50, 5: 45, 6: 40 });
export const STRING_COUNT = 6;
export const MAX_FRET = 24;
export const LOWEST_PITCH = STANDARD_TUNING[6]; // E2

export const pitchOf = (string, fret, tuning = STANDARD_TUNING) => tuning[string] + fret;

// 노트의 프렛 (뮤트는 'X', 줄이 없는 음은 null)
export const fretOf = (note, tuning = STANDARD_TUNING) => {
  if (note.string == null) return null;
  return note.mute ? 'X' : note.pitch - tuning[note.string];
};

// 비트(같은 순간에 치는 음들)에서 그 줄에 있는 노트
export const noteOnString = (beat, string) => beat.notes.find((n) => n.string === string);

// 이 음높이를 칠 수 있는 줄 중, 비어 있고 프렛이 가장 낮은 줄 (없으면 null)
//   isFree(string): 그 줄이 비어 있는지 (여러 비트를 함께 따질 때 호출하는 쪽에서 정함)
export const lowestFretString = (pitch, isFree, tuning = STANDARD_TUNING) => {
  let best = null;
  let bestFret = Infinity;
  for (let s = 1; s <= STRING_COUNT; s++) {
    const fret = pitch - tuning[s];
    if (fret >= 0 && fret <= MAX_FRET && fret < bestFret && isFree(s)) {
      best = s;
      bestFret = fret;
    }
  }
  return best;
};

// --- 음 하나를 가리키는 이름 ---
// 한 비트 안에서 음을 구별: 기타 줄에 놓인 음은 줄 번호로, 줄이 없는 음(피아노에서 넣은 음)은 음 높이로.
// 선택·삭제·이동이 이 이름으로 음을 찾는다
export const noteId = (note) => (note.string != null ? `s${note.string}` : `p${note.pitch}`);
export const findNoteById = (beat, id) => beat.notes.find((n) => noteId(n) === id);

// 줄에 놓여 있고, 그 줄로 칠 수 있는 음인지 (프렛 0~24)
const playableOn = (note, tuning) => {
  if (note.string == null || !tuning[note.string]) return false;
  if (note.mute) return true;
  const fret = note.pitch - tuning[note.string];
  return fret >= 0 && fret <= MAX_FRET;
};

// 악보를 기타로 바꿀 때 줄 배치 (원본은 그대로, 새 악보를 돌려줌)
//   - 이미 칠 수 있는 줄에 있는 음은 그대로 (피아노로 갔다 돌아온 음은 원래 TAB 그대로)
//   - 나머지는 높은 음부터 남은 줄 중 가장 낮은 프렛에
//   - 그래도 못 놓는 음(E2보다 낮음, 줄이 모자람)은 줄 없이 남김 → 화면에 빨간색
//   반환: { measures, unplaced: 줄 없이 남은 음 개수 }
export const assignStrings = (measures, tuning = STANDARD_TUNING) => {
  let unplaced = 0;
  const out = measures.map((m) => ({
    ...m,
    beats: m.beats.map((b) => {
      const used = new Set();
      const keep = [];
      const rest = [];
      b.notes.forEach((n) => {
        if (playableOn(n, tuning) && !used.has(n.string)) {
          used.add(n.string);
          keep.push({ ...n });
        } else {
          rest.push(n);
        }
      });
      // 뮤트는 줄이 있어야만 존재하므로 위에서 다 놓임. 남은 것은 음높이 있는 음
      rest.sort((a, c) => c.pitch - a.pitch).forEach((n) => {
        const { string: _old, ...plain } = n;
        const s = lowestFretString(n.pitch, (k) => !used.has(k), tuning);
        if (s) {
          used.add(s);
          keep.push({ ...plain, string: s });
        } else {
          unplaced += 1;
          keep.push(plain);
        }
      });
      return { ...b, notes: keep };
    }),
  }));
  return { measures: out, unplaced };
};
