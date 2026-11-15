/**
 * Where this build is served from: "" for the production admin root, "/hq-preview" for the preview build (set at build
 * time by scripts/build.mjs). Sign-in, sign-out and post-sign-in returns stay inside the build the owner is using.
 */
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH === "/hq-preview" ? "/hq-preview" : "";
export const LOGIN_PATH = `${BASE}/login/`;
export const HOME_PATH = `${BASE}/`;
