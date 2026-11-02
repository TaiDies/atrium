// Where Atrium lives on GitHub. Links marked data-repo-link point there; download buttons
// (data-release) go straight to the newest release's file.
const REPO = 'TaiDies/atrium';

for (const a of document.querySelectorAll('[data-repo-link]')) a.href = `https://github.com/${REPO}${a.dataset.suffix ?? ''}`;
for (const a of document.querySelectorAll('[data-release]')) a.href = `https://github.com/${REPO}/releases/latest/download/${a.dataset.release}`;
for (const el of document.querySelectorAll('[data-owner]')) el.textContent = REPO.split('/')[0];
