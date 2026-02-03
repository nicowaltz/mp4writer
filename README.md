# mp4writer

Browser-based MP4 muxer and demuxer using WebCodecs and mp4box.js.

Encode H.264 video and Opus audio from raw `VideoFrame` and `AudioData` objects, then assemble them into a valid MP4 file — entirely in the browser with zero server-side dependencies.

## Features

- **Push-based encoding** — feed in `VideoFrame`s and `AudioData`, get back a complete MP4 buffer
- **Pull-based demuxing** — random-access seeking and full sequential reads from existing MP4 files

## Install

```bash
npm install mp4writer
```

## Quick start

### Encoding an MP4

```ts
import { MP4PushMuxerEncoder } from "mp4writer";

const muxer = new MP4PushMuxerEncoder();
await muxer.configureEncoders(1920, 1080);

// Push audio
await muxer.processAudioBuffer(audioBuffer);

// Push video frames
for (const frame of videoFrames) {
  await muxer.pushVideoFrame(frame);
}

// Produce the final MP4
const mp4 = await muxer.multiplexToBuffer();
muxer.closeEncoders();
```

### Demuxing an MP4

```ts
import { MP4PullDemuxer } from "mp4writer";

const demuxer = new MP4PullDemuxer(mp4Blob);
const config = await demuxer.getVideoDecoderConfig();

// Read all samples sequentially
const samples = await demuxer.readAllSamples();

// Or seek to a specific timestamp
const { samples: seekSamples, ptsIndex } = await demuxer.seek(5000);
```

### Full decode-transform-encode example

```ts
import { MP4PullDemuxer, MP4PushMuxerEncoder, isConfigured } from "mp4writer";
import { secToUs } from "mp4writer";

const demuxer = new MP4PullDemuxer(inputBlob);
const muxer = new MP4PushMuxerEncoder();

const config = await demuxer.getVideoDecoderConfig();
await muxer.configureEncoders(config.codedWidth!, config.codedHeight!);
await muxer.processAudioBuffer(audioBuffer);

const decoder = new VideoDecoder({
  output: async (frame) => {
    // Transform the frame (draw on it, filter, etc.)
    const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(frame, 0, 0);
    frame.close();

    const modified = new VideoFrame(canvas, {
      timestamp: frame.timestamp,
      duration: frame.duration!,
    });
    await muxer.pushVideoFrame(modified);
  },
  error: console.error,
});

decoder.configure(config);
await isConfigured(decoder);

for (const sample of await demuxer.readAllSamples()) {
  decoder.decode(
    new EncodedVideoChunk({
      type: sample.is_sync ? "key" : "delta",
      timestamp: secToUs(sample.cts / sample.timescale),
      duration: secToUs(sample.duration / sample.timescale),
      data: sample.data,
    }),
  );
}

await decoder.flush();
const mp4 = await muxer.multiplexToBuffer();
muxer.closeEncoders();
```

## API

### `MP4PushMuxerEncoder`

| Method                             | Description                                                       |
| ---------------------------------- | ----------------------------------------------------------------- |
| `configureEncoders(width, height)` | Configure the H.264 video encoder and Opus audio encoder          |
| `pushVideoFrame(frame)`            | Encode a `VideoFrame` (closed automatically after encoding)       |
| `pushAudioData(data)`              | Encode an `AudioData` chunk (closed automatically after encoding) |
| `processAudioBuffer(buffer)`       | Convert an `AudioBuffer` to `AudioData` and encode it             |
| `multiplexToBuffer()`              | Flush encoders and produce the final MP4 buffer                   |
| `closeEncoders()`                  | Release encoder resources                                         |
| `checkBrowserSupport()`            | Static — check if the browser supports the required APIs          |

Constructor accepts an optional `MP4PushMuxerEncoderConfig`:

| Option                | Default          | Description                             |
| --------------------- | ---------------- | --------------------------------------- |
| `videoBitrate`        | `2_000_000`      | Video bitrate in bits/s                 |
| `videoChunkSec`       | `~0.033` (30fps) | Duration of each video chunk in seconds |
| `keyframeIntevalSec`  | `2`              | Keyframe interval in seconds            |
| `latencyMode`         | `"realtime"`     | `"realtime"` or `"quality"`             |
| `audioBitrate`        | `64_000`         | Audio bitrate in bits/s                 |
| `audioSampleRate`     | `48_000`         | Audio sample rate in Hz                 |
| `audioOutputChannels` | `2`              | Number of audio output channels         |

### `MP4PullDemuxer`

| Method                               | Description                                                                |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `getVideoDecoderConfig()`            | Get a `VideoDecoderConfig` for the first video track (times out after 10s) |
| `seek(timestampMs)`                  | Seek to a timestamp and return a decoder-ready window of samples           |
| `readAllSamples()`                   | Read all video samples with data, in DTS order                             |
| `dtsIndexToPtsIndex(dtsIndex)`       | Convert a DTS index to a PTS index                                         |
| `timestampMsToPtsIndex(timestampMs)` | Find the PTS index for a given timestamp                                   |

### `isConfigured(codec, timeoutMs?)`

Returns a `Promise` that resolves when a `VideoEncoder`, `AudioEncoder`, `VideoDecoder`, or `AudioDecoder` reaches the `"configured"` state. Times out after `timeoutMs` (default 10s).

## Browser support

Requires the [WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) with H.264 encoding support. Use `MP4PushMuxerEncoder.checkBrowserSupport()` to verify at runtime.

## Licence

[MIT](./LICENCE.md) — Nicholas Waltz — [nicholaswaltz.com](https://nicholaswaltz.com)
