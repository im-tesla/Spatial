import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { getArtwork } from "./artwork";
import { softenPixels } from "./backdropPixels";
import { ease } from "./motion";

const textures = new Map<string, Promise<string>>();
function texture(id: string): Promise<string> {
  const cached = textures.get(id);
  if (cached) return cached;
  const request = getArtwork(id).then(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 96;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Artwork background unavailable");
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 96, 96);
    const pixels = context.getImageData(0, 0, 96, 96);
    pixels.data.set(softenPixels(pixels.data, 96, 96));
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL();
  }).catch(error => { textures.delete(id); throw error; });
  textures.set(id, request);
  if (textures.size > 32) textures.delete(textures.keys().next().value!);
  return request;
}

export default function BackdropCover({ id, className = "" }: { id: string | null; className?: string }) {
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    let current = true;
    if (!id) setImage(null);
    else texture(id).then(url => { if (current) setImage({ id, url }); }).catch(() => { if (current) setImage(null); });
    return () => { current = false; };
  }, [id]);
  return <div className={`cover backdrop-cover ${className}`} aria-hidden="true"><AnimatePresence initial={false}>
    {image && <motion.img key={image.id} src={image.url} alt="" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : .6, ease }} />}
  </AnimatePresence></div>;
}
