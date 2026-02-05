/**
 * Copyright (c) 2026 Nicholas Waltz
 *
 * lib/mp4box.d.ts
 */

export interface MP4MediaTrackEdit {
  media_rate_fraction: number;
  media_rate_integer: number;
  media_time: number;
  segment_duration: number;
}

export class MP4BoxStream {
  constructor(data: ArrayBuffer);
  buffer: MP4ArrayBuffer;
  dataview: DataView;
  position: number;
}

export interface MP4MediaTrack {
  id: number;
  created: Date;
  modified: Date;
  movie_duration: number;
  movie_timescale: number;
  layer: number;
  alternate_group: number;
  volume: number;
  track_width: number;
  track_height: number;
  timescale: number;
  duration: number;
  bitrate: number;
  codec: string;
  language: string;
  nb_samples: number;
  samples_duration: number;
  edits: MP4MediaTrackEdit[];
  samples: MP4Sample[];
}

export interface MP4VideoData {
  width: number;
  height: number;
}

export interface MP4VideoTrack extends MP4MediaTrack {
  video: MP4VideoData;
}

export interface MP4AudioData {
  sample_rate: number;
  channel_count: number;
  sample_size: number;
}

export interface MP4AudioTrack extends MP4MediaTrack {
  audio: MP4AudioData;
}

export type MP4Track = MP4VideoTrack | MP4AudioTrack;

export interface MP4Info {
  duration: number;
  timescale: number;
  fragment_duration: number;
  isFragmented: boolean;
  isProgressive: boolean;
  hasIOD: boolean;
  brands: string[];
  created: Date;
  modified: Date;
  tracks: MP4Track[];
  audioTracks: MP4AudioTrack[];
  videoTracks: MP4VideoTrack[];
  otherTracks: MP4VideoTrack[];
}

export interface MP4Sample {
  alreadyRead: number;
  chunk_index: number;
  chunk_run_index: number;
  cts: number;
  data?: Uint8Array | null;
  degradation_priority: number;
  depends_on: number;
  description: unknown;
  description_index: number;
  dts: number;
  duration: number;
  has_redundancy: number;
  is_depended_on: number;
  is_leading: number;
  is_sync: boolean;
  number: number;
  offset: number;
  size: number;
  timescale: number;
  track_id: number;
}

export type MP4ArrayBuffer = ArrayBuffer & { fileStart: number };

export class DataStream {
  static BIG_ENDIAN: boolean;
  static LITTLE_ENDIAN: boolean;
  buffer: ArrayBuffer;
  constructor(arrayBuffer: ArrayBuffer | undefined, byteOffset: number, endianness: boolean);
  writeUint8(u8: number): void;
  writeUint16(u16: number): void;
  writeUint32(u32: number): void;
  writeInt16(i16: number): void;
}

export class MultiBufferStream {
  cleanBuffers(): void;
}

export interface Trak {
  mdia?: {
    minf?: {
      stbl?: {
        stsd?: {
          entries: {
            avcC?: {
              write: (stream: DataStream) => void;
            };
            hvcC?: {
              write: (stream: DataStream) => void;
            };
            vpcC?: {
              write: (stream: DataStream) => void;
            };
            av1C?: {
              write: (stream: DataStream) => void;
            };
          }[];
        };
      };
    };
  };
  samples: MP4Sample[];
}

export namespace BoxParser {
  export class Box {
    size?: number;
    data?: Uint8Array;

    constructor(type?: string, size?: number);

    add(name: string): Box;
    set(key: string, value: any): Box;
    addBox(box: Box): Box;
    addEntry(value: string, prop?: string): void;
    parse(stream: MP4BoxStream): void;
    write(stream: DataStream): void;
    writeHeader(stream: DataStream, msg?: string): void;
    computeSize(): void;
  }

  export class ContainerBox extends Box {}

  export class SampleEntry extends Box {
    data_reference_index: number;
  }

  export class avcCBox extends ContainerBox {}

  export class hvcCBox extends ContainerBox {}

  export class vpcCBox extends ContainerBox {}

  export class av1CBox extends ContainerBox {}

  class urlBox extends ContainerBox {}
  export { urlBox as "url Box" };

  export class avc1SampleEntry extends SampleEntry {}

  export class OpusSampleEntry extends SampleEntry {}
}

export interface TrackOptions {
  id?: number;
  type?: string;
  width?: number;
  height?: number;
  duration?: number;
  layer?: number;
  timescale?: number;
  media_duration?: number;
  language?: string;
  hdlr?: string;

  // video
  avcDecoderConfigRecord?: BufferSource;

  // audio
  balance?: number;
  channel_count?: number;
  samplesize?: number;
  samplerate?: number;

  //captions
  namespace?: string;
  schema_location?: string;
  auxiliary_mime_types?: string;

  description?: BoxParser.Box;
  description_boxes?: BoxParser.Box[];

  default_sample_description_index_id?: number;
  default_sample_duration?: number;
  default_sample_size?: number;
  default_sample_flags?: number;
}

export interface SampleOptions {
  sample_description_index?: number;
  duration?: number;
  cts?: number;
  dts?: number;
  is_sync?: boolean;
  is_leading?: number;
  depends_on?: number;
  is_depended_on?: number;
  has_redundancy?: number;
  degradation_priority?: number;
}

export interface Sample {
  number: number;
  track_id: number;
  timescale: number;
  description_index: number;
  description: {
    avcC?: BoxParser.avcCBox; // h.264
    hvcC?: BoxParser.hvcCBox; // hevc
    vpcC?: BoxParser.vpcCBox; // vp9
    av1C?: BoxParser.av1CBox; // av1
  };
  data: ArrayBuffer;
  size: number;
  alreadyRead?: number;
  duration: number;
  cts: number;
  dts: number;
  is_sync: boolean;
  is_leading?: number;
  depends_on?: number;
  is_depended_on?: number;
  has_redundancy?: number;
  degradation_priority?: number;
  offset?: number;
}

export interface MP4File {
  addBox(...arg: any): any;
  add(...arg: any): any;
  getBuffer(): MP4ArrayBuffer;
  getSample(trak: Trak, number: number): MP4Sample;
  addTrack(options?: TrackOptions): number;
  addSample(track: number, data: ArrayBuffer, options?: SampleOptions): Sample;
  addSample(trackID: number, uint8: Uint8Array, arg2: { duration: number; is_sync: boolean }): void;
  onMoovStart?: () => void;
  onReady?: (info: MP4Info) => void;
  onError?: (e: string) => void;
  onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => unknown;
  appendBuffer(data: MP4ArrayBuffer): number;
  save(fileName: string): void;
  start(): void;
  stop(): void;
  /**
   * Indicates that the next samples to process (for extraction or
   * segmentation) start at the given time (Number, in seconds) or at the
   * time of the previous Random Access Point (if useRap is true, default
   * is false). Returns the offset in the file of the next bytes to be
   * provided via appendBuffer.
   *
   * @param time - Start at the given time (Number, in seconds)
   * @param useRap - Random Access Point (if useRap is true, default is false)
   * @returns Returns the offset in the file of the next bytes to be provided via appendBuffer.
   */
  seek: (time: number, useRap: boolean) => { offset: number; time: number };
  flush(): void;
  releaseUsedSamples(trackId: number, sampleNumber: number): void;
  setExtractionOptions(trackId: number, user?: unknown, options?: { nbSamples?: number; rapAlignment?: number }): void;
  getTrackById(trackId: number): Trak;
  stream: MultiBufferStream;
}

export const MP4Box: {
  createFile(): MP4File;
};
