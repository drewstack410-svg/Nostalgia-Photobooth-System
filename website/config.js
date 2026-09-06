// Public Cloudflare R2 location for guest photos/video.
// The QR only carries a short session code (?s=); this page loads a
// manifest from R2, then the images and video listed in that file.
// Keep these in sync with desktop/.env (VITE_R2_PUBLIC_URL, VITE_R2_FOLDER).
window.NOSTALGIA_GALLERY = {
  r2Base: "https://pub-9d3f2264233d455dbccecef6d8efddfa.r2.dev",
  r2Folder: "nostalgia-photobooth",
};
