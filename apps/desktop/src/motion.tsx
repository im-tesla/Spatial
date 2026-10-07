import type { ReactNode, RefObject } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";

export const ease = [.22, 1, .36, 1] as const;
export const spring = { type: "spring", stiffness: 420, damping: 36, mass: .85 } as const;

export function PageTransition({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  return <motion.div className="page-content" inert={!present}
    initial={{ opacity: 0, y: reduced ? 0 : 12 }} animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: reduced ? 0 : -5, transition: { duration: reduced ? 0 : .12 } }}
    transition={{ duration: reduced ? 0 : .28, ease, opacity: { duration: reduced ? 0 : .18 } }}>
    {children}
  </motion.div>;
}

export function LyricsSlot({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  return <motion.div className="lyrics-slot" inert={!present}
    initial={{ opacity: 0, x: reduced ? 0 : 16 }} animate={{ opacity: 1, x: 0 }}
    exit={{ opacity: 0, x: reduced ? 0 : 12, transition: { duration: reduced ? 0 : .2 } }}
    transition={{ duration: reduced ? 0 : .38, ease }}>{children}</motion.div>;
}

export function DialogTransition({ children, dialogRef, onClose }: {
  children: ReactNode; dialogRef: RefObject<HTMLElement | null>; onClose: () => void;
}) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  return <motion.div className="modal-backdrop" inert={!present} onClick={onClose}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : .18 }}>
    <motion.section ref={dialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"
      initial={{ opacity: 0, y: reduced ? 0 : 18, scale: reduced ? 1 : .975 }} animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: reduced ? 0 : 8, scale: reduced ? 1 : .985 }} transition={{ duration: reduced ? 0 : .3, ease }}
      onClick={event => event.stopPropagation()}>{children}</motion.section>
  </motion.div>;
}
