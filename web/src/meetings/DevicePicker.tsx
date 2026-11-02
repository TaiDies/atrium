import { Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type Anchor, Popover } from '../components/ui';
import { chosenDevice, type DeviceKind } from './call';
import { useCall } from './CallContext';

// Choosing the microphone, camera and speaker for calls on this device. Device names only show once
// the app has been allowed to use the microphone or camera; the list follows devices being plugged in
// and out.

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    const load = () => void md.enumerateDevices().then(setDevices).catch(() => {});
    load();
    md.addEventListener?.('devicechange', load);
    return () => md.removeEventListener?.('devicechange', load);
  }, []);
  return devices;
}

const KINDS: { kind: DeviceKind; device: MediaDeviceKind; label: string }[] = [
  { kind: 'mic', device: 'audioinput', label: 'Microphone' },
  { kind: 'cam', device: 'videoinput', label: 'Camera' },
  { kind: 'speaker', device: 'audiooutput', label: 'Speaker' },
];

export function DevicePicker() {
  const { active } = useCall();
  const [at, setAt] = useState<Anchor | null>(null);
  const devices = useDevices();
  const [, redraw] = useState(0);
  // Picking where sound plays only works where the system allows it.
  const canSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  if (!active) return null;
  const unnamed = devices.length > 0 && devices.every((d) => !d.label);

  return (
    <>
      <button
        onClick={(e) => setAt(at ? null : e.currentTarget.getBoundingClientRect())}
        title="Microphone, camera and speaker"
        className="flex size-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <Settings2 size={18} />
      </button>
      <Popover anchor={at} onClose={() => setAt(null)}>
        <div className="w-80 space-y-3 p-3 text-sm">
          {KINDS.filter((k) => k.kind !== 'speaker' || canSpeaker).map(({ kind, device, label }) => {
            const list = devices.filter((d) => d.kind === device);
            const value = kind === 'speaker' ? active.speaker : chosenDevice(kind);
            return (
              <label key={kind} className="block">
                <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
                <select
                  value={list.some((d) => d.deviceId === value) ? value : ''}
                  onChange={(e) => {
                    void active.useDevice(kind, e.target.value).then(() => redraw((n) => n + 1));
                  }}
                  className="h-9 w-full rounded-md border border-line bg-surface px-2"
                >
                  <option value="">System default</option>
                  {list
                    .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
                    .map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `${label} ${i + 1}`}
                      </option>
                    ))}
                </select>
              </label>
            );
          })}
          {unnamed && <p className="text-xs text-faint">Turn on your microphone or camera once to see the devices' names.</p>}
          <p className="text-xs text-faint">Remembered on this device for every call.</p>
        </div>
      </Popover>
    </>
  );
}
