# WatchTogether

Watch a video in sync with a friend — on almost any site that plays video in an
HTML5 `<video>` element — without a paid server, an account, or a fixed list
of supported sites. Peer-to-peer over WebRTC, with a text chat, emoji
reactions, a synchronized "ready check" countdown, and optional voice chat.

**Netflix is out of scope.** On netflix.com the extension shows a small
banner and doesn't try to sync — use [Teleparty](https://www.teleparty.com/)
for that.

---

## 1. Install it (Chrome or Brave)

You'll need a reasonably recent browser — Chrome or Brave **116+** (check
`chrome://version` / `brave://version`) — for the Manifest V3 APIs this
relies on (offscreen documents, the side panel, cross-origin iframe
injection).

This extension isn't on the Chrome Web Store — you load it as an "unpacked"
extension, which just means pointing the browser at this folder.

1. Open `chrome://extensions` (Chrome) or `brave://extensions` (Brave).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this folder (the one with `manifest.json` in it — i.e.
   `Watch Together/`, not a subfolder).
5. You should see **WatchTogether** appear in your extensions list, with a
   purple/teal icon. Pin it to your toolbar if you'd like (click the puzzle
   piece icon, then the pin next to WatchTogether).

Repeat on both browsers/profiles you want to test with. There's nothing to
build — it's plain JavaScript, loaded as-is.

---

## 2. Start or join a party

1. Go to a page with a video (see [Testing](#4-testing) below for ready-made
   test pages, or just open a YouTube video).
2. Click the WatchTogether icon in your toolbar. This opens the **popup**.
3. Set your display name and a one-emoji avatar (remembered for next time).
4. Click **Start party**. You'll get a short room code like
   `bright-panda-42` — click **Copy** and send it to your partner (text,
   Slack, whatever).
5. Your partner opens the *same video page* (or clicks "Open the same page"
   once connected, if they're a step behind), clicks the WatchTogether icon,
   enters the room code under **Join**, and clicks **Join**.
6. Once connected, play/pause/seek on either side mirrors to the other.

**Chat and reactions** live in the Chrome **side panel**, not the popup.
Click the side-panel icon in your toolbar (a separate icon from extensions —
look for a panel/layout icon near the address bar) and choose **WatchTogether**
from the list. The reaction bar at the bottom of the panel is customizable:
drag emoji to reorder, click **✎** then the **×** on an emoji to remove it,
or click **+** to open a full searchable emoji picker (with a "Recent" row
and a pin button on each emoji to add it to your bar). The same picker is
used to insert emoji into chat messages (🙂 button next to the message box).

**Fullscreen:** the side panel disappears in fullscreen, so a small bar
appears in the **bottom-right corner** (deliberately not bottom-center,
where subtitles usually render) with your reaction bar, recent emoji, and a
quick message box. Click the **—** in its corner to minimize it to a small
💬 button if it's ever in your way — click that to bring it back. Reactions
always float up over the video either way, regardless of whether the bar is
open or minimized.

**If the host switches to a different "server"/player** on a site with
multiple embed options, your partner gets a one-click "switch too" prompt
that tries to follow automatically.

**If the extension picks the wrong video** (some pages have more than one),
click "Pick a different video" in the small status badge (bottom-right of
the page) to highlight every candidate and choose.

**Connection quality:** once connected, the status line (popup, side panel,
and the on-page status badge) shows a live estimate next to your partner's
name, e.g. "🟢 Connected with Ama · 🟢 42ms" — green/yellow/red for
excellent/fair/poor, based on the same round-trip estimate the drift
correction already uses internally.

**When someone leaves:** closing the party tab, clicking **Leave party**, or
your partner doing either now shows an explicit message — "Your partner
ended the party" (not a vague "disconnected, trying to reconnect" that
wasn't actually retrying anything). If your connection drops unexpectedly
rather than through an explicit leave, the joiner side now does actually
retry for about 15 seconds before giving up and showing "Couldn't reconnect
— the party may have ended."

### Ready check

Click **⏱ Ready check** (in the side panel's tools row, or in the fullscreen
bar) to kick off a synchronized "3, 2, 1, Go" countdown on both screens —
useful for a clean, deliberate start instead of just mashing play. Either
side can cancel it mid-countdown. It's a visual/timing feature only — the
actual play trigger when it hits zero goes through the normal sync pipeline
(echo suppression, drift correction, all of it), so it's exactly as reliable
as a regular play/pause action.

### Voice chat

Click **🎙️ Join voice** (side panel or fullscreen bar) to start a voice call
with your partner alongside the video — your own audio stream is sent
directly to them over the same peer-to-peer connection (not relayed through
any server). Click the mic button to mute/unmute; a small colored ring
appears around a speaking partner's avatar in the side panel's voice roster.
Click **🔴 Leave voice** to hang up (this also releases the microphone).

**The first time** you join voice, a new tab opens asking Chrome to grant
WatchTogether microphone access — click **Allow microphone access** there
(this is a one-time grant; the tab closes itself once approved). If you
don't see a prompt, check your address bar for a blocked-permission icon.
Voice chat is currently scoped to the direct pair (host ↔ one joiner) rather
than full group audio — see [Known limitations](#7-known-limitations).

**Choosing a microphone or speaker:** click the **⚙** button next to the
voice controls in the side panel to pick a specific input (microphone) and
output (speaker/headphones) device. A microphone change takes effect the
next time you join voice; a speaker change applies immediately, even
mid-call. If your browser doesn't support in-page output switching (see the
note that appears in that panel if so), speaker selection falls back to
your OS's own default output device — on a Mac that's **System Settings
→ Sound** (older macOS: **System Preferences → Sound**), **Input** and
**Output** tabs; on Windows it's the speaker icon in the taskbar. Either
way, the in-extension picker is the more reliable option since it doesn't
depend on your OS's default changing mid-session.

---

## 3. Permissions, explained

| Permission | Why |
|---|---|
| `storage` | Saves your display name/avatar, reaction bar, recently-used emoji, and settings locally (`chrome.storage.sync`/`.session`). Nothing is sent anywhere except directly to your partner. |
| `offscreen` | MV3 service workers can't hold a WebRTC connection, so the actual peer connection lives in an invisible offscreen document. |
| `sidePanel` | Hosts the chat/reactions panel. |
| `tabs` | Lets the extension know which tab you started/joined a party from, relay messages to the right frame inside it, and open the one-time microphone-permission tab for voice chat. |
| `host_permissions: <all_urls>` | The extension needs to inject its video-detection script into *any* site (and the cross-origin iframes many video players use) — there's no fixed site list. It never reads page content beyond looking for `<video>` elements and basic iframe geometry. |

Microphone access for voice chat isn't a manifest permission at all — it's
the standard browser-level permission prompt, granted once to the
extension's own page (not to whatever website you're watching on) the first
time you join voice.

There is no analytics, no account, and no data sent anywhere except (a) the
free PeerJS signaling server, used only to establish the initial connection
to your partner, and (b) the direct WebRTC connection to your partner once
connected. Chat is never stored anywhere and disappears when the party ends.

---

## 4. Testing

### Without any site at all

Two local test pages are included, served over a tiny local HTTP server
(not `file://`, so the cross-origin iframe case is a *real* cross-origin
iframe, not a same-origin one with different URLs):

```bash
cd "test"
python3 -m http.server 8787
```

In a second terminal:

```bash
cd "test/iframe-player"
python3 -m http.server 8788
```

Then open:
- `http://localhost:8787/plain-video.html` — a plain top-level `<video>`.
- `http://localhost:8787/iframe-host/index.html` — a video inside an
  `<iframe>` served from port 8788, i.e. a genuinely different origin, just
  like a real third-party embedded player.

Both pages use small public-domain sample videos — you'll need an internet
connection for the video itself to load (just the pages are local).

### Testing sync with yourself, on one computer

The easiest way: two Chrome **profiles** (or Chrome + Brave), each with the
extension loaded separately.

1. Create a second Chrome profile (top-right avatar menu → Add profile), or
   just use Brave as the second browser.
2. Load the extension unpacked in both (step 1 above).
3. Open one of the test pages above in **both** windows.
4. In window A: start a party, copy the code.
5. In window B: join with that code.
6. Play/pause/seek in A, watch B follow (and vice versa). Try the reaction
   bar and chat in the side panel, and try fullscreen in both.

### Real-world test: YouTube

Open the same YouTube video in both windows, start/join a party, and try
play/pause/seek/rate changes. YouTube's player is a single top-level
`<video>` element, so this is the simplest real-site case; try a site with
an embedded third-party player (the kind with a row of "server" buttons) to
exercise the cross-origin-iframe and player-switch logic.

---

## 5. Optional: a custom TURN server

WebRTC usually connects directly peer-to-peer using STUN (included, no
setup needed). On some mobile/carrier or restrictive office networks, a
direct connection isn't possible and you need a **TURN** relay server. If
sync just won't connect for someone on such a network, add a TURN server in
the popup's **Advanced settings**:

- **Free/shared test option:** the [Open Relay Project](https://www.metered.ca/tools/openrelay/)
  publishes a public demo TURN server for exactly this kind of testing:
  URL `turn:openrelay.metered.ca:80`, username `openrelayproject`,
  credential `openrelayproject`. It's shared and best-effort (no uptime
  guarantee) — fine for trying things out, not for relying on long-term.
- **Your own free tier:** services like [metered.ca](https://www.metered.ca/)
  or [Twilio](https://www.twilio.com/) offer TURN with a free tier/trial —
  sign up and paste the URL/username/credential they give you into the
  settings above.
- **Self-hosted:** running your own [coturn](https://github.com/coturn/coturn)
  server on a cheap VPS also works and is free beyond hosting costs.

---

## 6. How it's built (for the curious)

- **PeerJS**, bundled locally (`lib/peerjs.min.js`, vendored from npm — MV3
  doesn't allow loading remote code), handles the WebRTC data channel over
  the free public PeerJS signaling server.
- The peer connection lives in an **offscreen document**
  (`offscreen/offscreen.html` + `.js`), because MV3 service workers can't
  hold WebRTC connections.
- The **service worker** (`background/service-worker.js`) is the hub: it
  relays between content script frames, the offscreen document, and the
  popup/side panel, and tracks which frame currently "owns" the video.
- **Content scripts** run in every frame (`all_frames: true`,
  `match_about_blank: true`, `match_origin_as_fallback: true`), including
  nested cross-origin iframes, because that's exactly where many real
  players' video elements live. `content/video-detector.js` finds and
  scores candidate `<video>` elements (including inside open shadow roots);
  `content/sync.js` drives play/pause/seek/rate sync with echo suppression
  and heartbeat-based drift correction; `content/overlay.js` draws the
  on-page status badge, banners, floating reactions, and fullscreen bar.
- A **host-centric star topology** is in place for small groups (~6): the
  host is the only peer everyone else connects to, and relays messages
  between joiners. The 2-person case is the one that's been exercised most.

---

## 7. Known limitations

- **Netflix is explicitly excluded** — use Teleparty for that.
- **DRM-protected video** (most paid streaming beyond the above) often
  renders inside browser-protected surfaces the extension can't see into,
  or blocks the kind of detection this relies on.
- **Desktop apps** (not browser tabs) aren't reachable by a browser
  extension at all.
- **Mobile browsers** mostly don't support extensions, so this is a
  desktop-browser tool.
- Video elements inside **closed shadow roots** can't be detected (open
  shadow roots are supported).
- The "switch to the same player" feature is a best-effort heuristic based
  on watching for large iframe `src` changes — it won't catch every site's
  way of switching servers, and reassigning a cross-origin iframe's `src`
  can be blocked by that site's own embedding rules (in which case it falls
  back to opening the link in a new tab).
- In a >2-person party (star topology), everyone sees the host's video sync,
  chat, and reactions, but each joiner's own "who's connected" roster only
  shows the host directly, not the other joiners.
- If your browser fully kills the extension's background service worker at
  an unlucky moment, reconnection is generally automatic since the actual
  WebRTC connection lives in the offscreen document, not the service
  worker — but in rare cases a page refresh is the quickest fix.
- **Voice chat is pair-only**, not full group audio — in a >2-person party,
  the host can voice chat with each joiner individually, but joiners don't
  hear each other's voice (consistent with the chat-roster limitation
  above). The "speaking" indicator is a nice-to-have based on local volume
  analysis of the incoming audio; if it ever misbehaves, the call itself is
  unaffected — it's purely visual.
- The microphone-permission tab (voice chat's first-time setup) hasn't been
  exercised against every Chrome/Brave version's exact permission-prompt
  behavior — if "Join voice" seems stuck on "Connecting…" after allowing
  the prompt, try clicking **Join voice** again once.
- **Output device (speaker) switching** uses the browser's `setSinkId()`
  API, whose support has varied across Chrome/Brave versions and platforms.
  The device panel detects support and shows a note if it's unavailable,
  falling back cleanly to your OS's default output — but this hasn't been
  verified across every version, so if the speaker dropdown doesn't seem to
  do anything, that's the likely cause, not a sign something else broke.
