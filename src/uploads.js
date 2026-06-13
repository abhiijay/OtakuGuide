// src/uploads.js — avatar photo uploads (multipart/form-data via multer).
//
// Why this is wired the way it is: the app uses a synchronizer-token CSRF check
// (src/auth.js `csrf`) that reads the token from req.body._csrf. For a normal
// urlencoded form, express.urlencoded fills req.body before csrf runs. A file
// upload is multipart, which urlencoded does NOT parse — so multer has to run
// FIRST, or csrf sees an empty body and rejects every upload. server.js mounts
// `avatarUpload` on the /profile path BEFORE app.use(csrf) for exactly this:
// multer parses the multipart body (the _csrf text field included), then the
// normal csrf check still guards the request. Keep _csrf the first field in the
// form so it's parsed even if the file itself is rejected.
//
// Storage is in MEMORY, not on disk: because multer runs before csrf, a disk
// store would write the file to disk and only THEN have csrf (or a validation
// error) reject the request — leaving an orphan file behind. Buffering in
// memory (avatars are <= 2 MB, one file) means nothing touches disk until the
// route has validated everything and calls saveAvatarFile().
'use strict';

const path = require('path');
const fs = require('fs');
const multer = require('multer');

// Uploaded avatars live under public/ so express.static serves them directly
// at /uploads/avatars/<file>. The dir is gitignored (user content, not source).
const AVATAR_DIR = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — plenty for an avatar, cheap to store

// Only raster image types we can safely <img>. mimetype → file extension.
const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (EXT_BY_MIME[file.mimetype]) return cb(null, true);
    const err = new Error('Unsupported image type.');
    err.code = 'UNSUPPORTED_TYPE'; // recognized by the avatarUpload wrapper
    cb(err);
  },
}).single('avatar');

// avatarUpload — the middleware server.js mounts on /profile. Wraps multer so a
// rejected file (too big / wrong type) never 500s: we stash a friendly message
// on req.uploadError and continue, letting the csrf check and the route run
// normally (the route re-shows the form with the message). Skips entirely for
// non-POST or unauthenticated requests — requireAuth will bounce those anyway.
function avatarUpload(req, res, next) {
  if (req.method !== 'POST' || !req.user) return next();
  upload(req, res, (err) => {
    if (err) {
      req.uploadError =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'That image is too large — keep it under 2 MB.'
          : err.code === 'UNSUPPORTED_TYPE'
            ? 'Unsupported image type. Use JPG, PNG or WebP.'
            : 'Could not read that file. Try another image.';
    }
    next();
  });
}

// saveAvatarFile(userId, file) — persist a validated in-memory upload to disk,
// returning the public path to store in users.avatar. Named by user id (ties
// it to the owner) plus a timestamp (busts the browser cache on re-upload so a
// new photo never shows the old cached one).
function saveAvatarFile(userId, file) {
  const ext = EXT_BY_MIME[file.mimetype] || 'jpg';
  const name = `${userId}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, name), file.buffer);
  return `/uploads/avatars/${name}`;
}

// Best-effort delete of a previous upload when it's replaced, so old avatar
// files don't pile up. Never throws — a failed cleanup must not break a save.
function removeUpload(avatarValue) {
  if (!avatarValue || !avatarValue.startsWith('/uploads/avatars/')) return;
  const abs = path.join(AVATAR_DIR, path.basename(avatarValue));
  fs.unlink(abs, () => {});
}

module.exports = { avatarUpload, saveAvatarFile, removeUpload, AVATAR_DIR };
