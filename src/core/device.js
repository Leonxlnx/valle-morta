// Device class, decided once at load. ?mobile=1 / ?mobile=0 in the URL overrides it for testing.
const q = new URLSearchParams(globalThis.location?.search || '').get('mobile');
const coarse = !!globalThis.matchMedia && matchMedia('(pointer: coarse)').matches;
const touch = coarse || (globalThis.navigator?.maxTouchPoints || 0) > 0;
const small = Math.min(globalThis.screen?.width || 9999, globalThis.screen?.height || 9999) < 900;
const ua = /Android|iPhone|iPad|iPod|Mobile/i.test(globalThis.navigator?.userAgent || '');
export const TOUCH = q === '1' ? true : q === '0' ? false : touch && (coarse || ua);
export const MOBILE = q === '1' ? true : q === '0' ? false : TOUCH && (small || ua);
export const IOS = /iPhone|iPad|iPod/i.test(globalThis.navigator?.userAgent || '') || (globalThis.navigator?.platform === 'MacIntel' && (globalThis.navigator?.maxTouchPoints || 0) > 1);
