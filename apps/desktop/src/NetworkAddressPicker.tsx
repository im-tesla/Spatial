import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";

type Address = { address: string; name: string };

export default function NetworkAddressPicker({ interfaces, value, disabled, onChange }: {
  interfaces: Address[]; value: string; disabled: boolean; onChange: (address: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const reduced = useReducedMotion();
  const selected = Math.max(0, interfaces.findIndex(item => item.address === value));
  const current = interfaces[selected];
  const expanded = open && !disabled;

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [expanded]);
  useEffect(() => {
    if (expanded) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, expanded, id]);

  function choose(index: number) {
    if (interfaces[index]) onChange(interfaces[index].address);
    setOpen(false);
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && expanded) {
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    } else if (event.key === "Tab") setOpen(false);
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); setOpen(true);
      setActive(previous => event.key === "Home" ? 0 : event.key === "End" ? interfaces.length - 1 :
        !expanded ? selected : (previous + (event.key === "ArrowDown" ? 1 : -1) + interfaces.length) % interfaces.length);
    } else if ((event.key === "Enter" || event.key === " ") && expanded) {
      event.preventDefault(); choose(active);
    }
  }

  return <div className="remote-network" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <span id={`${id}-label`}>Network address</span>
    <button type="button" className="network-picker" role="combobox" disabled={disabled}
      aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="listbox" aria-expanded={expanded}
      aria-controls={`${id}-options`} aria-activedescendant={expanded ? `${id}-option-${active}` : undefined}
      onKeyDown={keyDown} onClick={() => { setActive(selected); setOpen(!expanded); }}>
      <span id={`${id}-value`}><span>{current?.name}</span><span className="network-address">{current?.address}</span></span>
      <ChevronDown size={16} className={expanded ? "expanded" : ""} />
    </button>
    <AnimatePresence>{expanded && <motion.div id={`${id}-options`} role="listbox" aria-labelledby={`${id}-label`}
      className="network-options" initial={{ opacity: 0, y: reduced ? 0 : -4 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: reduced ? 0 : -3 }} transition={{ duration: reduced ? 0 : .14 }}>
      {interfaces.map((item, index) => <div key={item.address} id={`${id}-option-${index}`} role="option"
        aria-selected={item.address === value} className={`network-option ${index === active ? "highlighted" : ""}`}
        onPointerMove={() => setActive(index)} onPointerDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span><span>{item.name}</span><span className="network-address">{item.address}</span></span>
        {item.address === value && <Check size={15} />}
      </div>)}
    </motion.div>}</AnimatePresence>
  </div>;
}
