/**
 * Copyright (c) 2026 Nicholas Waltz
 * https://nicholaswaltz.com
 *
 * examples/example.ts
 */

import { isConfigured } from "../promisifyWebCodecs";
import { MP4ArrayBuffer } from "../lib/mp4box";
import { MP4PullDemuxer } from "../MP4PullDemuxer";
import { MP4PushMuxerEncoder } from "../MP4PushEncoderMuxer";
import { secToUs } from "../time";

async function saveBufferToFile(buffer: MP4ArrayBuffer, filename: string) {
  const blob = new Blob([buffer]);
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  document.body.appendChild(a);
  a.setAttribute("href", url);
  a.setAttribute("download", filename);
  a.setAttribute("target", "_self");
  a.click();
  window.URL.revokeObjectURL(url);
}

export async function test() {
  const video = await fetch("/test.mp4");
  const videoBlob = await video.blob();

  const audio = await fetch("/test.mp3");
  const audioBlob = await audio.blob();

  const demuxer = new MP4PullDemuxer(videoBlob);
  const muxer = new MP4PushMuxerEncoder();
  const audioCtx = new OfflineAudioContext(muxer.audioOutputChannels, 1, muxer.audioSampleRate);
  const audioBuffer = await audioCtx.decodeAudioData(await audioBlob.arrayBuffer());

  const config = await demuxer.getVideoDecoderConfig();

  if (!config.codedWidth || !config.codedHeight) return;

  await muxer.configureEncoders(config.codedWidth, config.codedHeight);
  await muxer.processAudioBuffer(audioBuffer);

  const onFrame = async (frame: VideoFrame) => {
    if (!frame.duration) return frame.close();
    const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
    const ctx = canvas.getContext("2d")!;

    ctx.drawImage(frame, 0, 0);

    // Draw square
    ctx.strokeStyle = "red";
    ctx.lineWidth = 5;
    ctx.strokeRect(50, 50, 100, 100);

    const modifiedFrame = new VideoFrame(canvas as any, {
      timestamp: frame.timestamp,
      duration: frame.duration,
    });

    frame.close();
    await muxer.pushVideoFrame(modifiedFrame);
    modifiedFrame.close();
  };

  const decoder = new VideoDecoder({
    output: onFrame,
    error: console.error,
  });

  decoder.configure(config);
  await isConfigured(decoder);

  const videoSamples = await demuxer.readAllSamples();

  for (let sample of videoSamples) {
    if (!sample.data) return;
    decoder.decode(
      new EncodedVideoChunk({
        type: sample.is_sync ? "key" : "delta",
        timestamp: secToUs(sample.cts / sample.timescale),
        duration: secToUs(sample.duration / sample.timescale),
        data: sample.data,
      }),
    );
  }

  // wait for queue to finish
  await decoder.flush();

  const buffer = await muxer.multiplexToBuffer();
  await saveBufferToFile(buffer, "output :).mp4");

  muxer.closeEncoders();
}
