// src/avatar.js — how a user's stored avatar turns into an image URL.
//
// The `users.avatar` column holds ONE of:
//   - a placeholder key, e.g. "placeholder:2"  → one of our built-in SVGs
//   - an upload path,     e.g. "/uploads/avatars/7-1718.webp"
//   - NULL                                       → no choice made yet
//
// When it's NULL we don't show a blank: we pick a placeholder deterministically
// from the user's id, so the same account always gets the same default (no
// flicker on refresh) without anyone having to choose one. Real uploads and
// explicit placeholder picks always win over the default.
'use strict';

// The built-in placeholder set. Add a file public/img/avatars/placeholder-N.svg
// and bump COUNT to grow the gallery — the picker and the default both read
// from here, so there's one place to change.
const PLACEHOLDER_COUNT = 4;

// Every placeholder key, in order — used to render the picker grid.
const PLACEHOLDER_KEYS = Array.from(
  { length: PLACEHOLDER_COUNT },
  (_, i) => `placeholder:${i + 1}`
);

// "placeholder:2" → "/img/avatars/placeholder-2.svg"
function placeholderPath(key) {
  const n = Number(String(key).split(':')[1]);
  return `/img/avatars/placeholder-${n}.svg`;
}

// Is this a placeholder key we actually ship? Guards the edit form so a user
// can't POST "placeholder:999" (or an arbitrary path) into their avatar column.
function isValidPlaceholder(key) {
  return PLACEHOLDER_KEYS.includes(key);
}

// resolveAvatar(user) -> image URL to render. Exposed to every view via
// app.locals.avatarSrc (see server.js), so partials can call avatarSrc(user).
// Deterministic default: id % COUNT, stable per account.
function resolveAvatar(user) {
  if (!user) return placeholderPath('placeholder:1');
  const a = user.avatar;
  if (a && a.startsWith('/uploads/')) return a;
  if (a && isValidPlaceholder(a)) return placeholderPath(a);
  return `/img/avatars/placeholder-${(user.id % PLACEHOLDER_COUNT) + 1}.svg`;
}

module.exports = {
  PLACEHOLDER_COUNT,
  PLACEHOLDER_KEYS,
  placeholderPath,
  isValidPlaceholder,
  resolveAvatar,
};
