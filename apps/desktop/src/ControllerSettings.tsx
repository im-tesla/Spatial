import { useState } from "react";
import { bindingActions, buttonLabels, defaultBindings, swapBinding } from "./controller";
import type { ControllerProfile } from "./controller";
import SelectPicker from "./SelectPicker";
import type { useController } from "./useController";

const labels = { accept: "Select", back: "Back", pause: "Play / Pause", rewind: "Back 10 seconds", forward: "Forward 10 seconds", fullscreen: "Fullscreen" };
const options = buttonLabels.map((label, index) => ({ value: String(index), label }));
export default function ControllerSettings({ controller }: { controller: ReturnType<typeof useController> }) {
  const [draft, setDraft] = useState<ControllerProfile>(() => ({ enabled: controller.profile.enabled, bindings: { ...controller.profile.bindings } }));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  function save() {
    try { controller.save(draft); setError(""); setMessage("Controller settings saved."); }
    catch { setError("Controller settings couldn't be saved. Check that local app storage is available."); setMessage(""); }
  }
  return <section className="preference-section controller-settings" aria-labelledby="controller-heading">
    <div className="preference-row"><div><h3 id="controller-heading">Controller</h3><p>Browse and listen from your controller.</p></div>
      <button className={`preference-switch ${draft.enabled ? "enabled" : ""}`} role="switch" aria-label="Enable controller controls" aria-checked={draft.enabled}
        onClick={() => { setDraft(previous => ({ ...previous, enabled: !previous.enabled })); setMessage(""); }}><span /></button></div>
    <p className="preference-note" role="status">{controller.profile.enabled ? controller.status || "Press a controller button to connect." : "Controller controls are off."}</p>
    <div className="controller-bindings">{bindingActions.map(action => <SelectPicker key={action} label={labels[action]} options={options}
      value={String(draft.bindings[action])} onChange={value => { setDraft(previous => ({ ...previous, bindings: swapBinding(previous.bindings, action, Number(value)) })); setMessage(""); }} />)}</div>
    <div className="controller-help"><p>D-pad / left stick: navigate · Right stick: scroll</p><p>Mappings apply after saving. Assigning a used button swaps the two actions. Text entry uses your keyboard.</p></div>
    <div className="controller-actions"><button className="secondary" onClick={() => { setDraft(previous => ({ ...previous, bindings: { ...defaultBindings } })); setMessage(""); }}>Reset mapping</button>
      <button className="primary" onClick={save}>Save settings</button></div>
    {message && <p className="preference-note" role="status">{message}</p>}{error && <p className="form-error" role="status">{error}</p>}
  </section>;
}
