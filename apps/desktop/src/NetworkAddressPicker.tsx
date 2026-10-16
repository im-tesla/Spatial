import SelectPicker from "./SelectPicker";

export default function NetworkAddressPicker({ interfaces, value, disabled, onChange }: {
  interfaces: { address: string; name: string }[]; value: string; disabled: boolean; onChange: (address: string) => void;
}) {
  return <SelectPicker label="Network address" options={interfaces.map(item => ({ value: item.address, label: item.name, detail: item.address }))}
    value={value} disabled={disabled} onChange={onChange} />;
}
