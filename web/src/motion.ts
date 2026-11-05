import { useReducedMotion } from "framer-motion";

export function useMotionPreset() {
  const reduce = useReducedMotion();
  return {
    reduce: Boolean(reduce),
    spring: reduce
      ? { duration: 0 }
      : { type: "spring" as const, stiffness: 440, damping: 36, mass: 0.75 },
    soft: reduce ? { duration: 0 } : { duration: 0.38, ease: [0.22, 1, 0.36, 1] as const },
  };
}
