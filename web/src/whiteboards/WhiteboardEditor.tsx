import { CaptureUpdateAction, Excalidraw, reconcileElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFileData, BinaryFiles, Collaborator, ExcalidrawImperativeAPI, SocketId } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { uploadFile, type User } from '../lib/api';
import type { CollabSession } from '../lib/collab';
import { useTheme } from '../lib/theme';
import type { BoardFile } from './api';
import '@excalidraw/excalidraw/index.css';

// Live multiplayer whiteboards: every element lives in the board's Yjs document (`elements`, keyed by
// id), so edits from everyone merge; images are uploaded to the workspace and listed in `files`; and
// each person's cursor, selection and view travel through awareness so others can see and follow them.

const LOCAL = 'excalidraw-local';
const LIBRARY_KEY = 'atrium-whiteboard-library';

type SceneElement = OrderedExcalidrawElement;

function sortByIndex(elements: SceneElement[]) {
  return [...elements].sort((a, b) => (a.index && b.index ? (a.index < b.index ? -1 : a.index > b.index ? 1 : 0) : 0) || (a.id < b.id ? -1 : 1));
}

function readElements(map: Y.Map<SceneElement>) {
  return sortByIndex([...map.values()].filter((e) => e && typeof e === 'object' && 'id' in e));
}

async function toDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dataURLToBlob(dataURL: string, mimeType: string) {
  const [, b64] = dataURL.split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

interface Presence {
  user?: { name: string; color: string; id?: string };
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' };
  button?: 'up' | 'down';
  selectedElementIds?: Record<string, true>;
  view?: { scrollX: number; scrollY: number; zoom: number };
}

export function WhiteboardEditor({
  session,
  user,
  workspaceId,
  viewMode = false,
  grid = false,
  theme,
}: {
  session: CollabSession;
  user: User;
  workspaceId: string;
  viewMode?: boolean;
  /** Show the snapping grid. */
  grid?: boolean;
  /** Light or dark canvas; defaults to the app's own mode. */
  theme?: 'light' | 'dark';
}) {
  const { resolved } = useTheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const elements = useMemo(() => session.doc.getMap<SceneElement>('elements'), [session]);
  const files = useMemo(() => session.doc.getMap<BoardFile>('files'), [session]);
  const sent = useRef(new Map<string, number>()); // element id → version last written to the doc
  const uploading = useRef(new Set<string>());
  const followed = useRef<number | null>(null);
  const initial = useMemo(() => {
    const els = readElements(elements);
    for (const e of els) sent.current.set(e.id, e.version);
    let libraryItems = [];
    try {
      libraryItems = JSON.parse(localStorage.getItem(LIBRARY_KEY) ?? '[]');
    } catch {}
    return { elements: els, appState: { viewModeEnabled: viewMode }, libraryItems, scrollToContent: true };
  }, [elements, viewMode]);

  // Development only: lets the browser console drive the board (used for testing multiplayer sync).
  useEffect(() => {
    if (import.meta.env.DEV && api) (window as unknown as { __whiteboard?: ExcalidrawImperativeAPI }).__whiteboard = api;
  }, [api]);

  // Remote changes → the canvas (merged with whatever is being edited locally right now).
  useEffect(() => {
    if (!api) return;
    const apply = (event: Y.YMapEvent<SceneElement>, tx: Y.Transaction) => {
      if (tx.origin === LOCAL) return;
      const remote: SceneElement[] = [];
      for (const key of event.keysChanged) {
        const el = elements.get(key);
        if (el) {
          remote.push(el);
          sent.current.set(el.id, el.version);
        }
      }
      if (!remote.length) return;
      const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), remote as never, api.getAppState());
      api.updateScene({ elements: sortByIndex(merged as SceneElement[]), captureUpdate: CaptureUpdateAction.NEVER });
    };
    elements.observe(apply);
    return () => elements.unobserve(apply);
  }, [api, elements]);

  // Images other people added: fetch each once and hand it to the canvas.
  useEffect(() => {
    if (!api) return;
    const load = async () => {
      const have = api.getFiles();
      const missing = [...files.values()].filter((f) => f && !have[f.id]);
      const loaded: BinaryFileData[] = [];
      for (const f of missing) {
        try {
          const blob = await (await fetch(f.url, { credentials: 'same-origin' })).blob();
          loaded.push({ id: f.id as BinaryFileData['id'], mimeType: f.mimeType as BinaryFileData['mimeType'], dataURL: (await toDataURL(blob)) as BinaryFileData['dataURL'], created: f.created });
        } catch {
          // The image was deleted; the element shows a placeholder.
        }
      }
      if (loaded.length) api.addFiles(loaded);
    };
    load();
    files.observe(load);
    return () => files.unobserve(load);
  }, [api, files]);

  // Other people's cursors and selections, and following someone's view.
  useEffect(() => {
    const awareness = session.provider.awareness;
    if (!api || !awareness) return;
    const update = () => {
      const collaborators = new Map<SocketId, Collaborator>();
      awareness.getStates().forEach((raw, clientId) => {
        if (clientId === awareness.clientID) return;
        const s = raw as Presence;
        if (!s.user) return;
        collaborators.set(String(clientId) as SocketId, {
          id: String(clientId),
          socketId: String(clientId) as SocketId,
          username: s.user.name,
          color: { background: s.user.color, stroke: s.user.color },
          pointer: s.pointer,
          button: s.button,
          selectedElementIds: s.selectedElementIds as AppState['selectedElementIds'],
        });
        if (followed.current === clientId && s.view) {
          api.updateScene({ appState: { scrollX: s.view.scrollX, scrollY: s.view.scrollY, zoom: { value: s.view.zoom as AppState['zoom']['value'] } }, captureUpdate: CaptureUpdateAction.NEVER });
        }
      });
      api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
    };
    awareness.setLocalStateField('user', { name: user.name, color: user.color, id: user.id });
    awareness.on('change', update);
    update();
    const unfollow = api.onUserFollow((payload) => {
      followed.current = payload.action === 'FOLLOW' ? Number(payload.userToFollow.socketId) : null;
    });
    return () => {
      awareness.off('change', update);
      unfollow();
    };
  }, [api, session, user]);

  /** Local edits → the doc: only elements whose version moved on since they were last synced. */
  const onChange = useCallback(
    (scene: readonly ExcalidrawElement[], appState: AppState, binaryFiles: BinaryFiles) => {
      const changed = (scene as SceneElement[]).filter((e) => (sent.current.get(e.id) ?? -1) < e.version);
      if (changed.length) {
        session.doc.transact(() => {
          for (const e of changed) {
            const prev = elements.get(e.id);
            if (prev && prev.version >= e.version) continue;
            elements.set(e.id, JSON.parse(JSON.stringify(e)));
            sent.current.set(e.id, e.version);
          }
        }, LOCAL);
      }
      // New images: upload them to the workspace so the doc stays small.
      for (const f of Object.values(binaryFiles)) {
        if (files.has(f.id) || uploading.current.has(f.id)) continue;
        uploading.current.add(f.id);
        const ext = f.mimeType.split('/')[1]?.replace('svg+xml', 'svg') ?? 'png';
        uploadFile(workspaceId, new File([dataURLToBlob(f.dataURL, f.mimeType)], `whiteboard-image.${ext}`, { type: f.mimeType }))
          .then((url) => session.doc.transact(() => files.set(f.id, { id: f.id, mimeType: f.mimeType, url, created: f.created ?? Date.now() }), LOCAL))
          .catch(() => uploading.current.delete(f.id));
      }
      const awareness = session.provider.awareness;
      const selected = appState.selectedElementIds;
      if (awareness && JSON.stringify((awareness.getLocalState() as Presence | null)?.selectedElementIds ?? {}) !== JSON.stringify(selected)) {
        awareness.setLocalStateField('selectedElementIds', selected);
      }
    },
    [elements, files, session, workspaceId],
  );

  const lastPointer = useRef(0);
  return (
    <div className="excalidraw-host size-full">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initial}
        onChange={onChange}
        theme={theme ?? resolved}
        gridModeEnabled={grid}
        isCollaborating
        viewModeEnabled={viewMode}
        onPointerUpdate={({ pointer, button }) => {
          const now = performance.now();
          if (now - lastPointer.current < 40) return; // about 25 updates a second is plenty
          lastPointer.current = now;
          session.provider.awareness?.setLocalStateField('pointer', pointer);
          session.provider.awareness?.setLocalStateField('button', button);
        }}
        onScrollChange={(scrollX, scrollY, zoom) => session.provider.awareness?.setLocalStateField('view', { scrollX, scrollY, zoom: zoom.value })}
        onLibraryChange={(items) => {
          try {
            localStorage.setItem(LIBRARY_KEY, JSON.stringify(items));
          } catch {}
        }}
        UIOptions={{ canvasActions: { loadScene: true, saveToActiveFile: false, export: { saveFileToDisk: true }, toggleTheme: false } }}
      />
    </div>
  );
}
