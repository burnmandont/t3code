import { PNG } from "pngjs";

export type SovereignIconBadge = "DEV" | "PREVIEW";

const BADGE_COLORS = {
  DEV: {
    border: [10, 14, 11, 255],
    fill: [214, 178, 82, 255],
    text: [10, 14, 11, 255],
  },
  PREVIEW: {
    border: [214, 178, 82, 255],
    fill: [13, 70, 47, 255],
    text: [244, 224, 164, 255],
  },
} as const;

const GLYPHS: Readonly<Record<string, ReadonlyArray<string>>> = {
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
};

type Rgba = readonly [number, number, number, number];
type Rgb = readonly [number, number, number];

function setPixel(image: PNG, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (y * image.width + x) * 4;
  image.data[offset] = color[0];
  image.data[offset + 1] = color[1];
  image.data[offset + 2] = color[2];
  image.data[offset + 3] = color[3];
}

function fillRect(
  image: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgba,
): void {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setPixel(image, column, row, color);
    }
  }
}

function fillRoundedRect(
  image: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  color: Rgba,
): void {
  const right = x + width - 1;
  const bottom = y + height - 1;
  const squaredRadius = radius * radius;
  for (let row = y; row <= bottom; row += 1) {
    for (let column = x; column <= right; column += 1) {
      const cornerX =
        column < x + radius ? x + radius : column > right - radius ? right - radius : column;
      const cornerY = row < y + radius ? y + radius : row > bottom - radius ? bottom - radius : row;
      const dx = column - cornerX;
      const dy = row - cornerY;
      if (dx * dx + dy * dy <= squaredRadius) setPixel(image, column, row, color);
    }
  }
}

function drawBadge(image: PNG, badge: SovereignIconBadge): void {
  const colors = BADGE_COLORS[badge];
  const size = image.width;
  const inset = Math.max(1, Math.round(size * 0.065));
  const height = Math.max(3, Math.round(size * 0.18));
  const border = Math.max(1, Math.round(size * 0.012));
  const padding = Math.max(1, Math.round(size * 0.026));
  const glyphScale = Math.floor((height - border * 2 - padding * 2) / 7);
  const glyphWidth = badge.length * 5 + Math.max(0, badge.length - 1);
  const textWidth = glyphScale > 0 ? glyphWidth * glyphScale : 0;
  const markerWidth = Math.max(height, Math.round(size * 0.28));
  const width = glyphScale > 0 ? textWidth + padding * 2 + border * 2 : markerWidth;
  const x = size - inset - width;
  const y = size - inset - height;
  const radius = Math.max(1, Math.floor(height / 2));

  fillRoundedRect(image, x, y, width, height, radius, colors.border);
  if (height > border * 2 && width > border * 2) {
    fillRoundedRect(
      image,
      x + border,
      y + border,
      width - border * 2,
      height - border * 2,
      Math.max(1, radius - border),
      colors.fill,
    );
  }
  if (glyphScale === 0) return;

  let glyphX = x + Math.floor((width - textWidth) / 2);
  const glyphY = y + Math.floor((height - 7 * glyphScale) / 2);
  for (const character of badge) {
    const glyph = GLYPHS[character];
    if (!glyph) throw new Error(`Unsupported Sovereign icon badge character: ${character}`);
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel === "1") {
          fillRect(
            image,
            glyphX + columnIndex * glyphScale,
            glyphY + rowIndex * glyphScale,
            glyphScale,
            glyphScale,
            colors.text,
          );
        }
      });
    });
    glyphX += 6 * glyphScale;
  }
}

export function decorateSovereignIcon(
  contents: Buffer,
  badge: SovereignIconBadge | undefined,
): Buffer {
  if (badge === undefined) return contents;
  const image = PNG.sync.read(contents);
  if (image.width !== image.height) throw new Error("Sovereign app icons must be square.");
  drawBadge(image, badge);
  return PNG.sync.write(image);
}

export function flattenSovereignIcon(contents: Buffer, background: Rgb = [0, 0, 0]): Buffer {
  const image = PNG.sync.read(contents);
  if (image.width !== image.height) throw new Error("Sovereign app icons must be square.");
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset]!;
    const green = image.data[offset + 1]!;
    const blue = image.data[offset + 2]!;
    const alpha = image.data[offset + 3]!;
    const inverseAlpha = 255 - alpha;
    image.data[offset] = Math.round((red * alpha + background[0] * inverseAlpha) / 255);
    image.data[offset + 1] = Math.round((green * alpha + background[1] * inverseAlpha) / 255);
    image.data[offset + 2] = Math.round((blue * alpha + background[2] * inverseAlpha) / 255);
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
}

export function renderSovereignMarkPng(size: number, color: Rgba = [255, 255, 255, 255]): Buffer {
  if (!Number.isInteger(size) || size < 16)
    throw new Error("Sovereign marks require a size of 16px or larger.");
  const image = new PNG({ width: size, height: size, colorType: 6 });
  image.data.fill(0);

  const unit = Math.max(1, Math.round(size / 16));
  const gridSize = unit * 2;
  const gap = unit;
  const gridSpan = gridSize * 3 + gap * 2;
  const origin = Math.floor((size - gridSpan) / 2);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      fillRect(
        image,
        origin + column * (gridSize + gap),
        origin + row * (gridSize + gap),
        gridSize,
        gridSize,
        color,
      );
    }
  }

  const rail = Math.max(1, unit);
  const center = Math.floor(size / 2) - Math.floor(rail / 2);
  const terminal = unit * 2;
  const innerStart = origin;
  const innerEnd = origin + gridSpan;
  const outerInset = Math.max(unit * 2, Math.round(size * 0.16));
  fillRect(image, outerInset, center, innerStart - outerInset, rail, color);
  fillRect(image, innerEnd, center, size - outerInset - innerEnd, rail, color);
  fillRect(image, center, outerInset, rail, innerStart - outerInset, color);
  fillRect(image, center, innerEnd, rail, size - outerInset - innerEnd, color);
  fillRect(
    image,
    outerInset - Math.floor(terminal / 2),
    center - Math.floor(terminal / 2),
    terminal,
    terminal,
    color,
  );
  fillRect(
    image,
    size - outerInset - Math.floor(terminal / 2),
    center - Math.floor(terminal / 2),
    terminal,
    terminal,
    color,
  );
  fillRect(
    image,
    center - Math.floor(terminal / 2),
    outerInset - Math.floor(terminal / 2),
    terminal,
    terminal,
    color,
  );
  fillRect(
    image,
    center - Math.floor(terminal / 2),
    size - outerInset - Math.floor(terminal / 2),
    terminal,
    terminal,
    color,
  );

  return PNG.sync.write(image);
}
