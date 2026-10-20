"use client";

/**
 * ImageCropper — reusable "pick → crop → confirm" step for image uploads.
 *
 * Facebook-style crop-BOX model (standard website cropper): the picked
 * image stays FITTED on the stage; the user drags the CROP BOX to move it
 * and drags its corner/edge handles to resize it, cutting exactly the
 * selected region. Zoom (slider / − / + / mouse wheel / pinch) scales the
 * fitted image for finer framing — the box itself is still what gets cut.
 *
 * Confirm renders the chosen region to a canvas and hands the caller a
 * data URL (JPEG, or PNG when the source is a PNG so transparency in
 * logos survives); Cancel discards everything. No new dependency —
 * pointer events + canvas only. Geometry lives in "@/lib/crop-box".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/utils";
import { AlertCircle, Loader2, ZoomIn } from "lucide-react";
import {
  boxForAspect,
  clampBoxToBounds,
  computeExportRect,
  moveBox,
  resizeBox,
  type BoxHandle,
  type CropBoxMode,
  type CropRect,
  type ImgBounds,
} from "@/lib/crop-box";

export interface CropAspect {
  id: string;
  label: string;
  /** width / height; null = free-form (box starts at the full image, handles free) */
  ratio: number | null;
}

export const CROP_ASPECTS: CropAspect[] = [
  { id: "square", label: "Square 1:1", ratio: 1 },
  { id: "43", label: "4:3", ratio: 4 / 3 },
  { id: "32", label: "3:2", ratio: 3 / 2 },
  { id: "169", label: "16:9", ratio: 16 / 9 },
  { id: "free", label: "Free", ratio: null },
];

interface ImageCropperProps {
  open: boolean;
  /** The picked file; null while closed. */
  file: File | null;
  title?: string;
  aspects?: CropAspect[];
  defaultAspectId?: string;
  /** Longest output side in px (default 1024). */
  maxOutputSize?: number;
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
}

const VIEW_H = 340; // viewport height in px (width = container width)
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const HANDLE_HIT = 18; // px around a handle center that counts as grabbing it
const HANDLES: BoxHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function ImageCropper({
  open,
  file,
  title = "Crop image",
  aspects = CROP_ASPECTS,
  defaultAspectId = "square",
  maxOutputSize = 1024,
  onConfirm,
  onCancel,
}: ImageCropperProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [aspectId, setAspectId] = useState(defaultAspectId);
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [stageW, setStageW] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [box, setBox] = useState<CropRect | null>(null);
  const [busy, setBusy] = useState(false);

  const boxRef = useRef<CropRect | null>(null);
  boxRef.current = box;
  const dragRef = useRef<
    | { mode: "move" | BoxHandle; startX: number; startY: number; orig: CropRect }
    | { mode: "pinch"; startDist: number; startZoom: number }
    | null
  >(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const aspectRef = useRef(aspectId);
  aspectRef.current = aspectId;

  const aspect = aspects.find((a) => a.id === aspectId) ?? aspects[0];
  const mode: CropBoxMode = aspect.ratio === null ? "free" : aspect.ratio;
  const imageAspect = nat.w > 0 && nat.h > 0 ? nat.w / nat.h : 1;

  const measureStage = useCallback(() => {
    const el = viewportRef.current;
    if (el) {
      const w = el.clientWidth;
      if (w > 0) setStageW(w);
    }
  }, []);

  // Fitted display: whole image visible at zoom 1, centered on the stage.
  const fitScale = nat.w > 0 && nat.h > 0 && stageW > 0 ? Math.min(stageW / nat.w, VIEW_H / nat.h) : 1;
  const scale = fitScale * zoom;
  const bounds: ImgBounds | null =
    nat.w > 0 && nat.h > 0 && stageW > 0
      ? {
          ox: (stageW - nat.w * scale) / 2,
          oy: (VIEW_H - nat.h * scale) / 2,
          w: nat.w * scale,
          h: nat.h * scale,
        }
      : null;

  // Recreate the box when the image/aspect changes; clamp it when zoom moves.
  const refreshBox = useCallback(
    (b: ImgBounds, recreate: boolean) => {
      setBox((prev) => {
        if (recreate || !prev) return boxForAspect(b, mode, imageAspect);
        return clampBoxToBounds(prev, b, mode, imageAspect);
      });
    },
    [mode, imageAspect]
  );

  useEffect(() => {
    if (bounds) refreshBox(bounds, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds?.ox, bounds?.oy, bounds?.w, bounds?.h]);

  useEffect(() => {
    if (bounds) refreshBox(bounds, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspectId, nat.w, nat.h]);

  // Load the picked file.
  useEffect(() => {
    if (!open || !file) return;
    setError("");
    setReady(false);
    setAspectId(defaultAspectId);
    setNat({ w: 0, h: 0 });
    setZoom(1);
    setBox(null);
    dragRef.current = null;
    pointersRef.current.clear();
    if (!file.type.startsWith("image/")) {
      setError("That file is not an image. Please choose a JPG, PNG or WebP photo.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("That image is larger than 15 MB. Please choose a smaller photo.");
      return;
    }
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [open, file, defaultAspectId]);

  // Measure the stage once the modal mounts.
  useEffect(() => {
    if (open) {
      const t = setTimeout(measureStage, 50);
      window.addEventListener("resize", measureStage);
      return () => {
        clearTimeout(t);
        window.removeEventListener("resize", measureStage);
      };
    }
  }, [open, measureStage]);

  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) {
      setError("We could not read that image. Please try a different photo.");
      return;
    }
    setNat({ w, h });
    setReady(true);
  }, []);

  const setZoomClamped = (z: number) => {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)));
  };

  const handleCenter = (b: CropRect, handle: BoxHandle) => {
    const right = b.x + b.w;
    const bottom = b.y + b.h;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    switch (handle) {
      case "nw": return { hx: b.x, hy: b.y };
      case "n": return { hx: cx, hy: b.y };
      case "ne": return { hx: right, hy: b.y };
      case "e": return { hx: right, hy: cy };
      case "se": return { hx: right, hy: bottom };
      case "s": return { hx: cx, hy: bottom };
      case "sw": return { hx: b.x, hy: bottom };
      case "w": return { hx: b.x, hy: cy };
    }
  };

  const stagePoint = (clientX: number, clientY: number) => {
    const el = viewportRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const hitTest = (pt: { x: number; y: number }): "move" | BoxHandle | null => {
    const b = boxRef.current;
    if (!b) return null;
    for (const handle of HANDLES) {
      const { hx, hy } = handleCenter(b, handle);
      if (Math.abs(pt.x - hx) <= HANDLE_HIT && Math.abs(pt.y - hy) <= HANDLE_HIT) {
        return handle;
      }
    }
    if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) {
      return "move";
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!ready) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const [p1, p2] = [...pointersRef.current.values()];
      dragRef.current = {
        mode: "pinch",
        startDist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
        startZoom: zoom,
      };
      return;
    }
    const pt = stagePoint(e.clientX, e.clientY);
    const kind = pt ? hitTest(pt) : null;
    if (kind && boxRef.current) {
      dragRef.current = { mode: kind, startX: pt!.x, startY: pt!.y, orig: boxRef.current };
    }
    // Clicks outside the box start no drag (the image itself no longer moves).
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag.mode === "pinch" && pointersRef.current.size === 2) {
      const [p1, p2] = [...pointersRef.current.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (drag.startDist > 0) setZoomClamped(drag.startZoom * (dist / drag.startDist));
      return;
    }
    const b = bounds;
    if (!b || !nat.w || !nat.h) return;
    const pt = stagePoint(e.clientX, e.clientY);
    if (!pt) return;
    const curMode: CropBoxMode =
      (aspects.find((a) => a.id === aspectRef.current) ?? aspect).ratio === null
        ? "free"
        : ((aspects.find((a) => a.id === aspectRef.current) ?? aspect).ratio as number);
    if (drag.mode === "move") {
      setBox(moveBox(drag.orig, pt.x - drag.startX, pt.y - drag.startY, b));
    } else if (drag.mode !== "pinch") {
      setBox(resizeBox(drag.orig, drag.mode, pt.x, pt.y, curMode, b, nat.w / nat.h));
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size === 0) dragRef.current = null;
    else if (pointersRef.current.size === 1) {
      const [p] = [...pointersRef.current.values()];
      const pt = stagePoint(p.x, p.y);
      const kind = pt ? hitTest(pt) : null;
      dragRef.current =
        kind && boxRef.current
          ? { mode: kind, startX: pt!.x, startY: pt!.y, orig: boxRef.current }
          : null;
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!ready) return;
    setZoomClamped(zoom * (e.deltaY < 0 ? 1.08 : 0.92));
  };

  /* --------------------------------- confirm --------------------------------- */
  const handleConfirm = () => {
    const img = imgRef.current;
    if (!img || !ready || busy || !box || !bounds) return;
    setBusy(true);
    try {
      const rect = computeExportRect(nat.w, nat.h, box, scale, bounds.ox, bounds.oy);
      let ow = rect.sw;
      let oh = rect.sh;
      const longest = Math.max(ow, oh);
      if (longest > maxOutputSize) {
        const k = maxOutputSize / longest;
        ow = Math.max(1, Math.round(ow * k));
        oh = Math.max(1, Math.round(oh * k));
      }
      // Encode with a hard size guarantee (A-to-Z audit 2026-10-20, C1):
      // photos are stored as data URLs inside a Firestore doc (1 MiB
      // limit; the server cap is 950,000 chars). A 1024px PNG of a real
      // phone photo routinely exceeds that — the owner hit exactly the
      // server's "too large after cropping" rejection. So: start with
      // the faithful encode, then step quality down, then dimensions,
      // until the result fits the budget. A normal photo now always
      // saves; only a pathological image can still fail.
      const MAX_DATA_URL_CHARS = 900_000;
      const renderTo = (w: number, h: number, jpegOnWhite: boolean) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const cx = c.getContext("2d");
        if (!cx) throw new Error("canvas unavailable");
        if (jpegOnWhite) {
          cx.fillStyle = "#ffffff";
          cx.fillRect(0, 0, w, h);
        }
        cx.drawImage(img, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, w, h);
        return c;
      };
      const isPng = file?.type === "image/png";
      let dataUrl = isPng
        ? renderTo(ow, oh, false).toDataURL("image/png")
        : renderTo(ow, oh, false).toDataURL("image/jpeg", 0.85);
      if (dataUrl.length > MAX_DATA_URL_CHARS) {
        // JPEG re-encode (photos gain nothing from lossless PNG here).
        for (const q of [0.85, 0.7, 0.55, 0.4]) {
          dataUrl = renderTo(ow, oh, true).toDataURL("image/jpeg", q);
          if (dataUrl.length <= MAX_DATA_URL_CHARS) break;
        }
        let scale = 0.75;
        while (dataUrl.length > MAX_DATA_URL_CHARS && ow * scale >= 96) {
          const w = Math.max(1, Math.round(ow * scale));
          const h = Math.max(1, Math.round(oh * scale));
          dataUrl = renderTo(w, h, true).toDataURL("image/jpeg", 0.7);
          scale *= 0.75;
        }
      }
      onConfirm(dataUrl);
    } catch {
      setError("Something went wrong while cropping. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const minZoomPct = MIN_ZOOM;
  const zoomFrac = (zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="lg"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-rbai-border text-rbai-text hover:bg-rbai-bg transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!ready || busy || !box}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-rbai-primary text-white hover:bg-rbai-primary-dark transition-colors disabled:opacity-50 inline-flex items-center gap-2"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Use this crop
          </button>
        </>
      }
    >
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-rbai-danger/10 text-rbai-danger px-4 py-3 text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : (
        <div className="space-y-4">
          <div
            ref={viewportRef}
            className="relative w-full overflow-hidden rounded-lg bg-black/85 select-none"
            style={{ height: VIEW_H, touchAction: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onWheel={onWheel}
          >
            {objectUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={imgRef}
                src={objectUrl}
                alt=""
                draggable={false}
                onLoad={handleImgLoad}
                onError={() =>
                  setError("We could not read that image. Please try a different photo.")
                }
                className="absolute max-w-none"
                style={
                  bounds
                    ? {
                        left: bounds.ox,
                        top: bounds.oy,
                        width: bounds.w,
                        height: bounds.h,
                      }
                    : { left: 0, top: 0, opacity: 0 }
                }
              />
            )}
            {!ready && !error && (
              <div className="absolute inset-0 flex items-center justify-center text-white/80 text-sm gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading image…
              </div>
            )}
            {ready && bounds && box && (
              <>
                {/* Dimmed masks around the crop box */}
                <div className="absolute bg-black/55 pointer-events-none" style={{ left: 0, top: 0, right: 0, height: Math.max(0, box.y) }} />
                <div className="absolute bg-black/55 pointer-events-none" style={{ left: 0, right: 0, top: box.y + box.h, bottom: 0 }} />
                <div className="absolute bg-black/55 pointer-events-none" style={{ left: 0, top: box.y, width: Math.max(0, box.x), height: box.h }} />
                <div className="absolute bg-black/55 pointer-events-none" style={{ right: 0, top: box.y, width: Math.max(0, stageW - (box.x + box.w)), height: box.h }} />
                {/* Crop box frame + thirds grid */}
                <div
                  data-testid="crop-box"
                  className="absolute border-2 border-white pointer-events-none"
                  style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
                >
                  <div className="absolute top-0 bottom-0 w-px bg-white/45" style={{ left: box.w / 3 }} />
                  <div className="absolute top-0 bottom-0 w-px bg-white/45" style={{ left: (box.w * 2) / 3 }} />
                  <div className="absolute left-0 right-0 h-px bg-white/45" style={{ top: box.h / 3 }} />
                  <div className="absolute left-0 right-0 h-px bg-white/45" style={{ top: (box.h * 2) / 3 }} />
                </div>
                {/* 8 resize handles */}
                {HANDLES.map((h) => {
                  const { hx, hy } = handleCenter(box, h);
                  const cursor =
                    h === "nw" || h === "se"
                      ? "cursor-nwse-resize"
                      : h === "ne" || h === "sw"
                        ? "cursor-nesw-resize"
                        : h === "n" || h === "s"
                          ? "cursor-ns-resize"
                          : "cursor-ew-resize";
                  return (
                    <span
                      key={h}
                      data-testid={`crop-handle-${h}`}
                      role="presentation"
                      className={cn("absolute w-4 h-4 rounded bg-white border-2 border-rbai-primary pointer-events-none", cursor)}
                      style={{ left: hx - 8, top: hy - 8 }}
                    />
                  );
                })}
              </>
            )}
          </div>

          <p className="text-xs text-rbai-text-light">
            Drag the box to move it over the part you want. Drag a corner or edge to
            resize it. Zoom in for finer framing.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {aspects.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAspectId(a.id)}
                aria-pressed={a.id === aspectId}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-full border transition-colors",
                  a.id === aspectId
                    ? "bg-rbai-primary text-white border-rbai-primary"
                    : "border-rbai-border text-rbai-text hover:border-rbai-primary/50"
                )}
              >
                {a.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setZoomClamped(zoom - 0.25)}
              aria-label="Zoom out"
              className="h-8 w-8 flex-shrink-0 rounded-full border border-rbai-border text-rbai-text text-lg font-bold leading-none"
            >
              −
            </button>
            <ZoomIn className="h-4 w-4 text-rbai-text-light flex-shrink-0" />
            <input
              type="range"
              min={minZoomPct}
              max={MAX_ZOOM}
              step={0.01}
              value={Number(zoom.toFixed(2))}
              onChange={(e) => setZoomClamped(Number(e.target.value))}
              className="w-full accent-rbai-primary"
              aria-label="Zoom"
            />
            <button
              type="button"
              onClick={() => setZoomClamped(zoom + 0.25)}
              aria-label="Zoom in"
              className="h-8 w-8 flex-shrink-0 rounded-full border border-rbai-border text-rbai-text text-lg font-bold leading-none"
            >
              +
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
