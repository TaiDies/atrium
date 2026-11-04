import { z } from 'zod';
import { query } from './db.js';

// Where each person stopped in a file, kept per person (not shared): the page of a PDF and how far
// down it, how far down a document, the slide of a presentation, or the time in a video or audio.

const fraction = z.number().min(0).max(1);
export const positionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('page'), page: z.number().int().min(1).max(100000), pages: z.number().int().min(1).max(100000), offset: fraction }),
  z.object({ kind: z.literal('scroll'), fraction }),
  z.object({ kind: z.literal('slide'), slide: z.number().int().min(1).max(100000), slides: z.number().int().min(1).max(100000) }),
  z.object({ kind: z.literal('time'), seconds: z.number().min(0).max(1e7), duration: z.number().min(0).max(1e7) }),
]);
export type FilePosition = z.infer<typeof positionSchema>;

export interface SavedPosition {
  position: FilePosition;
  updatedAt: string;
}

/** This person's place in each of these files. */
export async function positionsFor(userId: string, fileIds: string[]): Promise<Map<string, SavedPosition>> {
  if (!fileIds.length) return new Map();
  const rows = await query<{ file_id: string; position: FilePosition; updated_at: Date }>(
    'select file_id, position, updated_at from file_positions where user_id = $1 and file_id = any($2::uuid[])',
    [userId, fileIds],
  );
  return new Map(rows.map((r) => [r.file_id, { position: r.position, updatedAt: r.updated_at.toISOString() }]));
}

export async function savePosition(userId: string, fileId: string, position: FilePosition) {
  await query(
    `insert into file_positions (user_id, file_id, position) values ($1, $2, $3)
     on conflict (user_id, file_id) do update set position = excluded.position, updated_at = now()`,
    [userId, fileId, JSON.stringify(position)],
  );
}
