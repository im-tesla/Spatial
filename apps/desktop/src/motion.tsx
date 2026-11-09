import type { ReactNode } from "react";
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
