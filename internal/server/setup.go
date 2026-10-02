package server

import (
	"html"
	"strings"
)

var extensionPages = map[string]string{"chrome": "chrome://extensions", "edge": "edge://extensions", "brave": "brave://extensions", "chromium": "chrome://extensions"}

const setupTemplate = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Proxy App in this profile</title>
<style>
  :root { --bg:#f4f6f7; --card:#fff; --ink:#11171c; --ink2:#48535d; --ink3:#66717b; --line:rgba(15,23,30,.1); --sunken:#eef1f3; --fiber:#0b7d73; --fiber-ink:#fff; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1215; --card:#151a1e; --ink:#e6eaed; --ink2:#a4aeb7; --ink3:#808b95; --line:rgba(255,255,255,.08); --sunken:#0c0f12; --fiber:#35c6b8; --fiber-ink:#04211e; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  main { max-width:640px; margin:48px auto; padding:0 16px; }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:-.01em; }
  p.lead { color:var(--ink2); margin:0 0 28px; }
  ol { list-style:none; margin:0; padding:0; background:var(--card); border:1px solid var(--line); border-radius:10px; }
  li { display:flex; gap:14px; padding:18px 20px; border-top:1px solid var(--line); }
  li:first-child { border-top:0; }
  .n { flex:none; width:24px; height:24px; border-radius:50%; background:var(--sunken); color:var(--ink2); font-size:12px; font-weight:600; display:flex; align-items:center; justify-content:center; margin-top:1px; }
  .t { min-width:0; flex:1; }
  .t b { font-weight:600; }
  .hint { color:var(--ink3); font-size:13px; margin-top:6px; }
  .copy { display:flex; align-items:center; gap:8px; margin-top:10px; background:var(--sunken); border:1px solid var(--line); border-radius:6px; padding:6px 6px 6px 12px; }
  code { font:13px ui-monospace,"SF Mono",Menlo,Consolas,monospace; overflow-wrap:anywhere; flex:1; }
  button { flex:none; height:32px; padding:0 12px; border-radius:6px; border:0; background:var(--fiber); color:var(--fiber-ink); font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
  button:active { transform:scale(.97); }
  footer { color:var(--ink3); font-size:13px; margin-top:20px; }
</style></head>
<body><main>
  <h1>Use Proxy App in this profile</h1>
  <p class="lead">Takes a minute, once. Only this profile will use your proxy. Other profiles and apps keep your normal connection.</p>
  <ol>
    <li><span class="n">1</span><div class="t">Copy this, paste it in the address bar above, and press Enter.
      <div class="copy"><code>{{PAGE}}</code><button data-copy="{{PAGE}}">Copy</button></div></div></li>
    <li><span class="n">2</span><div class="t">Turn on <b>Developer mode</b> in the top-right corner of that page.</div></li>
    <li><span class="n">3</span><div class="t">Click <b>Load unpacked</b> and choose this folder:
      <div class="copy"><code>{{DIR}}</code><button data-copy="{{DIR}}">Copy</button></div>
      <div class="hint">{{HINT}}</div></div></li>
    <li><span class="n">4</span><div class="t">Click the puzzle icon in the toolbar and pin <b>Proxy App</b>. Click it to choose which IP this profile uses.</div></li>
  </ol>
  <footer>When Proxy App is off, this profile stops loading pages instead of showing your real IP. You can change that in the extension.</footer>
</main>
<script nonce="{{NONCE}}">
  for (const b of document.querySelectorAll('button[data-copy]')) {
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(b.dataset.copy);
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    });
  }
</script>
</body></html>`

// setupPage is opened inside the browser profile being set up, so the steps are where the user acts.
func setupPage(browser, extensionDir, nonce string, mac bool) string {
	page, found := extensionPages[browser]
	if !found {
		page = extensionPages["chrome"]
	}
	hint := "In the folder picker, paste the path into the address bar at the top, then click Select Folder."
	if mac {
		hint = "In the folder picker, press ⌘ ⇧ G, paste the path, then click Select."
	}
	return strings.NewReplacer(
		"{{PAGE}}", html.EscapeString(page),
		"{{DIR}}", html.EscapeString(extensionDir),
		"{{NONCE}}", nonce,
		"{{HINT}}", hint,
	).Replace(setupTemplate)
}
