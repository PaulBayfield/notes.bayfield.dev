// Images and files in documents: viewing an image full size and downloading either. The node
// views only ask; `MediaHost` (mounted once in the app) shows the viewer and saves the files.

/** Asks the app to show an image full size. */
export const VIEW_IMAGE_EVENT = "notes:view-image";
/** Asks the app to save an image or a file. */
export const DOWNLOAD_EVENT = "notes:download";

export interface ViewImageRequest {
  src: string;
  caption: string | null;
}

export interface DownloadRequest {
  href: string;
  /** Suggested file name; the extension is added from the file's type when missing. */
  name: string;
}

export function viewImage(request: ViewImageRequest) {
  window.dispatchEvent(new CustomEvent(VIEW_IMAGE_EVENT, { detail: request }));
}

export function downloadMedia(request: DownloadRequest) {
  window.dispatchEvent(new CustomEvent(DOWNLOAD_EVENT, { detail: request }));
}

/** A file name from a caption or title: no characters Windows refuses, not too long. */
export function fileNameFrom(text: string | null | undefined, fallback: string): string {
  const name = (text ?? "")
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return name || fallback;
}
