import sharp from 'sharp';

sharp.concurrency(1);
sharp.cache(false);

/** Downscales oversized, near-matching images to an exact target using centered cover cropping. */
export async function resizeToTarget(bytes, target) {
  if (!target) return { bytes, resized: false };
  let metadata;
  try { metadata = await sharp(bytes).metadata(); }
  catch {
    const to = `${target.width}x${target.height}`;
    console.info(`RESIZE decision=keep from=unknownxunknown to=${to} reason=metadata_unavailable`);
    return { bytes, resized: false, reason: 'metadata_unavailable' };
  }
  const width = metadata.width;
  const height = metadata.height;
  const source = `${width}x${height}`;
  const targetText = `${target.width}x${target.height}`;
  const ratioMatches = width > 0 && height > 0
    && Math.abs(Math.log((width / height) / (target.width / target.height))) <= 0.02;
  const oversized = width > target.width || height > target.height;
  const reason = !ratioMatches ? 'aspect_ratio_mismatch' : !oversized ? 'not_larger' : 'target_size';
  if (!ratioMatches || !oversized || !['png', 'jpeg', 'webp'].includes(metadata.format)) {
    const keepReason = ['png', 'jpeg', 'webp'].includes(metadata.format) ? reason : 'unsupported_format';
    console.info(`RESIZE decision=keep from=${source} to=${targetText} reason=${keepReason}`);
    return { bytes, resized: false, from: source, to: targetText, reason: keepReason };
  }
  const output = await sharp(bytes).resize(target.width, target.height, {
    fit: 'cover', position: 'centre', kernel: 'lanczos3',
  }).toFormat(metadata.format).toBuffer();
  console.info(`RESIZE decision=downscale from=${source} to=${targetText} reason=target_size`);
  return { bytes: output, resized: true, from: source, to: targetText, reason: 'target_size' };
}
