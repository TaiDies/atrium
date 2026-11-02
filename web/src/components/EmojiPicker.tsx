import { Shuffle, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type Anchor, Popover } from './ui';

const GROUPS: Record<string, string> = {
  Smileys: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😜 🤪 🤓 😎 🥳 🤔 🤗 😴 😮 😬 🙄 😤 😭 😱 🥶 🤯 😈 👻 🤖 👽 💩',
  People: '👋 👍 👎 👏 🙌 🙏 💪 🤝 ✌️ 🤞 👀 🧠 👶 🧑 👩 👨 🧑‍💻 👩‍🎨 🧑‍🏫 🧑‍🔬 🧑‍🚀 🦸 🧙 🕵️',
  Nature: '🐶 🐱 🦊 🐻 🐼 🐨 🦁 🐯 🐸 🐵 🐧 🐦 🦉 🐝 🦋 🐢 🐙 🐳 🌱 🌿 🍀 🌵 🌴 🌸 🌻 🌹 🍁 🌍 🌙 ⭐ 🌈 ☀️ ⚡ 🔥 💧 ❄️',
  Food: '🍎 🍊 🍋 🍉 🍇 🍓 🍒 🥑 🥕 🌽 🍞 🧀 🍕 🍔 🌮 🍣 🍜 🍩 🍪 🎂 🍫 ☕ 🍵 🍺 🍷',
  Activities: '⚽ 🏀 🏈 🎾 🏐 🎱 🏓 🥊 🎯 🎮 🎲 🧩 🎨 🎬 🎤 🎧 🎸 🎹 🏆 🥇 🎉 🎁 🎈',
  Travel: '🚗 🚕 🚌 🚲 🛵 🚀 ✈️ 🚁 ⛵ 🚢 🗺️ 🧭 🏔️ 🏕️ 🏖️ 🏝️ 🏠 🏢 🏰 🗽 🗼 🌉',
  Objects: '💡 📱 💻 🖥️ ⌨️ 🖱️ 📷 🎥 📺 ⏰ 🔋 🔌 💰 💳 💎 🔧 🔨 ⚙️ 🧰 🔑 🔒 📦 ✉️ 📮 📝 📄 📃 📑 📊 📈 📉 📋 📌 📎 📁 📂 🗂️ 📅 📆 🗓️ 📚 📖 🔖 🏷️ ✏️ 🖊️ 🖌️ 🔍 🧪 🔭',
  Symbols: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💯 ✅ ❌ ⚠️ ❓ ❗ 💬 💭 🔔 🎵 ➕ ➖ ✳️ 🔶 🔷 🔴 🟢 🔵 🟣 ⚫ ⚪ 🏁 🚩',
};

const ALL = Object.values(GROUPS).join(' ').split(' ');

export function randomEmoji() {
  return ALL[Math.floor(Math.random() * ALL.length)];
}

export function EmojiPicker({
  anchor,
  onClose,
  onPick,
  onRemove,
}: {
  anchor: Anchor | null;
  onClose: () => void;
  onPick: (emoji: string) => void;
  onRemove?: () => void;
}) {
  const [group, setGroup] = useState('Smileys');
  const emojis = useMemo(() => GROUPS[group].split(' '), [group]);
  const pick = (e: string) => {
    onPick(e);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} className="w-[328px] p-2">
      <div className="mb-2 flex items-center gap-1">
        <div className="flex flex-1 gap-0.5 overflow-x-auto">
          {Object.keys(GROUPS).map((g) => (
            <button
              key={g}
              onClick={() => setGroup(g)}
              title={g}
              className={`rounded-md px-1.5 py-1 text-base ${g === group ? 'bg-active' : 'hover:bg-hover'}`}
            >
              {GROUPS[g].split(' ')[0]}
            </button>
          ))}
        </div>
        <button title="Random" onClick={() => pick(randomEmoji())} className="rounded-md p-1.5 text-muted hover:bg-hover">
          <Shuffle size={15} />
        </button>
        {onRemove && (
          <button
            title="Remove icon"
            onClick={() => {
              onRemove();
              onClose();
            }}
            className="rounded-md p-1.5 text-muted hover:bg-hover"
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
      <div className="text-xs font-medium text-faint">{group}</div>
      <div className="mt-1 grid max-h-56 grid-cols-9 gap-0.5 overflow-y-auto">
        {emojis.map((e) => (
          <button key={e} onClick={() => pick(e)} className="flex size-8 items-center justify-center rounded-md text-xl hover:bg-hover">
            {e}
          </button>
        ))}
      </div>
    </Popover>
  );
}
