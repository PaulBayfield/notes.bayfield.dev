// Images full size, and saving images and files from documents. Mounted once; the editor's node
// views ask for either through window events (see editor/media.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { downloadAttachment, resolveUrl } from "../lib/api";
import { useSettings } from "../lib/settings";
import { DOWNLOAD_EVENT, fileNameFrom, VIEW_IMAGE_EVENT, type DownloadRequest, type ViewImageRequest } from "../editor/media";
import { Download, X, ZoomIn, ZoomOut } from "./icons";

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function MediaHost({ onError }: { onError: (e: unknown) => void }) {
  const [image, setImage] = useState<ViewImageRequest | null>(null);
  const save = useCallback((r: DownloadRequest) => void downloadAttachment(r.href, r.name).catch(onError), [onError]);

  useEffect(() => {
    const onView = (e: Event) => setImage((e as CustomEvent<ViewImageRequest>).detail);
    const onDownload = (e: Event) => save((e as CustomEvent<DownloadRequest>).detail);
    window.addEventListener(VIEW_IMAGE_EVENT, onView);
    window.addEventListener(DOWNLOAD_EVENT, onDownload);
    return () => {
      window.removeEventListener(VIEW_IMAGE_EVENT, onView);
      window.removeEventListener(DOWNLOAD_EVENT, onDownload);
    };
  }, [save]);

  if (!image) return null;
  return <Lightbox key={image.src} image={image} onDownload={save} onClose={() => setImage(null)} />;
}

/**
 * The image over the whole window. It starts fitted to the window; clicking it (or the zoom
 * buttons, Ctrl+wheel, + and -) shows it larger, and it can then be scrolled around.
 */
function Lightbox({ image, onDownload, onClose }: { image: ViewImageRequest; onDownload: (r: DownloadRequest) => void; onClose: () => void }) {
  const { t } = useSettings();
  const imgRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** null: fitted to the window; otherwise a multiple of the image's own size. */
  const [zoom, setZoom] = useState<number | null>(null);
  /** Re-renders once the image's size is known. */
  const [, setLoaded] = useState(false);

  /** The zoom the fitted image is shown at, so zooming in starts from what's on screen. */
  const fittedZoom = () => {
    const img = imgRef.current;
    return img && img.naturalWidth ? img.clientWidth / img.naturalWidth : 1;
  };
  const step = useCallback((dir: 1 | -1) => {
    setZoom((z) => {
      const current = z ?? fittedZoom();
      const next = dir > 0 ? ZOOM_STEPS.find((s) => s > current + 0.01) : [...ZOOM_STEPS].reverse().find((s) => s < current - 0.01);
      return next ?? current;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") step(1);
      else if (e.key === "-") step(-1);
      else if (e.key === "0") setZoom(null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, step]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      step(e.deltaY < 0 ? 1 : -1);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [step]);

  const natural = imgRef.current?.naturalWidth ?? 0;
  const style = zoom === null || !natural ? undefined : { width: natural * zoom, maxWidth: "none", maxHeight: "none" };

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={image.caption ?? t("viewImage")}>
      <div className="lightbox-bar">
        <span className="lightbox-zoom">{Math.round((zoom ?? (natural ? fittedZoom() : 1)) * 100)}%</span>
        <button className="icon-button" title={`${t("zoomOut")} (-)`} onClick={() => step(-1)}>
          <ZoomOut />
        </button>
        <button className="icon-button" title={`${t("zoomIn")} (+)`} onClick={() => step(1)}>
          <ZoomIn />
        </button>
        <button className="icon-button" title={t("download")} onClick={() => onDownload({ href: image.src, name: fileNameFrom(image.caption, "image") })}>
          <Download />
        </button>
        <button className="icon-button" title={`${t("close")} (Esc)`} onClick={onClose}>
          <X />
        </button>
      </div>
      <div
        ref={stageRef}
        className={`lightbox-stage${zoom === null ? " fitted" : ""}`}
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <img
          ref={imgRef}
          src={resolveUrl(image.src)}
          alt={image.caption ?? ""}
          style={style}
          draggable={false}
          onLoad={() => setLoaded(true)}
          onClick={() => setZoom((z) => (z === null ? Math.max(1, fittedZoom() * 2) : null))}
        />
      </div>
      {image.caption && <div className="lightbox-caption">{image.caption}</div>}
    </div>,
    document.body,
  );
}
