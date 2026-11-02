import { X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { LocationList, PlacePicker } from '../components/Placement';
import { useApp } from '../app/context';
import { Button, confirmDialog, Dialog, IconButton, Input, toast, toastError } from '../components/ui';
import { timeAgo } from '../lib/time';
import { kindOf, moveFile, refreshFiles, renameFile, type WorkspaceFile } from './api';

/**
 * A file's settings on the Files screen: its name, where it's used, and moving it to another page or
 * card — at the top, at the end, after a block or nested under one (e.g. inside a to-do item).
 */
export function FileSettingsDialog({ file, onClose }: { file: WorkspaceFile; onClose: () => void }) {
  const { workspace } = useApp();
  const [name, setName] = useState(file.name);

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === file.name) return;
    try {
      await renameFile(file.id, name.trim());
      await refreshFiles(workspace.id);
      toast('Renamed');
    } catch (err) {
      toastError(err);
    }
  };

  const unlinkAll = async () => {
    const ok = await confirmDialog({
      title: 'Remove from all pages?',
      message: 'The file stays in Files, but its block is removed from every page and card it is on.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await moveFile(file.id, null);
      await refreshFiles(workspace.id);
      toast('Removed from pages');
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <Dialog open onClose={onClose} width={560} top="6vh" maxHeight="88vh" className="flex flex-col">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="text-[15px] font-semibold">File settings</h2>
        <IconButton onClick={onClose} aria-label="Close">
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
        <form onSubmit={saveName}>
          <label className="mb-1.5 block text-xs font-medium text-muted">Name</label>
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1" maxLength={255} />
            <Button type="submit" disabled={!name.trim() || name.trim() === file.name}>
              Save
            </Button>
          </div>
          <div className="mt-1.5 text-xs text-faint">
            {kindOf(file) === 'note' ? 'Note' : file.mimeType} · {(file.size / 1024).toFixed(0)} KB · added {timeAgo(file.createdAt)}
          </div>
        </form>

        <LocationList locations={file.locations} empty="Not on any page yet. Pick a place below." onRemoveAll={unlinkAll} onOpen={onClose} />

        <PlacePicker
          title={file.locations.length ? 'Move to' : 'Put on a page'}
          hasLocations={file.locations.length > 0}
          hideBlock={(b) => ['file', 'image', 'video', 'audio'].includes(b.type) && b.text === file.name}
          onPlace={async (target, keepExisting) => {
            try {
              await moveFile(file.id, target, keepExisting);
              await refreshFiles(workspace.id);
              toast(keepExisting ? 'Added to the page' : 'Moved');
            } catch (err) {
              toastError(err);
              throw err;
            }
          }}
        />
      </div>
    </Dialog>
  );
}
