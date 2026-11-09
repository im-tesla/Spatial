import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { UserRound } from "lucide-react";
import { getArtistArtwork, getArtwork } from "./artwork";
import { ease } from "./motion";

export default function ArtistCover({ name, artworkId, className = "", eager = false }: {
  name: string; artworkId: string | null; className?: string; eager?: boolean;
}) {
  const reduced = useReducedMotion();
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [portrait, setPortrait] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);

  useEffect(() => {
    if (eager) return;
    const element = root.current;
    if (!element || typeof IntersectionObserver !== "function") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "420px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager]);

  useEffect(() => {
    let active = true;
    setPortrait(null);
    if (!visible || !name.trim()) return;
    getArtistArtwork(name).then(value => { if (active) setPortrait(value); }).catch(() => {});
    return () => { active = false; };
  }, [visible, name]);

  useEffect(() => {
    let active = true;
    setFallback(null);
    if (!artworkId) return;
    getArtwork(artworkId).then(value => { if (active) setFallback(value); }).catch(() => {});
    return () => { active = false; };
  }, [artworkId]);

  return <div ref={root} className={`artist-cover ${className}`} data-has-portrait={portrait ? "true" : undefined}>
    {fallback && <img className="artist-cover-fallback" src={fallback} alt="" aria-hidden="true" />}
    {portrait && <motion.img className="artist-cover-portrait" src={portrait} alt={`${name} portrait`}
      initial={{ opacity: 0, scale: reduced ? 1 : 1.03 }} animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: reduced ? 0 : .55, ease }} />}
    {!portrait && !fallback && <span className="artist-cover-placeholder" aria-hidden="true"><UserRound /></span>}
    <span className="artist-cover-ring" aria-hidden="true" />
  </div>;
}
