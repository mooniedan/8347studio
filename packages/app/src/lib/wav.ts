// Minimal mono 16-bit PCM WAV encoder. Phase-5 M5 uses this to wrap
// recorded Float32 PCM into a file the OPFS asset store can hash and
// the asset-store decoder can round-trip.

export function encodeWavMono16(pcm: Float32Array, sampleRate: number): Uint8Array {
  const frames = pcm.length;
  const blockAlign = 2; // 16-bit mono
  const dataSize = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  let p = 0;
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i));
    p += s.length;
  };
  const writeU32 = (v: number) => {
    dv.setUint32(p, v >>> 0, true);
    p += 4;
  };
  const writeU16 = (v: number) => {
    dv.setUint16(p, v & 0xffff, true);
    p += 2;
  };
  writeStr('RIFF');
  writeU32(36 + dataSize);
  writeStr('WAVE');
  writeStr('fmt ');
  writeU32(16);
  writeU16(1); // PCM
  writeU16(1); // mono
  writeU32(sampleRate);
  writeU32(sampleRate * blockAlign);
  writeU16(blockAlign);
  writeU16(16);
  writeStr('data');
  writeU32(dataSize);
  for (let i = 0; i < frames; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(p, Math.round(s * 0x7fff), true);
    p += 2;
  }
  return new Uint8Array(ab);
}

export type BitDepth = 16 | 24 | 32;

/// Phase-10 M7d — interleaved PCM → WAV at 16/24-bit int or 32-bit
/// float. `pcm` is interleaved per the channel count (L,R,L,R… for
/// stereo). 32-bit uses IEEE-float (fmt tag 3); 16/24 are signed int.
export function encodeWavInterleaved(
  pcm: Float32Array,
  channels: number,
  sampleRate: number,
  bitDepth: BitDepth,
): Uint8Array {
  const isFloat = bitDepth === 32;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = pcm.length * bytesPerSample;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  let p = 0;
  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i));
    p += s.length;
  };
  const writeU32 = (v: number) => { dv.setUint32(p, v >>> 0, true); p += 4; };
  const writeU16 = (v: number) => { dv.setUint16(p, v & 0xffff, true); p += 2; };

  writeStr('RIFF');
  writeU32(36 + dataSize);
  writeStr('WAVE');
  writeStr('fmt ');
  writeU32(16);
  writeU16(isFloat ? 3 : 1); // 3 = IEEE float, 1 = PCM int
  writeU16(channels);
  writeU32(sampleRate);
  writeU32(sampleRate * blockAlign);
  writeU16(blockAlign);
  writeU16(bitDepth);
  writeStr('data');
  writeU32(dataSize);

  for (let i = 0; i < pcm.length; i++) {
    if (isFloat) {
      dv.setFloat32(p, pcm[i], true);
      p += 4;
    } else if (bitDepth === 24) {
      const v = Math.round(Math.max(-1, Math.min(1, pcm[i])) * 0x7fffff);
      dv.setUint8(p, v & 0xff);
      dv.setUint8(p + 1, (v >> 8) & 0xff);
      dv.setUint8(p + 2, (v >> 16) & 0xff);
      p += 3;
    } else {
      dv.setInt16(p, Math.round(Math.max(-1, Math.min(1, pcm[i])) * 0x7fff), true);
      p += 2;
    }
  }
  return new Uint8Array(ab);
}
