/**
 * Copyright (c) 2026 Nicholas Waltz
 *
 * MP4PullDemuxer.ts
 */

import { MP4Box, Trak, MP4Sample, MP4File, MP4Info, MP4VideoTrack, MP4ArrayBuffer, DataStream } from "./lib/mp4box";
import { secToMs } from "./time";

const MIN_DECODER_QUEUE_SIZE = 20;

export type IndexedMP4Sample = MP4Sample & { ptsIndex: number; dtsIndex: number };

export type SeekReturn = {
  ptsIndex: number;
  dtsIndex: number;
  samples: IndexedMP4Sample[];
};

/**
 * Demuxes an MP4 file and provides random-access to its video samples.
 *
 * Accepts a {@link File} or {@link Blob} containing an MP4 file, parses the
 * container via mp4box.js, and exposes video samples indexed by both PTS and
 * DTS order. Supports seeking to arbitrary timestamps (snapping to the nearest
 * keyframe and pre-loading a decoder-ready window of samples) as well as
 * bulk-reading all samples for sequential processing.
 *
 * @example
 * ```ts
 * const demuxer = new MP4PullDemuxer(mp4Blob);
 * const config = await demuxer.getVideoDecoderConfig();
 * const samples = await demuxer.readAllSamples();
 * ```
 */
export class MP4PullDemuxer {
  videoSamples: IndexedMP4Sample[] = [];
  videoTrak: Trak | null = null;

  file!: File | Blob;
  mp4box!: MP4File;
  durationMs: number = 0;

  moov: boolean = false;
  onVideoDecoderConfig: (config: VideoDecoderConfig) => void = (_c) => {};
  videoDecoderConfig: VideoDecoderConfig | null = null;

  private _error: Error | null = null;
  firstFramePtsOffsetMs: number = 0;

  /**
   * Creates a new demuxer and immediately begins parsing the provided file.
   * The {@link onReady} callback fires once the moov box has been parsed.
   *
   * @param file - An MP4 file as a File or Blob.
   */
  constructor(file: File | Blob) {
    this.file = file;
    this.mp4box = MP4Box.createFile();
    this.mp4box.onReady = this.onReady.bind(this);

    this.moov = false;

    this.appendBuffer();
  }

  /**
   * Returns the {@link VideoDecoderConfig} extracted from the first video
   * track. Waits for the moov box to be parsed if it has not been already.
   * Times out after 10 seconds.
   *
   * @returns A VideoDecoderConfig suitable for passing to `VideoDecoder.configure`.
   * @throws If onReady had failed.
   */
  async getVideoDecoderConfig() {
    if (this._error) throw this._error;
    if (this.videoDecoderConfig) return this.videoDecoderConfig;
    return new Promise<VideoDecoderConfig>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("getVideoDecoderConfig timed out after 10s")), 10000);
      this.onVideoDecoderConfig = (config) => {
        clearTimeout(timeout);
        resolve(config);
      };
    });
  }

  /** Reads the entire file into memory and feeds it to mp4box for parsing. */
  private async appendBuffer() {
    try {
      const buffer = (await this.file.arrayBuffer()) as MP4ArrayBuffer;
      buffer.fileStart = 0;
      this.mp4box.appendBuffer(buffer); // This triggers onReady if a moov is present in the file
    } catch (error) {
      throw this._trapError(String(error));
    }
  }

  /**
   * Extracts a {@link VideoDecoderConfig} from the given video track by
   * reading the codec-specific box (avcC, hvcC, vpcC, or av1C) from the
   * sample description.
   *
   * @param videoTrack - The MP4 video track metadata.
   * @returns A VideoDecoderConfig with codec string and description bytes.
   * @throws If the required codec configuration box is not found.
   */
  private readVideoDecoderConfig(videoTrack: MP4VideoTrack) {
    const trak = this.mp4box.getTrackById(videoTrack.id);

    let description: Uint8Array | undefined = undefined;
    if (!trak?.mdia?.minf?.stbl?.stsd) throw this._trapError("mdia box not intact.");
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        description = new Uint8Array(stream.buffer, 8); // Remove the box header.
      }
    }
    if (!description) throw this._trapError("avcC, hvcC, vpcC, or av1C box not found");

    return {
      codec: videoTrack.codec.startsWith("vp08") ? "vp8" : videoTrack.codec,
      codedHeight: videoTrack.video.height,
      codedWidth: videoTrack.video.width,
      description,
      hardwareAcceleration: "prefer-hardware",
    } as VideoDecoderConfig;
  }

  /**
   * Retrieves the raw sample data for a single indexed sample from the
   * mp4box track.
   *
   * @param indexedSample - The sample whose data should be fetched.
   * @returns The sample with its `data` field populated.
   */
  private fetchSampleData(indexedSample: IndexedMP4Sample) {
    if (!this.videoTrak) throw this._trapError("videoTrak not loaded");
    const sample = this.mp4box.getSample(this.videoTrak, indexedSample.dtsIndex);
    return {
      ...indexedSample,
      ...sample,
    } as IndexedMP4Sample;
  }

  /**
   * Efficiently loads a contiguous byte range covering all provided samples
   * and then retrieves their data. Samples are sorted by offset for a single
   * contiguous file read, then returned in DTS order.
   *
   * @param samples - The samples to fetch data for.
   * @returns The samples with data populated, sorted by DTS.
   */
  private async bulkFetchSampleData(samples: IndexedMP4Sample[]) {
    if (samples.length === 0) return [];
    const resorted = samples.toSorted((a, b) => a.offset - b.offset);

    const startOffset = resorted[0].offset;
    const endOffset = resorted.at(-1)!.offset + resorted.at(-1)!.size;

    // Load file slice into memory
    const buffer = (await this.file.slice(startOffset, endOffset).arrayBuffer()) as MP4ArrayBuffer;
    buffer.fileStart = startOffset;

    this.mp4box.appendBuffer(buffer);

    return samples.toSorted((a, b) => a.dts - b.dts).map((sample: IndexedMP4Sample) => this.fetchSampleData(sample));
  }

  /** Traps any errors that occur in the onReady state */
  private _trapError(msg: string) {
    this._error = new Error(msg);
    return this._error;
  }

  /**
   * Called by mp4box once the moov box has been fully parsed. Extracts and
   * indexes video samples (sorted by PTS), reads the video decoder config,
   * and frees the raw buffer memory.
   */
  private async onReady(info: MP4Info) {
    this.moov = true;

    const videoTrack = info.videoTracks?.[0];

    if (!videoTrack) {
      this._trapError("mp4 file without video track");
      return;
    }

    // TODO: extract audio samples
    // const audioTrack = info.audioTracks?.[0];
    // this.audioTrak = this.mp4box.getTrackById(audioTracks.id)
    // if (audioTrack) this.audioSamples = this.audioTrak.samples.map((s, i) => (...));

    this.videoTrak = this.mp4box.getTrackById(videoTrack.id);

    // Index samples and sort by PTS (mp4box sorts by DTS)
    this.videoSamples = this.videoTrak.samples
      .toSorted((a, b) => a.cts - b.cts)
      .map((s, i) => ({ ...s, ptsIndex: i, dtsIndex: s.number }));

    this.firstFramePtsOffsetMs = secToMs(this.videoSamples[0].cts / this.videoSamples[0].timescale);

    this.durationMs = secToMs(info.duration / info.timescale);

    const videoDecoderConfig = this.readVideoDecoderConfig(videoTrack);
    if (!(await VideoDecoder.isConfigSupported(videoDecoderConfig)).supported) {
      this._trapError("VideoDecoder config not supported");
      return;
    }

    this.videoDecoderConfig = videoDecoderConfig;
    this.onVideoDecoderConfig?.(this.videoDecoderConfig);

    // Free memory
    this.mp4box.stream.cleanBuffers();
  }

  /**
   * Seeks to the given timestamp and returns a window of samples suitable for
   * feeding into a VideoDecoder. If the target frame is a keyframe, a window
   * of {@link MIN_DECODER_QUEUE_SIZE} frames centered on it is returned.
   * Otherwise the window extends from the preceding keyframe through the next
   * keyframe (or at least MIN_DECODER_QUEUE_SIZE frames).
   *
   * @param timestampMs - The target timestamp in milliseconds.
   * @returns The PTS/DTS indices of the target frame and the sample window.
   * @throws If no video samples have been parsed or no preceding keyframe exists.
   */
  async seek(timestampMs: number) {
    if (this.videoSamples.length === 0) throw new Error("Seek failed. No video samples have been extracted.");

    this.mp4box.stream.cleanBuffers();

    const targetFrameIndex = this.timestampMsToPtsIndex(timestampMs);

    if (targetFrameIndex === -1) return { samples: [] as IndexedMP4Sample[], ptsIndex: -1, dtsIndex: -1 };

    const frame = this.videoSamples[targetFrameIndex];

    // if keyframe, dump MIN_DECODER_QUEUE_SIZE frames into the decoder queue
    if (frame.is_sync) {
      const startIndex = Math.max(0, targetFrameIndex - Math.ceil(MIN_DECODER_QUEUE_SIZE / 2));
      const endIndex = Math.min(startIndex + MIN_DECODER_QUEUE_SIZE, this.videoSamples.length - 1);
      return {
        samples: await this.bulkFetchSampleData(this.videoSamples.slice(startIndex, endIndex)),
        ptsIndex: frame.ptsIndex,
        dtsIndex: frame.dtsIndex,
      };
    }

    const lastKeyframe = this.videoSamples.slice(0, frame.ptsIndex).findLast((f) => f.is_sync);
    const nextKeyframe = this.videoSamples.slice(frame.ptsIndex).find((f) => f.is_sync);

    if (!lastKeyframe) throw new Error(`Seek failed. No keyframe found before ${timestampMs}ms.`);

    const endIndex = Math.min(
      Math.max(nextKeyframe?.ptsIndex ?? 0, frame.ptsIndex, lastKeyframe.ptsIndex + MIN_DECODER_QUEUE_SIZE),
      this.videoSamples.length - 1,
    );

    return {
      samples: await this.bulkFetchSampleData(this.videoSamples.slice(lastKeyframe.ptsIndex, endIndex)),
      ptsIndex: frame.ptsIndex,
      dtsIndex: frame.dtsIndex,
    };
  }

  /**
   * Reads and returns all video samples with their data populated, in DTS
   * order. Useful for sequential full-file processing.
   */
  async readAllSamples() {
    this.mp4box.stream.cleanBuffers();
    return await this.bulkFetchSampleData(this.videoSamples);
  }

  /**
   * Converts a DTS-order index to the corresponding PTS-order index.
   *
   * @param dtsIndex - The DTS-order sample index.
   * @returns The PTS-order index, or `-1` if not found.
   */
  dtsIndexToPtsIndex(dtsIndex: number) {
    return this.videoSamples.find((s) => s.dtsIndex === dtsIndex)?.ptsIndex ?? -1;
  }

  /**
   * Finds the PTS-order index of the sample whose presentation time range
   * contains the given timestamp.
   *
   * @param timestampMs - The target timestamp in milliseconds.
   * @returns The PTS-order index, or `-1` if no matching sample is found.
   */
  timestampMsToPtsIndex(timestampMs: number) {
    for (let sample of this.videoSamples) {
      const timescale = sample.timescale;
      const ctsMs = secToMs(sample.cts / timescale) - this.firstFramePtsOffsetMs;
      const durationMs = secToMs(sample.duration / timescale);
      if (ctsMs <= timestampMs && ctsMs + durationMs >= timestampMs) return sample.ptsIndex;
    }
    return -1;
  }
}
