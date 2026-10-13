declare global { interface Window { __SPATIAL_SOFTWARE_RENDERING__?: boolean; } }
export const softwareRendering = typeof window !== "undefined" && window.__SPATIAL_SOFTWARE_RENDERING__ === true;
export function initializeRendering() {
  document.documentElement.dataset.webkitSoftware = String(softwareRendering);
}
