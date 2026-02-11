/**
 * Copyright (c) 2026 Nicholas Waltz
 *
 * setupOpusBoxParser.ts
 */

import { BoxParser } from "./lib/mp4box.js";

declare module "./lib/mp4box.js" {
  namespace BoxParser {
    export class dOpsBox extends ContainerBox {
      Version: number;
      OutputChannelCount: number;
      PreSkip: number;
      InputSampleRate: number;
      OutputGain: number;
      ChannelMappingFamily: number;
    }
  }
}

/**
 * Extends the BoxParser to include a write function for the Opus dOps box
 */
BoxParser.dOpsBox.prototype.write = function (stream) {
  // 1 Version + 1 OutputChannelCount + 2 PreSkip + 4 InputSampleRate + 2 OutputGain + 1 ChannelMappingFamily
  this.size = 11;

  this.writeHeader(stream);
  stream.writeUint8(this.Version);
  stream.writeUint8(this.OutputChannelCount);
  stream.writeUint16(this.PreSkip);
  stream.writeUint32(this.InputSampleRate);
  stream.writeInt16(this.OutputGain);
  stream.writeUint8(this.ChannelMappingFamily);

  if (this.ChannelMappingFamily !== 0) throw new Error("unsupported!");
};
