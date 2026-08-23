import { PNG } from "pngjs";
import { describe, expect, it } from "vite-plus/test";

import {
  decorateSovereignIcon,
  flattenSovereignIcon,
  renderSovereignMarkPng,
} from "./sovereign-icon.ts";

function solidPng(size: number): Buffer {
  const image = new PNG({ width: size, height: size, colorType: 6 });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = 8;
    image.data[offset + 1] = 32;
    image.data[offset + 2] = 22;
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
}

describe("Sovereign icon rendering", () => {
  it("leaves production icon bytes unchanged", () => {
    const source = solidPng(128);
    expect(decorateSovereignIcon(source, undefined)).toBe(source);
  });

  it("renders deterministic, distinct development and preview badges", () => {
    const source = solidPng(128);
    const development = decorateSovereignIcon(source, "DEV");
    const preview = decorateSovereignIcon(source, "PREVIEW");
    expect(PNG.sync.read(development)).toMatchObject({ width: 128, height: 128 });
    expect(PNG.sync.read(preview)).toMatchObject({ width: 128, height: 128 });
    expect(development.equals(source)).toBe(false);
    expect(preview.equals(source)).toBe(false);
    expect(preview.equals(development)).toBe(false);
    expect(decorateSovereignIcon(source, "DEV").equals(development)).toBe(true);
  });

  it("flattens native iOS icons onto an opaque black canvas", () => {
    const image = new PNG({ width: 16, height: 16, colorType: 6 });
    image.data.fill(0);
    image.data[0] = 200;
    image.data[1] = 100;
    image.data[2] = 50;
    image.data[3] = 128;
    const flattened = PNG.sync.read(flattenSovereignIcon(PNG.sync.write(image)));
    expect([...flattened.data.slice(0, 4)]).toEqual([100, 50, 25, 255]);
    for (let offset = 3; offset < flattened.data.length; offset += 4) {
      expect(flattened.data[offset]).toBe(255);
    }
  });

  it("renders a square transparent monochrome companion mark", () => {
    const mark = PNG.sync.read(renderSovereignMarkPng(96));
    expect(mark).toMatchObject({ width: 96, height: 96 });
    let transparentPixels = 0;
    let opaquePixels = 0;
    for (let offset = 3; offset < mark.data.length; offset += 4) {
      if (mark.data[offset] === 0) transparentPixels += 1;
      if (mark.data[offset] === 255) opaquePixels += 1;
    }
    expect(transparentPixels).toBeGreaterThan(0);
    expect(opaquePixels).toBeGreaterThan(0);
  });
});
