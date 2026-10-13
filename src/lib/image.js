// Browser-side avatar processing. Re-encoding through a canvas decodes the image
// (so a non-image file renamed to .png is rejected), strips metadata such as EXIF
// location, crops to a centred square and bounds the size to a small thumbnail.
import { AVATAR_UPLOAD_MAX_BYTES } from './profile.js';

const SIZE = 256;

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function processAvatar(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file couldn't be read as an image.");
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error("That file couldn't be read as an image.");
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
    let type = 'image/webp';
    let blob = await toBlob(canvas, type, 0.85);
    if (!blob || blob.type !== type) {
      type = 'image/jpeg'; // browsers without WebP encoding fall back to JPEG
      blob = await toBlob(canvas, type, 0.88);
    }
    if (!blob) throw new Error("That image couldn't be processed.");
    if (blob.size > AVATAR_UPLOAD_MAX_BYTES) throw new Error('That image is too large after processing.');
    return { blob, type };
  } finally {
    bitmap.close?.();
  }
}
