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
