// Where Atrium lives on GitHub. Links marked data-repo-link point there; download buttons
// (data-release) go straight to the newest release's file.
const REPO = 'TaiDies/atrium';

for (const a of document.querySelectorAll('[data-repo-link]')) a.href = `https://github.com/${REPO}${a.dataset.suffix ?? ''}`;
for (const a of document.querySelectorAll('[data-release]')) a.href = `https://github.com/${REPO}/releases/latest/download/${a.dataset.release}`;
for (const el of document.querySelectorAll('[data-owner]')) el.textContent = REPO.split('/')[0];

// "Notify me" for Atrium Cloud: stored privately by /api/subscribe.
const form = document.getElementById('signup');
if (form) {
  const msg = form.querySelector('.signup-msg');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    const say = (text, ok) => { msg.textContent = text; msg.className = `signup-msg ${ok ? 'ok' : 'err'}`; };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return say('Enter a valid email address.', false);
    if (!form.consent.checked) return say('Tick the box so we may email you.', false);
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const res = await fetch('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, consent: true, company: form.company.value, lang: navigator.language }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again later.');
      form.reset();
      say('Thanks — we’ll email you when Atrium Cloud opens.', true);
    } catch (err) {
      say(err.message, false);
    } finally {
      button.disabled = false;
    }
  });
}
