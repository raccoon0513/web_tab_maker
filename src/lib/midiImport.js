// MIDI 파일 → 원곡(source)
//
// 원곡은 MIDI에 들어 있던 음을 하나도 버리지 않고 보관한 것이다. 악기를 모르고, 퀀타이즈도 하지 않는다.
// 기타 악보(나중에는 피아노 악보)는 이 원곡에서 따로 변환해 만든다.
//
// 원곡 구조
//   { title, fileName, importedAt, originalPpq, durationTicks, durationSec,
//     tempos: [{ tick, bpm }], timeSignatures: [{ tick, num, den }],
//     tracks: [{ id, name, instrument, family, channel, isDrum,
//                notes: [{ pitch, tick, duration, velocity }] }] }
//   - tick, duration: 우리 단위(4분음표 = TPQ = 48)로 바꾼 값. MIDI 파일마다 다른 해상도(ppq)를 하나로 맞춤
//   - channel: 사람이 보는 번호 1~16 (10번 = 드럼)
//   - velocity: 0~127 (세기)

import { Midi } from '@tonejs/midi';
import { TPQ, timeSigLength } from './scoreModel.js';

const DRUM_CHANNEL_INDEX = 9; // MIDI 채널 10 (0부터 세면 9)
const DEFAULT_MIDI_BPM = 120; // 템포 정보가 없을 때 MIDI 표준 기본값

const stripExtension = (name) => name.replace(/\.(mid|midi)$/i, '');

// data: ArrayBuffer 또는 Uint8Array. 읽을 수 없는 파일이면 예외를 던짐
//   (형식이 틀리면 라이브러리 예외, 음이 하나도 없으면 Error('NO_NOTES'))
export const parseMidi = (data, fileName = 'untitled.mid') => {
  const midi = new Midi(data);
  const ppq = midi.header.ppq;
  const toTick = (t) => Math.round((t * TPQ) / ppq);

  // 음이 없는 트랙(템포만 담은 지휘 트랙 등)은 뺌
  const tracks = midi.tracks
    .filter((t) => t.notes.length > 0)
    .map((t, i) => {
      const isDrum = t.channel === DRUM_CHANNEL_INDEX || t.instrument.percussion;
      return {
        id: i + 1,
        name: (t.name || '').trim() || `트랙 ${i + 1}`,
        instrument: isDrum ? 'drums' : t.instrument.name,
        family: isDrum ? 'drums' : t.instrument.family,
        channel: t.channel + 1,
        isDrum,
        notes: t.notes
          .map((n) => ({
            pitch: n.midi,
            tick: toTick(n.ticks),
            duration: Math.max(1, toTick(n.durationTicks)), // 아주 짧은 음도 0이 되지 않게
            velocity: Math.round(n.velocity * 127),
          }))
          .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch),
      };
    });

  if (tracks.length === 0) throw new Error('NO_NOTES');

  const tempos = midi.header.tempos.length > 0
    ? midi.header.tempos.map((t) => ({ tick: toTick(t.ticks), bpm: Math.round(t.bpm * 100) / 100 }))
    : [{ tick: 0, bpm: DEFAULT_MIDI_BPM }];

  const timeSignatures = midi.header.timeSignatures.length > 0
    ? midi.header.timeSignatures.map((t) => ({ tick: toTick(t.ticks), num: t.timeSignature[0], den: t.timeSignature[1] }))
    : [{ tick: 0, num: 4, den: 4 }];

  const durationTicks = Math.max(...tracks.flatMap((t) => t.notes.map((n) => n.tick + n.duration)));

  return {
    title: (midi.header.name || '').trim() || stripExtension(fileName),
    fileName,
    importedAt: new Date().toISOString(),
    originalPpq: ppq,
    durationTicks,
    durationSec: Math.round(midi.duration * 10) / 10,
    tempos,
    timeSignatures,
    tracks,
  };
};

// --- 화면 표시용 요약 ---

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// 60 → 'C4'
export const pitchName = (pitch) => `${NOTE_NAMES.at(pitch % 12)}${Math.floor(pitch / 12) - 1}`;

// 트랙 요약: 음 개수, 가장 낮은/높은 음, 동시에 가장 많이 울리는 음 수
export const summarizeTrack = (track) => {
  let lowest = Infinity;
  let highest = -Infinity;
  const events = [];
  track.notes.forEach((n) => {
    lowest = Math.min(lowest, n.pitch);
    highest = Math.max(highest, n.pitch);
    events.push([n.tick, 1], [n.tick + n.duration, -1]);
  });
  // 시간순으로 훑으며 울리는 음 수를 셈. 같은 순간이면 끝나는 음(-1)을 먼저 처리
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let sounding = 0;
  let maxPolyphony = 0;
  events.forEach(([, d]) => {
    sounding += d;
    maxPolyphony = Math.max(maxPolyphony, sounding);
  });
  return { noteCount: track.notes.length, lowest, highest, maxPolyphony };
};

// 원곡 길이를 마디 수로 (박자 변화 반영, 마지막 마디는 올림)
export const countMeasures = (source) => {
  const sigs = source.timeSignatures;
  let measures = 0;
  sigs.forEach((ts, i) => {
    const from = ts.tick;
    const to = i + 1 < sigs.length ? sigs.at(i + 1).tick : source.durationTicks;
    if (to > from) measures += (to - from) / timeSigLength(ts);
  });
  return Math.ceil(measures - 1e-9);
};
