// @picovoice/pvspeaker-node ships types in dist/types but does not point to them
// from package.json. This maps the CommonJS module to those types.
declare module '@picovoice/pvspeaker-node' {
  import type PvSpeaker from '@picovoice/pvspeaker-node/dist/types/pv_speaker';

  const pvspeaker: { PvSpeaker: typeof PvSpeaker };
  export default pvspeaker;
}
