/**
 * Pure crop-box math — port of the admin console's `lib/cropMath.ts`
 * box-model section (kept word-faithful so both apps share one proven
 * geometry). UI-agnostic: no DOM/react imports.
 *
 * Model: the image stays FITTED on the stage (centered, possibly
 * zoomed); the crop BOX is what moves and resizes over it. Boxes are
 * stage-space rects, always clamped inside the DISPLAYED image rect
 * ("bounds"), which is { ox, oy, w, h } — the image's on-stage
 * position and size.
 */

export type CropRect = { x: number; y: number; w: number; h: number };

/** A number is w/h; "free" keeps the image aspect for initial sizing. */
export type CropBoxMode = number | "free";

export type ImgBounds = { ox: number; oy: number; w: number; h: number };
export type BoxHandle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";

/** Smallest crop box, in stage pixels. */
export const MIN_BOX = 32;

function effectiveAspect(mode: CropBoxMode, imageAspect: number): number {
  return mode === "free" ? imageAspect : mode;
}

/** Largest box of the chosen aspect inside the bounds, centered.
 *  "free" starts as the full bounds (the whole fitted image). */
export function boxForAspect(
  bounds: ImgBounds,
  mode: CropBoxMode,
  imageAspect: number,
): CropRect {
  if (mode === "free") return { x: bounds.ox, y: bounds.oy, w: bounds.w, h: bounds.h };
  const aspect = effectiveAspect(mode, imageAspect);
  let w = bounds.w;
  let h = w / aspect;
  if (h > bounds.h) {
    h = bounds.h;
    w = h * aspect;
  }
  return {
    x: bounds.ox + (bounds.w - w) / 2,
    y: bounds.oy + (bounds.h - h) / 2,
    w,
    h,
  };
}

/** Clamp a box inside the bounds (size first, then position). When an
 *  aspect is locked the size is re-derived so w/h stays exact. */
export function clampBoxToBounds(
  box: CropRect,
  bounds: ImgBounds,
  mode: CropBoxMode,
  imageAspect: number,
  minSize: number = MIN_BOX,
): CropRect {
  let w = Math.max(minSize, Math.min(bounds.w, box.w));
  let h = Math.max(minSize, Math.min(bounds.h, box.h));
  if (mode !== "free") {
    const aspect = effectiveAspect(mode, imageAspect);
    h = w / aspect;
    if (h > bounds.h) {
      h = bounds.h;
      w = h * aspect;
    }
    if (h < minSize) {
      h = minSize;
      w = h * aspect;
    }
  }
  const x = Math.max(bounds.ox, Math.min(bounds.ox + bounds.w - w, box.x));
  const y = Math.max(bounds.oy, Math.min(bounds.oy + bounds.h - h, box.y));
  return { x, y, w, h };
}

/** Move a box by (dx, dy), clamped inside the bounds. */
export function moveBox(
  box: CropRect,
  dx: number,
  dy: number,
  bounds: ImgBounds,
): CropRect {
  return {
    x: Math.max(bounds.ox, Math.min(bounds.ox + bounds.w - box.w, box.x + dx)),
    y: Math.max(bounds.oy, Math.min(bounds.oy + bounds.h - box.h, box.y + dy)),
    w: box.w,
    h: box.h,
  };
}

/**
 * Resize a box by dragging `handle` to the pointer position (px, py) in
 * stage coordinates.
 *
 * Aspect LOCKED (mode is a number): corners scale the box along the ratio
 * from the opposite (anchored) corner; edges resize one axis and re-derive
 * the other, keeping the box's center on the untouched axis.
 * FREE: corners set w and h independently from the anchor; edges set one axis.
 */
export function resizeBox(
  box: CropRect,
  handle: BoxHandle,
  px: number,
  py: number,
  mode: CropBoxMode,
  bounds: ImgBounds,
  imageAspect: number,
  minSize: number = MIN_BOX,
): CropRect {
  const locked = mode !== "free";
  const aspect = effectiveAspect(mode, imageAspect);
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  let next: CropRect = { ...box };

  if (handle === "nw" || handle === "ne" || handle === "sw" || handle === "se") {
    const ax = handle === "nw" || handle === "sw" ? right : box.x; // anchor x
    const ay = handle === "nw" || handle === "ne" ? bottom : box.y; // anchor y
    const rawW = handle === "nw" || handle === "sw" ? ax - px : px - ax;
    const rawH = handle === "nw" || handle === "ne" ? ay - py : py - ay;
    let w: number;
    let h: number;
    if (locked) {
      w = Math.max(Math.abs(rawW), Math.abs(rawH) * aspect);
      h = w / aspect;
    } else {
      w = Math.abs(rawW);
      h = Math.abs(rawH);
    }
    const x = handle === "nw" || handle === "sw" ? ax - w : ax;
    const y = handle === "nw" || handle === "ne" ? ay - h : ay;
    next = { x, y, w, h };
  } else if (handle === "e" || handle === "w") {
    let w = handle === "e" ? px - box.x : right - px;
    w = Math.max(minSize, w);
    const h = locked ? w / aspect : box.h;
    const x = handle === "e" ? box.x : right - w;
    const y = locked ? cy - h / 2 : box.y;
    next = { x, y, w, h };
  } else {
    // "n" | "s"
    let h = handle === "s" ? py - box.y : bottom - py;
    h = Math.max(minSize, h);
    const w = locked ? h * aspect : box.w;
    const y = handle === "s" ? box.y : bottom - h;
    const x = locked ? cx - w / 2 : box.x;
    next = { x, y, w, h };
  }

  // Respect the min size before clamping into the bounds.
  if (next.w < minSize || next.h < minSize) {
    if (locked) {
      const w = Math.max(minSize, minSize * aspect);
      const adjust = clampBoxToBounds(
        { x: next.x, y: next.y, w, h: w / aspect },
        bounds, mode, imageAspect, minSize,
      );
      return adjust;
    }
    next = {
      x: next.x,
      y: next.y,
      w: Math.max(minSize, next.w),
      h: Math.max(minSize, next.h),
    };
  }

  return clampBoxToBounds(next, bounds, mode, imageAspect, minSize);
}

/**
 * The crop rect expressed in source-image pixels — what gets exported.
 * Returned rect is already clamped inside the source image and rounded to
 * whole pixels (canvas drawImage is most reliable with integers).
 */
export function computeExportRect(
  imgW: number,
  imgH: number,
  crop: CropRect,
  scale: number,
  ox: number,
  oy: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const s = scale > 0 ? scale : 1;
  let sx = (crop.x - ox) / s;
  let sy = (crop.y - oy) / s;
  let sw = crop.w / s;
  let sh = crop.h / s;
  // Clamp into the source image (float fuzz at the edges).
  sx = Math.max(0, Math.min(imgW - 1, sx));
  sy = Math.max(0, Math.min(imgH - 1, sy));
  sw = Math.max(1, Math.min(imgW - sx, sw));
  sh = Math.max(1, Math.min(imgH - sy, sh));
  return {
    sx: Math.round(sx),
    sy: Math.round(sy),
    sw: Math.round(sw),
    sh: Math.round(sh),
  };
}
