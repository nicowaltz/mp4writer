/**
 * Copyright (c) 2026 Nicholas Waltz
 *
 * MP4PushEncoderMuxer.ts
 */

import { MP4Box, MP4File, BoxParser, MP4BoxStream, DataStream, MP4ArrayBuffer } from "./lib/mp4box";
import { isConfigured } from "./promisifyWebCodecs";
import { msToSec, secToMs, usToSec, secToUs } from "./time";

import "./setupOpusBoxParser";

const DEFAULT_COMPATIBLE_BRANDS = ["mp42", "isom", "iso2", "iso5", "avc1", "mp41"];

type Sample = {
  number: number;
  data: Uint8Array;
  duration: number;
  dts: number;
  sync: boolean;
  offset: number;
  size: number;
};

export type MP4PushMuxerEncoderConfig = {
  audioSampleRate: number;
  audioSamplesPerChunk: number;
  audioOutputChannels: number;
  audioBitrate: number;
  audioChunkSec: number;
  videoOutputTimescale: number;
  videoSamplesPerChunk: number;
  videoBitrate: number;
  videoChunkSec: number;
  keyframeIntevalSec: number;
  latencyMode: "realtime" | "quality";
};
const DEFAULT_CONFIG = {
  audioSampleRate: 48_000,
  audioSamplesPerChunk: 1,
  audioOutputChannels: 2,
  audioBitrate: 64_000,
  audioChunkSec: msToSec(20), // 20ms audio chunks
  videoOutputTimescale: 90_000,
  videoSamplesPerChunk: 1,
  videoBitrate: 2_000_000,
  videoChunkSec: usToSec(33_333), // 30 fps
  keyframeIntevalSec: 2, // keyframe every 2s
  latencyMode: "realtime",
} as MP4PushMuxerEncoderConfig;

/**
 * Encodes and muxes raw video frames and audio data into an MP4 container.
 *
 * Uses the WebCodecs API (VideoEncoder / AudioEncoder) to encode H.264 video
 * and Opus audio, then assembles the encoded samples into an MP4 file via
 * mp4box.js. The workflow is push-based: callers feed in VideoFrames and
 * AudioData (or an AudioBuffer), and once all media has been pushed the final
 * MP4 buffer is produced by calling {@link multiplexToBuffer}.
 *
 * @example
 * ```ts
 * const muxer = new MP4PushMuxerEncoder();
 * await muxer.configureEncoders(1920, 1080);
 * await muxer.processAudioBuffer(audioBuffer);
 *
 * for (const frame of videoFrames) {
 *   await muxer.pushVideoFrame(frame);
 * }
 *
 * const mp4 = await muxer.multiplexToBuffer();
 * ```
 */
export class MP4PushMuxerEncoder {
  compatibleBrands = DEFAULT_COMPATIBLE_BRANDS;
  // file header:
  // ....ftypmp42....mp42isomiso2iso5avc1mp41....mdat
  mdatStartOffset = 16 + 4 * DEFAULT_COMPATIBLE_BRANDS.length + 8;

  private EMPTY_SAMPLE = { number: 0, offset: 0, dts: 0, duration: 0, sync: false, size: 0, data: new Uint8Array(0) };

  audioSampleRate = 48_000;
  audioSamplesPerChunk = 1;
  audioOutputChannels = 2;
  audioBitrate = 64_000;
  audioChunkSec = msToSec(20); // 20ms audio chunks

  videoOutputTimescale = 90_000;
  videoSamplesPerChunk = 1;
  videoBitrate = 2_000_000; // larger means higher quality
  videoChunkSec = usToSec(33_333); // 30 fps
  keyframeIntevalSec = 2; // keyframe every 2s
  latencyMode = "realtime"; // quality

  videoEncoder: VideoEncoder;
  audioEncoder: AudioEncoder;
  videoWidth: number = 0;
  videoHeight: number = 0;

  videoSamples: Sample[] = [];
  audioSamples: Sample[] = [];
  nextKeyframeUs: number = 0;
  currentVideoFrame: number = 0;
  numberOfFrames: number = 0;

  mp4box!: MP4File;

  avcDecoderConfigRecord: ArrayBuffer = new Uint8Array([
    1, 77, 0, 32, 255, 225, 0, 27, 39, 77, 0, 32, 137, 139, 40, 46, 10, 60, 190, 0, 24, 24, 0, 46, 224, 0, 11, 184, 47,
    123, 224, 248, 68, 35, 44, 1, 0, 4, 40, 239, 31, 32,
  ]).buffer;

  private _encoderError: Error | null = null;

  constructor({
    audioSampleRate = 48_000,
    audioSamplesPerChunk = 1,
    audioOutputChannels = 2,
    audioBitrate = 64_000,
    audioChunkSec = msToSec(20), // 20ms audio chunks
    videoOutputTimescale = 90_000,
    videoSamplesPerChunk = 1,
    videoBitrate = 2_000_000,
    videoChunkSec = usToSec(33_333), // 30 fps
    keyframeIntevalSec = 2, // keyframe every 2s
    latencyMode = "realtime",
  }: MP4PushMuxerEncoderConfig = DEFAULT_CONFIG) {
    this.audioSampleRate = audioSampleRate;
    this.audioSamplesPerChunk = audioSamplesPerChunk;
    this.audioOutputChannels = audioOutputChannels;
    this.audioBitrate = audioBitrate;
    this.audioChunkSec = audioChunkSec;
    this.videoOutputTimescale = videoOutputTimescale;
    this.videoSamplesPerChunk = videoSamplesPerChunk;
    this.videoBitrate = videoBitrate;
    this.videoChunkSec = videoChunkSec;
    this.keyframeIntevalSec = keyframeIntevalSec;
    this.latencyMode = latencyMode;

    const onError = (e: DOMException) => {
      this._encoderError = e;
      this.closeEncoders();
    };

    this.videoEncoder = new VideoEncoder({
      output: this.onEncodedVideoChunk.bind(this),
      error: onError,
    });
    this.audioEncoder = new AudioEncoder({
      output: this.onEncodedAudioChunk.bind(this),
      error: onError,
    });
  }

  /**
   * Flushes both encoders and assembles all collected samples into a complete
   * MP4 file buffer. Must be called after all video frames and audio data have
   * been pushed. The returned buffer contains a valid ftyp + mdat + moov
   * structure ready to be saved or transmitted.
   *
   * @returns A complete MP4 file as an {@link MP4ArrayBuffer}.
   * @throws If no video samples have been encoded.
   */
  private throwIfEncoderError() {
    if (this._encoderError) throw this._encoderError;
  }

  async multiplexToBuffer(): Promise<MP4ArrayBuffer> {
    try {
      await this.audioEncoder.flush();
      await this.videoEncoder.flush();
    } catch (e) {
      this.closeEncoders();
      throw e;
    }

    this.throwIfEncoderError();

    if (this.videoSamples.length === 0) throw new Error("Write failed: No video samples to write.");

    this.mp4box = MP4Box.createFile();

    const videoDurationMs = this.videoSamples.reduce(
      (acc, sample) => acc + secToMs(sample.duration / this.videoOutputTimescale),
      0,
    );

    const audioDurationMs = this.audioSamples.reduce(
      (acc, sample) => acc + secToMs(sample.duration / this.audioSampleRate),
      0,
    );

    this.mp4box
      .add("ftyp")
      .set("major_brand", this.compatibleBrands[0])
      .set("minor_version", 512)
      .set("compatible_brands", this.compatibleBrands);

    const mdat = this.mp4box.add("mdat");
    const mdatData = new Uint8Array(
      this.videoSamples.reduce((acc, sample) => sample.size + acc, 0) +
        this.audioSamples.reduce((acc, sample) => sample.size + acc, 0),
    );

    this.videoSamples.forEach((sample) => {
      mdatData.set(sample.data, sample.offset);
    });

    const lastVideoSample = this.videoSamples.at(-1)!;
    const audioBaseOffset = lastVideoSample.offset + lastVideoSample.size;

    this.audioSamples.forEach((sample) => {
      mdatData.set(sample.data, sample.offset + audioBaseOffset);
    });

    mdat.data = mdatData;

    const moov = this.mp4box.add("moov");
    moov
      .add("mvhd")
      .set("timescale", 1000) // ms
      .set("rate", 1 << 16)
      .set("creation_time", 0)
      .set("modification_time", 0)
      .set("duration", Math.max(audioDurationMs, videoDurationMs))
      .set("volume", 1)
      .set("matrix", [1 << 16, 0, 0, 0, 1 << 16, 0, 0, 0, 0x40000000])
      .set("next_track_id", 1);

    const videoTrak = moov.add("trak");
    videoTrak
      .add("tkhd")
      .set("flags", 3) // 00000011 in movie and enabled
      .set("creation_time", 0)
      .set("modification_time", 0)
      .set("track_id", 1) // video Trak ID 1
      .set("duration", videoDurationMs)
      .set("layer", 0)
      .set("alternate_group", 0)
      .set("volume", 0)
      .set("matrix", [1 << 16, 0, 0, 0, 1 << 16, 0, 0, 0, 0x40000000])
      .set("width", this.videoWidth << 16)
      .set("height", this.videoHeight << 16);

    const videoMdia = videoTrak.add("mdia");
    videoMdia
      .add("mdhd")
      .set("creation_time", 0)
      .set("modification_time", 0)
      .set("timescale", this.videoOutputTimescale)
      .set("duration", msToSec(videoDurationMs) * this.videoOutputTimescale)
      .set("language", "eng");

    videoMdia.add("hdlr").set("handler", "vide").set("name", "Track created by MP4Writer. nicholaswaltz.com/mp4writer");

    const videoMinf = videoMdia.add("minf");

    videoMinf.add("vmhd").set("flags", 1).set("graphicsmode", 0).set("opcolor", [0, 0, 0]);

    let dinf = videoMinf.add("dinf");
    let dref = dinf.add("dref");
    dref.addEntry(new BoxParser["url Box"]()).set("flags", 1).set("version", 0);

    const videoStbl = videoMinf.add("stbl");

    const videoStsd = videoStbl.add("stsd");
    const avc1 = new BoxParser["avc1SampleEntry"]();
    avc1.data_reference_index = 1;
    avc1
      .set("width", this.videoWidth)
      .set("height", this.videoHeight)
      .set("horizresolution", 0x48 << 16)
      .set("vertresolution", 0x48 << 16)
      .set("frame_count", 1)
      .set("compressorname", "avc1 Compressor")
      .set("depth", 0x18);
    const avcC = new BoxParser.avcCBox();
    avcC.parse(new MP4BoxStream(this.avcDecoderConfigRecord));
    avc1.addBox(avcC);

    videoStsd.addEntry(avc1);

    videoStbl
      .add("stts")
      .set("sample_counts", [this.videoSamples.length])
      .set("sample_deltas", [this.videoChunkSec * this.videoOutputTimescale]);
    videoStbl
      .add("stss")
      .set("version", 0)
      .set(
        "sample_numbers",
        this.videoSamples.filter((s) => s.sync).map((s) => s.number),
      );
    videoStbl
      .add("stsc")
      .set("first_chunk", [1])
      .set("samples_per_chunk", [this.videoSamplesPerChunk])
      .set("sample_description_index", [1]);

    videoStbl.add("stco").set(
      "chunk_offsets",
      this.videoSamples.map((s) => s.offset + this.mdatStartOffset),
    );
    videoStbl.add("stsz").set(
      "sample_sizes",
      this.videoSamples.map((s) => s.size),
    );

    const audioTrak = moov.add("trak");
    audioTrak
      .add("tkhd")
      .set("flags", 3) // 00000011 in movie and enabled
      .set("creation_time", 0)
      .set("modification_time", 0)
      .set("track_id", 2) // audio Trak ID 2
      .set("duration", audioDurationMs)
      .set("layer", 0)
      .set("alternate_group", 0)
      .set("volume", 1)
      .set("matrix", [1 << 16, 0, 0, 0, 1 << 16, 0, 0, 0, 0x40000000])
      .set("width", 0)
      .set("height", 0);

    const audioMdia = audioTrak.add("mdia");
    audioMdia
      .add("mdhd")
      .set("creation_time", 0)
      .set("modification_time", 0)
      .set("timescale", this.audioSampleRate)
      .set("duration", msToSec(audioDurationMs) * this.audioSampleRate)
      .set("language", "eng");

    audioMdia
      .add("hdlr")
      .set("handler", "soun")
      .set("name", "Track created using MP4Writer, see nicholaswaltz.com/mp4writer");

    const audioMinf = audioMdia.add("minf");

    audioMinf.add("smhd").set("flags", 1).set("version", 0).set("balance", 0);

    audioMinf.add("dinf").add("dref").addEntry(new BoxParser["url Box"]()).set("flags", 1).set("version", 0);

    const audioStbl = audioMinf.add("stbl");

    const audioStsd = audioStbl.add("stsd");
    const Opus = new BoxParser["OpusSampleEntry"]();
    Opus.data_reference_index = 1;

    Opus.set("samplerate", this.audioSampleRate).set("samplesize", 16).set("channel_count", this.audioOutputChannels);
    Opus.add("dOps")
      .set("Version", 0)
      .set("OutputChannelCount", this.audioOutputChannels)
      .set("InputSampleRate", this.audioSampleRate)
      .set("OutputGain", 0)
      .set("PreSkip", 312)
      .set("ChannelMappingFamily", 0);

    audioStsd.addEntry(Opus);

    audioStbl
      .add("stts")
      .set("sample_counts", [this.audioSamples.length])
      .set("sample_deltas", [this.audioChunkSec * this.audioSampleRate]);

    audioStbl
      .add("stsc")
      .set("first_chunk", [1])
      .set("samples_per_chunk", [this.audioSamplesPerChunk])
      .set("sample_description_index", [1]);
    audioStbl.add("stco").set(
      "chunk_offsets",
      this.audioSamples.map((s) => s.offset + audioBaseOffset + this.mdatStartOffset),
    );

    audioStbl
      .add("stsz")
      .set(
        "sample_sizes",
        this.audioSamples.map((s) => s.size),
      )
      .set("sample_size", 0) // override the default
      .set("sample_count", this.audioSamples.length);

    // copying ffmpeg values
    const sgpd = audioStbl
      .add("sgpd")
      .set("version", 1)
      .set("grouping_type", "roll")
      .set("used", true)
      .set("default_length", 2);

    sgpd.entries = [
      {
        data: [255, 252],
        write: (stream: DataStream) => {
          stream.writeInt16(-100);
        },
      },
    ];

    const sbgp = audioStbl.add("sbgp").set("version", 0).set("grouping_type", "roll").set("grouping_type_parameter", 0);

    sbgp.entries = [
      {
        sample_count: this.audioSamples.length,
        group_description_index: 1,
      },
    ];

    return this.mp4box.getBuffer();
  }

  /**
   * Checks whether the current browser supports the required WebCodecs APIs
   * (VideoEncoder, AudioEncoder, VideoDecoder) and H.264 encoding.
   *
   * @returns `true` if all required APIs and codecs are available.
   */
  static async checkBrowserSupport() {
    return (
      window.VideoEncoder &&
      window.AudioEncoder &&
      window.VideoDecoder &&
      (await VideoEncoder.isConfigSupported({ codec: "avc1.4d0034", width: 42, height: 42 })).supported
    );
  }

  /**
   * Configures the internal H.264 video encoder and Opus audio encoder with
   * the given video dimensions. Must be called before pushing any frames or
   * audio data.
   *
   * @param videoWidth - Output video width in pixels.
   * @param videoHeight - Output video height in pixels.
   * @throws If the browser does not support the encoder configurations.
   */
  async configureEncoders(videoWidth: number, videoHeight: number) {
    this.videoWidth = videoWidth;
    this.videoHeight = videoHeight;

    const videoEncoderConfig = {
      codec: "avc1.4d0034",
      width: this.videoWidth,
      height: this.videoHeight,
      bitrate: this.videoBitrate,
      bitrateMode: "variable",
      latencyMode: this.latencyMode,
      framerate: Math.round(1 / this.videoChunkSec),
    } as VideoEncoderConfig;

    if (!(await VideoEncoder.isConfigSupported(videoEncoderConfig)).supported)
      throw new Error("VideoEncoder config not supported.");
    this.videoEncoder.configure(videoEncoderConfig);

    const audioEncoderConfig = {
      codec: "opus",
      bitrate: this.audioBitrate,
      bitrateMode: "variable",
      sampleRate: this.audioSampleRate,
      numberOfChannels: this.audioOutputChannels,
    } as AudioEncoderConfig;

    if (!(await AudioEncoder.isConfigSupported(audioEncoderConfig)).supported)
      throw new Error("AudioEncoder config not supported.");
    this.audioEncoder.configure(audioEncoderConfig);

    await isConfigured(this.videoEncoder);
    await isConfigured(this.audioEncoder);
  }

  /**
   * Callback invoked by the VideoEncoder when an encoded video chunk is ready.
   * Stores the chunk data and metadata (including AVC decoder config records)
   * as a sample for later muxing.
   */
  private onEncodedVideoChunk(chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata | undefined) {
    if (meta?.decoderConfig?.description) {
      this.avcDecoderConfigRecord = new Uint8Array(meta.decoderConfig.description as ArrayBuffer).buffer;
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    const prev = this.videoSamples.at(-1) ?? this.EMPTY_SAMPLE;

    const dts = Math.round(usToSec(chunk.timestamp) * this.videoOutputTimescale);
    const duration = Math.round(usToSec(chunk.duration ?? 0) * this.videoOutputTimescale);

    this.videoSamples.push({
      number: prev.number + 1,
      offset: prev.offset + prev.size,
      sync: chunk.type === "key",
      dts,
      duration,
      size: data.byteLength,
      data,
    });
  }

  /**
   * Callback invoked by the AudioEncoder when an encoded audio chunk is ready.
   * Stores the chunk data as a sample for later muxing.
   */
  private onEncodedAudioChunk(chunk: EncodedAudioChunk) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);

    const prev = this.audioSamples.at(-1) ?? this.EMPTY_SAMPLE;
    if (!chunk.duration) {
      console.warn("Audio chunk dropped: missing duration");
      return;
    }

    const dts = Math.round(usToSec(chunk.timestamp) * this.audioSampleRate);
    const duration = Math.round(usToSec(chunk.duration) * this.audioSampleRate);

    this.audioSamples.push({
      number: prev.number + 1,
      offset: prev.offset + prev.size,
      sync: true,
      dts,
      duration,
      size: data.byteLength,
      data,
    });
  }

  /**
   * Encodes a single video frame. Automatically inserts keyframes at the
   * interval specified by {@link keyframeIntevalSec}. The frame is closed
   * after encoding.
   *
   * @param frame - The raw VideoFrame to encode. Will be closed by this method.
   */
  async pushVideoFrame(frame: VideoFrame) {
    try {
      this.throwIfEncoderError();
      const keyFrame = frame.timestamp >= this.nextKeyframeUs;
      if (keyFrame) this.nextKeyframeUs += secToUs(this.keyframeIntevalSec);

      this.videoEncoder.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }
  }

  /**
   * Encodes a single AudioData chunk using the internal Opus encoder.
   *
   * @param data - The raw AudioData to encode.
   */
  async pushAudioData(data: AudioData) {
    try {
      this.throwIfEncoderError();
      this.audioEncoder.encode(data);
    } finally {
      data.close();
    }
  }

  /**
   * Convenience method that converts a Web Audio API {@link AudioBuffer} into
   * an {@link AudioData} object (resampled to {@link audioSampleRate} and
   * remapped to {@link audioOutputChannels}) and pushes it for encoding.
   *
   * @param buffer - A decoded AudioBuffer (e.g. from `AudioContext.decodeAudioData`).
   */
  async processAudioBuffer(buffer: AudioBuffer) {
    this.throwIfEncoderError();
    const numberOfFrames = Math.round(buffer.duration * this.audioSampleRate);
    const numberOfChannels = buffer.numberOfChannels;
    const audioData = new Float32Array(numberOfFrames * this.audioOutputChannels);

    for (let ch = 0; ch < this.audioOutputChannels; ch++) {
      const sourceChannel = Math.min(ch, numberOfChannels - 1);
      const data = buffer.getChannelData(sourceChannel);
      audioData.set(data, ch * numberOfFrames);
    }

    await this.pushAudioData(
      new AudioData({
        format: "f32-planar",
        sampleRate: this.audioSampleRate,
        numberOfChannels: this.audioOutputChannels,
        numberOfFrames,
        timestamp: 0,
        data: audioData,
      }),
    );
  }

  /** Discards the internal encoder instances */
  closeEncoders() {
    if (this.videoEncoder.state !== "closed") this.videoEncoder.close();
    if (this.audioEncoder.state !== "closed") this.audioEncoder.close();
  }
}
