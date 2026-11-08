/** The containers ffmpeg may read (its demuxer names): MP4/MOV, MKV/WebM, AVI, MPEG, FLV, OGG and common audio. */
export const INPUT_FORMATS = 'mov,mp4,matroska,webm,avi,mpeg,mpegts,flv,ogg,wav,mp3,aac,flac,asf';

/**
 * How ffmpeg is told to read an upload: only real video and audio containers, only from the local file.
 * An upload pretending to be a video (a playlist pointing at other files or web addresses) is refused
 * instead of followed.
 */
export function ffmpegInput(file: string): string[] {
  return ['-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS, '-i', file];
}
