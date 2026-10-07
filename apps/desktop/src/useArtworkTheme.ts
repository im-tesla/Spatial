import { useEffect, useState } from "react";
import { getArtwork } from "./artwork";
import { defaultTheme, themeFromPixels } from "./theme";
import type { Theme } from "./theme";

const palettes = new Map<string, Promise<Theme>>();

function palette(id: string): Promise<Theme> {
  const cached = palettes.get(id);
  if (cached) return cached;
  const request = getArtwork(id).then(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return defaultTheme;
    context.drawImage(image, 0, 0, 32, 32);
    return themeFromPixels(context.getImageData(0, 0, 32, 32).data);
  }).catch(error => { palettes.delete(id); throw error; });
  palettes.set(id, request);
  if (palettes.size > 100) palettes.delete(palettes.keys().next().value!);
  return request;
}

export function useArtworkTheme(id: string | null | undefined): Theme {
  const [theme, setTheme] = useState(defaultTheme);
  useEffect(() => {
    let active = true;
    if (!id) setTheme(defaultTheme);
    else palette(id).then(value => { if (active) setTheme(value); }).catch(() => { if (active) setTheme(defaultTheme); });
    return () => { active = false; };
  }, [id]);
  return theme;
}
