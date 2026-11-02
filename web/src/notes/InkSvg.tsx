import { HIGHLIGHTER_OPACITY, type InkItem, isText, strokePath, TEXT_FONT, TEXT_LINE_HEIGHT, type TextItem } from './ink';

/** The SVG for a page's handwriting, shapes and text (inside an <svg> whose viewBox is 1 unit wide). */
export function InkItems({ items, hiddenId }: { items: InkItem[]; hiddenId?: string | null }) {
  return (
    <>
      {items.map((item) =>
        item.id === hiddenId ? null : isText(item) ? (
          <InkText key={item.id} item={item} />
        ) : (
          <path
            key={item.id}
            d={strokePath(item)}
            fill="none"
            stroke={item.color}
            strokeWidth={item.width}
            strokeOpacity={item.tool === 'highlighter' ? HIGHLIGHTER_OPACITY : 1}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={item.tool === 'highlighter' ? 'ink-highlight' : undefined}
          />
        ),
      )}
    </>
  );
}

function InkText({ item }: { item: TextItem }) {
  const lines = item.text.split('\n');
  return (
    <text x={item.x} y={item.y} fill={item.color} fontSize={item.size} fontFamily={TEXT_FONT} style={{ whiteSpace: 'pre' }}>
      {lines.map((line, i) => (
        // The first line's baseline sits so its top lines up with y, matching the box used while typing.
        <tspan key={i} x={item.x} dy={i === 0 ? item.size * ((TEXT_LINE_HEIGHT - 1) / 2 + 0.8) : item.size * TEXT_LINE_HEIGHT}>
          {line || ' '}
        </tspan>
      ))}
    </text>
  );
}
