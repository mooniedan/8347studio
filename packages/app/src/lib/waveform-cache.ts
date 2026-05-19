import * as assetStore from './asset-store';

/**
 * Phase-10 M3a — waveform thumbnail cache.
 *
 * Audio regions render a downsampled peak-pair (min/max per pixel)
 * thumbnail of their backing asset. Decoding a WAV/MP3 through the
 * AudioContext costs ~10-100ms per file; downsampling to peaks costs
 * less than that but compounds over many regions. We cache:
 *
 *   1. the decoded mono peak series (one Float32Array per asset
 *      hash, full sample-rate resolution); and
 *   2. the rendered peak buckets at the most-recently-requested
 *      pixel count (so two regions of the same asset at the same
 *      width don't bucketise twice).
 *
 * Cache lives at the module scope so it survives Svelte component
 * remounts but doesn't leak across reloads.
 */

interface AssetPeaks {
  /// Mono "absolute peak" series — one float per sample frame, in
  /// the range [0, 1]. Built once per asset hash; reused for every
  /// pixel-count bucketisation.
  mono: Float32Array;
}

interface BucketedPeaks {
  /// Interleaved [min0, max0, min1, max1, ...] in the range [-1, 1].
  pairs: Float32Array;
  /// Pixel count this was bucketed to.
  pixels: number;
}

const assetPeaksCache = new Map<string, Promise<AssetPeaks>>();
const bucketCache = new Map<string, BucketedPeaks>();

/// Decode the asset bytes and reduce to a mono "abs-peak" series.
/// Multi-channel sources are folded by averaging — the thumbnail is
/// purely visual so we don't need true L/R independence.
async function loadAssetPeaks(hash: string): Promise<AssetPeaks> {
  const cached = assetPeaksCache.get(hash);
  if (cached) return cached;

  const work = (async () => {
    // We need *some* AudioContext to call decodeAudioData. The main
    // engine ctx is preferred (already running, no extra cost); fall
    // back to a fresh OfflineAudioContext for headless test paths
    // where audio.audioContext() throws.
    let ctx: BaseAudioContext;
    try {
      const { audioContext } = await import('./audio');
      ctx = await audioContext();
    } catch {
      ctx = new OfflineAudioContext(1, 1, 48000);
    }
    const bytes = await assetStore.get(hash);
    if (!bytes) {
      // Nothing to decode — return an empty series.
      return { mono: new Float32Array(0) };
    }
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const buf = await ctx.decodeAudioData(ab);
    const channels = buf.numberOfChannels;
    const frames = buf.length;
    const mono = new Float32Array(frames);
    if (channels === 1) {
      const ch = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) mono[i] = Math.abs(ch[i]);
    } else {
      const chs: Float32Array[] = [];
      for (let c = 0; c < channels; c++) chs.push(buf.getChannelData(c));
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += chs[c][i];
        mono[i] = Math.abs(s / channels);
      }
    }
    return { mono };
  })();

  assetPeaksCache.set(hash, work);
  return work;
}

/// Bucket the mono series into `pixels` peak-pairs. Each pair is
/// `[-max, +max]` for that pixel's sample window — a symmetric bar
/// is enough for the thumbnail aesthetic without separate min/max
/// per pixel (the input is already abs-folded).
export async function peaksFor(
  hash: string,
  pixels: number,
): Promise<Float32Array> {
  if (pixels <= 0) return new Float32Array(0);
  const cacheKey = `${hash}:${pixels}`;
  const hit = bucketCache.get(cacheKey);
  if (hit) return hit.pairs;

  const { mono } = await loadAssetPeaks(hash);
  if (mono.length === 0) return new Float32Array(0);

  const pairs = new Float32Array(pixels * 2);
  const samplesPerPx = mono.length / pixels;
  for (let p = 0; p < pixels; p++) {
    const start = Math.floor(p * samplesPerPx);
    const end = Math.min(mono.length, Math.floor((p + 1) * samplesPerPx));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = mono[i];
      if (v > peak) peak = v;
    }
    pairs[p * 2] = -peak;
    pairs[p * 2 + 1] = peak;
  }
  bucketCache.set(cacheKey, { pairs, pixels });
  return pairs;
}

/// Test-hook: clear caches. Not used in production code; lets specs
/// reset state between cases without reloading the page.
export function clearWaveformCache(): void {
  assetPeaksCache.clear();
  bucketCache.clear();
}
