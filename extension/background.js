// Service worker do MV3. Ponto de entrada do core.
// Registra listeners de webRequest sincronamente — o MV3 SW pode ser morto
// a qualquer momento e precisa acordar nos eventos certos.

import { registerHlsListeners } from "./core/webrequest-hls.js";

registerHlsListeners();

console.log("[core] service worker booted");
