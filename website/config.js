// Public Cloudflare R2 location for guest photos/video.
// The QR only carries a short session code (?s=); this page loads a
// manifest from R2, then the images and video listed in that file.
// Keep these in sync with desktop/.env (VITE_R2_PUBLIC_URL, VITE_R2_FOLDER).
//
// origins[0] is the current bucket (/r2-2, /session-2). origins[1] is the
// original bucket (/r2, /session). The gallery tries the first and
// falls back to the next when that fetch 404s.
window.NOSTALGIA_GALLERY = {
  r2Base: "https://pub-9d3f2264233d455dbccecef6d8efddfa.r2.dev",
  r2Folder: "nostalgia-photobooth",
  origins: [
    {
      proxy: "/r2-2",
      session: "/session-2",
      base: "https://pub-9d3f2264233d455dbccecef6d8efddfa.r2.dev",
    },
    {
      proxy: "/r2",
      session: "/session",
      base: "https://pub-60ed42d101464039b0a65609342fdea3.r2.dev",
    },
  ],
};
