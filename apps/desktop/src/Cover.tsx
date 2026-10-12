import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Disc3 } from "lucide-react";
import { getArtwork } from "./artwork";
import { ease } from "./motion";

export default function Cover({ id, title, className = "" }: { id: string | null; title: string; className?: string }) {
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    let active = true;
    if (id) {
      getArtwork(id).then(async url => {
        const decoded = new Image(); decoded.src = url; await decoded.decode();
        if (active) setImage({ id, url });
      }).catch(() => { if (active) setImage(null); });
    } else setImage(null);
    return () => { active = false; };
  }, [id]);
  return <div className={`cover ${className}`}><Disc3 aria-hidden="true" /><AnimatePresence initial={false}>
    {image && <motion.img key={image.id} src={image.url} alt={`${title} artwork`}
      initial={{ opacity: 0, scale: reduced ? 1 : 1.025 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: reduced ? 0 : .6, ease }} />}
  </AnimatePresence></div>;
}
