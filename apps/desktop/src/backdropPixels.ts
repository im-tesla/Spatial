// Blur a small texture once, rather than a full-window image every frame.
export function softenPixels(pixels: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  if (width < 1 || height < 1 || pixels.length !== width * height * 4) throw new RangeError("Invalid artwork pixels");
  let source = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) source[i + channel] = pixels[i + channel] * pixels[i + 3] / 255;
    source[i + 3] = pixels[i + 3];
  }
  const radius = Math.min(8, Math.max(width, height) - 1), count = radius * 2 + 1;
  for (let pass = 0; pass < 3; pass++) for (const horizontal of [true, false]) {
    const length = horizontal ? width : height, rows = horizontal ? height : width;
    const result = new Float32Array(source.length);
    const index = (row: number, column: number, channel: number) => ((horizontal ? row * width + column : column * width + row) * 4) + channel;
    for (let row = 0; row < rows; row++) for (let channel = 0; channel < 4; channel++) {
      let sum = 0;
      for (let offset = -radius; offset <= radius; offset++) sum += source[index(row, Math.max(0, Math.min(length - 1, offset)), channel)];
      for (let column = 0; column < length; column++) {
        result[index(row, column, channel)] = sum / count;
        sum += source[index(row, Math.min(length - 1, column + radius + 1), channel)] - source[index(row, Math.max(0, column - radius), channel)];
      }
    }
    source = result;
  }
  const result = new Uint8ClampedArray(source.length);
  for (let i = 0; i < result.length; i += 4) {
    const alpha = source[i + 3];
    for (let channel = 0; channel < 3; channel++) result[i + channel] = alpha > 0 ? source[i + channel] * 255 / alpha : 0;
    result[i + 3] = alpha;
  }
  return result;
}
