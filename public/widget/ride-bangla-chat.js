/**
 * Ride Bangla AI Agent - Live Chat Widget
 * CANONICAL EMBED — v2026-10-29 (male voice fallback removed
 * 2026-10-29: owner rule — the whole voice is female, no male
 * voice ever. The picker's pass 3 (an identifiably-male voice
 * at pitch 1.25 as a last resort) is removed entirely, and the
 * browser default is never left to speak either: when no
 * female-named or unlabelled voice exists for the reply's
 * language, the widget does NOT speak and shows the
 * voice-unavailable system note instead (the text reply stays
 * readable). Pass 1 (identifiable female, pitch 1.0) and pass 2
 * (unlabelled same-language voice, pitch 1.1) are unchanged.
 * Prompt hardening in the same batch (engine.ts, not this
 * file): the whole reply must be in the reply language and
 * knowledge facts must be translated, never quoted verbatim.)
 * Prior: v2026-10-23.3 (quota polling diet
 * 2026-10-23: the thread sync no longer polls at a fixed 4 s for as
 * long as the panel is open. It syncs immediately on open, then
 * backs off while nothing new arrives (5 s → 8 s → … → 30 s cap),
 * resets to fast cadence the moment a new remote message lands or
 * a local turn settles, and pauses entirely while the tab is
 * hidden (an immediate sync runs on return to visible). The
 * activity poll (only ever while a turn is in flight) relaxes
 * 1.2 s → 2 s; server-side each poll is now a cached siteKey
 * resolution + a single conversation doc read. The SEND path is
 * untouched: the visitor's message, the typing indicator and
 * typing-until-first-token behave exactly as before.)
 * Prior: v2026-10-23.2 (draggable launcher
 * 2026-10-23: the floating bubble can be MOVED BY HAND — the
 * owner ordered it because the bubble often covers a page's
 * bottom submit button and could not be moved out of the way.
 * Pointer-events drag (touch + mouse) on the launcher; a tap
 * still opens the panel (movement threshold separates tap from
 * drag, and the click a real drag produces is swallowed). The
 * dragged position persists for the session (sessionStorage)
 * and is clamped inside the viewport on drag, restore and
 * resize/orientation change. When the panel opens from a moved
 * position it anchors to the bubble: it opens below the bubble
 * when there is no room above, and the whole open widget is
 * shift-clamped fully on-screen. touch-action:none on the
 * launcher keeps the host page from scroll-janking mid-drag.
 * Inline mode never drags. Voice, videos and composer
 * behaviour unchanged.)
 * Prior: v2026-10-23.1 (female-voice hardening
 * 2026-10-23: the read-aloud voice is ALWAYS female (owner
 * correction — সবসময়ই মেয়ে কন্ঠে). The picker no longer
 * falls back to the browser's language default (male or robotic
 * on many devices): pass 1 identifiable female at pitch 1.0;
 * pass 2 first not-identifiably-male voice for the language at
 * raised pitch 1.1; pass 3 (last resort) an identifiable-male
 * voice only at pitch 1.25; an empty voice list gets ONE short
 * (<=350ms) retry, then speaks with lang + pitch 1.1. Female /
 * male name lists extended from platform voice catalogues.
 * Tap-to-speak only, click-again-to-stop, sentence queueing and
 * every other behaviour unchanged.)
 * Prior: v2026-10-22.11 (composer fix
 * 2026-10-22: the empty message box could open as a HUGE tall
 * slab (owner screenshot, Tools site). Root causes, all in the
 * composer: (1) NO sizing ever ran on panel open, so whatever
 * height the box happened to carry is what greeted the visitor;
 * (2) autoGrowInput derived the EMPTY height from scrollHeight,
 * but for an empty textarea scrollHeight reports the
 * PLACEHOLDER's height — and the placeholder wraps at phone
 * widths (measured in Chromium at a 390px viewport: empty
 * scrollHeight 61px vs the true one-line 40px at the widget's
 * ~141px composer width; it grows with every extra wrapped
 * placeholder line), so send/clear "resets" landed inflated;
 * (3) the textarea CSS declared no height at all, leaving the
 * rest size unowned. Fix: the CSS now pins the one-line rest
 * height, the empty case sizes from the box's own line metrics
 * (never placeholder scrollHeight), and every panel open runs
 * a slim reset — a preserved draft keeps its TEXT but reopens
 * slim, scrolling inside the one-line box until the next input
 * event re-grows it. Growth, the ~45% cap, internal scroll,
 * Enter/Shift+Enter and the send reset are otherwise unchanged.)
 * Prior: v2026-10-22.10 (voice + video round
 * 2026-10-22: (A) FEMALE VOICE — spoken replies now pick a
 * known female voice for the reply's language from the
 * browser's voice list (cached, refreshed on voiceschanged
 * and at every speak; graceful fallback to the language
 * default when no female voice exists on the device).
 * (B) WORKING VIDEO — the owner's new typing clip replaces
 * the working default, and the 90s working watchdog is
 * progress-aware: it force-settles only after 90s with NO
 * sign of life (token / retract / live server activity), so
 * genuinely long turns (multi-round tools, media analysis)
 * keep the working mascot until their terminal done.
 * (C) COMPLETION VIDEO — a third mascot state: a short
 * completion clip (new default /agent-done.mp4, brand field
 * completionVideoUrl) plays exactly ONCE after a successful
 * turn, then settles to idle; error terminals go straight
 * to idle. (D) MIC DEDUPE — the same system notice renders
 * at most once per conversation; distinct notices unaffected.)
 * Prior: v2026-10-22.9 (owner report 2026-10-22,
 * Help Center inline box: ONE TYPING STATE — the status strip no
 * longer repeats the typing bubble's generic "typing" caption:
 * while a typing bubble is in the thread, the strip stays hidden
 * until the server reports a SPECIFIC activity (whose caption
 * says something the bubble does not); the bubble alone is the
 * turn's typing indicator and it is now animated (rbai-pulse)
 * instead of a frozen label. The strip also re-renders the
 * moment a typing bubble is removed mid-turn, so the working
 * state is never left unshown while a request is in flight.)
 * Prior: v2026-10-22.8 (re-audit #2, owner directive
 * 2026-10-22: COMPOSE AUTO-GROW — the message box is now a
 * textarea that grows with its content up to ~45% of the panel
 * height (then scrolls internally) and resets to one line the
 * moment a message is sent; Enter still sends, Shift+Enter
 * inserts a newline; the message list is untouched). Prior:
 * v2026-10-22.7 (owner reports
 * 2026-10-22: (1) TYPING LAW — the typing bubble now exists ONLY
 * before the first token of a turn: the stream 'retract' handler
 * no longer re-adds it after tokens were shown (the post-reply
 * "typing" echo the owner called unprofessional); the mascot
 * working state still covers genuine in-flight work. (2) VOICE
 * INPUT — a Permissions API pre-flight runs before getUserMedia:
 * an already-denied microphone (browser policy or a prior denial,
 * which never shows a prompt) now renders a brief SYSTEM NOTICE
 * explaining the block instead of a fake agent reply, and every
 * mic/recording error renders as that subtle notice rather than
 * a bot message. (3) VOICE PLAYBACK — every agent reply carries
 * a small speaker control that reads the reply aloud in the
 * reply's own language via the browser's speech synthesis (no
 * autoplay; click again stops; a new playback stops the old;
 * hidden where speech is unavailable)). Prior:
 * v2026-10-22.6 (owner correction 2026-10-22:
 * the v.5 whole-figure IDLE framing read TOO BIG in the front
 * slots — the idle/front clip is a SMALL CHEST-UP bust again,
 * the pre-v.5 presentation the owner liked (band y 64-544);
 * the WORKING clip's full-scene framing (robot + laptop) and
 * the always-alive playback are exactly as v.5). Prior:
 * v2026-10-22.5 (NEW: full-scene mascot framing
 * (owner directive 2026-10-22: the scene must READ — the working
 * clip is now framed so the robot AND its laptop are both inside
 * the circular slots, and the idle clip shows the full standing
 * figure; the old bust-centred cover crop centred the face and
 * cut the laptop, the whole point of the working scene, out of
 * the frame) + always-alive playback (the active clip can no
 * longer settle into a frozen frame or a permanent still: an
 * 'ended' active clip replays at once, a 4s watchdog re-plays a
 * paused active clip, a wrap scrolling back on-screen re-kicks
 * via IntersectionObserver, a back/forward-cache restore
 * re-kicks on pageshow, and a wrap that fell back to the still
 * image retries its video at most once a minute until it
 * recovers). Prior: v2026-10-22.4 (playback self-healing for real
 * mobile browsers — the active clip is re-kicked on its canplay event
 * (some Android browsers/WebViews silently drop a play() issued before
 * the clip has data), a clip whose load errors gets ONE reload-and-retry
 * before the still-image fallback (a transient network error must not
 * freeze the mascot into a static image for the whole session), and the
 * active clips are re-kicked ~1.2s and ~4s after mount. Prior:
 * v2026-10-22.3 (agent-brand wiring — the three agent
 * character URLs now resolve at init from the platform's public
 * GET /api/widget/brand record (Firestore agent_brand/current, Admin SDK,
 * ~60s server cache) with a 2.5s fail-soft timeout; when it answers, the URLs
 * re-resolve with a ?v=<version> cache-buster and the live launcher/header
 * markup is swapped in place, while the hardcoded platform defaults stay the
 * fallback so a dead record or endpoint changes NOTHING. Prior:
 * v2026-10-22.2 (NEW: the mascot still/poster is
 * now a TRUE BUST ASSET — agent-avatar.png itself is the
 * head+shoulders crop of the mascot artwork (owner reference
 * framing: figure x 4.5-94% / y 4-100% of the square), so the
 * fallback <img> is plain cover again and the v2026-10-22.1 CSS
 * crop is gone; dual-video state machine hardened — every idle
 * clip gets an explicit muted play() kick at init (not just the
 * hidden header one), the active clip is re-kicked after
 * inline/SPA remounts, on visibility return and on user gestures,
 * the working clips carry the bust poster so a switch never
 * flashes a blank circle, repeat "working" calls no longer reset
 * the working clip, a 90s watchdog force-settles a hung request
 * back to idle, and video uploads show the working state during
 * client-side frame extraction too. Prior: v2026-10-22.1 (every widget chrome string is
 * localized EN/BN through one UI_STRINGS table — mic/media/connection/
 * paused/typing strings, input chrome, product-card labels — and the
 * UI language FOLLOWS THE CONVERSATION: it starts from the existing
 * config.lang (data-lang, then the host page's lang) and switches when
 * the visitor's own message or the agent's reply is Bengali or English,
 * so a Bengali conversation never shows English chrome (owner rule:
 * bidirectional language purity). Server `error` texts are mapped to
 * localized strings in the embed and never rendered raw. Mic failures
 * are split by DOMException name (denied / no device / busy) instead of
 * one generic bubble. Mascot: the still fallback/poster avatar is now
 * bust-framed via a CSS crop of the then full-body still —
 * superseded in v2026-10-22.2 by the true bust asset) and the working clip's
 * object-position is re-centred on the mascot's head; launcher (56px)
 * and header (36px) sizes unchanged). Prior: v2026-10-21.3 (token
 * streaming for text chat — sendText asks the widget endpoint for an
 * SSE stream, the typing bubble only covers the wait for the first
 * token, the terminal `done` event carries the authoritative payload;
 * inline mount mode for help-center pages — #rbai-chat-inline /
 * data-mode="inline", launcher suppressed in inline mode; duplicate-
 * reply guard — the thread poll defers assistant messages while a
 * local request is in flight). Prior: v2026-10-21.2 (same-thread human
 * handoff — visitor/conversation ids persist in sessionStorage and the
 * embed polls GET /api/chat/thread while open). Prior: v2026-10-21.1
 * (dual-video avatar with the owner's canonical full-scene clips,
 * working clip lazy-loads on first open; live activity captions fed by
 * GET /api/chat/activity). Prior: v2026-10-20.2 (A-to-Z audit: CORS
 * companion fix + honest error states). This is the ONE embed build
 * every project reuses for the company help center; do not fork
 * per-site copies.
 * Embeddable chat widget for customer websites.
 *
 * Usage:
 * <script src="https://your-rbai-instance.com/widget/ride-bangla-chat.js"
 *   data-server="https://your-rbai-instance.com"
 *   data-site-key="YOUR_SITE_KEY"
 *   data-visitor-id="UNIQUE_VISITOR_ID"
 *   data-color="#0B7A55"
 *   data-position="right"
 *   data-greeting="Hi! How can we help you today?"
 * ></script>
 *
 * Inline mode (help-center pages; inline support added after
 * v2026-10-21.3 and carried by the v2026-10-22.1 bump): if the page
 * renders an element with
 * id "rbai-chat-inline", the widget mounts INTO that element as an
 * always-open in-page chat box instead of the floating bubble (the
 * launcher is suppressed on that page only). A script tag may instead
 * pass data-mode="inline" with optional data-inline-target="<css
 * selector>" (default "#rbai-chat-inline"). Same widget, same
 * conversation API and session identity; if no mount element is
 * found, the widget falls back to the floating bubble.
 *
 * The backend resolves the business (tenant) from the `siteKey`.
 * `visitorId` lets the agent keep one conversation per visitor.
 *
 * Phase 3 features:
 * - Product cards: the API may return `products[]`; they render as rich
 *   cards (photo, name, price, description) with an Order button that
 *   starts the order flow in chat.
 * - Photo / video upload -> POST /api/chat/vision (vision description +
 *   catalog matching, graceful when the AI brain is offline).
 * - Voice messages -> POST /api/chat/voice (Whisper transcription fed into
 *   the chat pipeline, graceful when offline).
 * - Subscription paused (HTTP 402 {error:'subscription_paused'}): a
 *   dedicated paused state — no AI reply, inputs disabled until retry.
 * - Human takeover: when the owner switches the AI off, the API returns
 *   {silent:true} and the widget renders nothing (pure silence).
 */
(function () {
  "use strict";

  var script = document.currentScript;
  var config = {
    server: script.getAttribute("data-server") || window.location.origin,
    siteKey: script.getAttribute("data-site-key") || "",
    visitorId: script.getAttribute("data-visitor-id") || "",
    color: script.getAttribute("data-color") || "#0B7A55",
    position: script.getAttribute("data-position") || "right",
    mode: script.getAttribute("data-mode") || "",
    inlineTarget: script.getAttribute("data-inline-target") || "#rbai-chat-inline",
    greeting: script.getAttribute("data-greeting") || "Hi! How can we help you today?",
    title: script.getAttribute("data-title") || "AI Assistant",
    // Base UI language: explicit data-lang wins, then the host page's
    // own lang, then English (the embed UI's long-standing default).
    // This is only the STARTING language — uiLang (below) follows the
    // conversation itself from here.
    lang: ((script.getAttribute("data-lang") || document.documentElement.lang || "en").toLowerCase().indexOf("bn") === 0 ? "bn" : "en"),
  };

  // True when the host did not supply its own greeting: the default
  // greeting is embed chrome and localizes with uiLang; a host-supplied
  // data-greeting is the host's own copy and is always shown verbatim.
  var greetingIsDefault = !script.getAttribute("data-greeting");

  // ---- Agent character assets (ONE place) ----
  // The agent character is a PLATFORM asset: the bust still (also
  // the video poster + the no-video fallback), the idle clip,
  // the working clip and the completion clip resolve from these
  // constants and
  // nowhere else in the embed. Central control for the brand-assets
  // build (shipped v2026-10-22.3): the Admin Panel's brand record is
  // fetched at init by fetchAgentBrand() (below); when it answers,
  // these vars re-resolve from the record (with its version
  // cache-bust) and every placement in this file follows automatically.
  var avatarUrl = config.server.replace(/\/$/, "") + "/agent-avatar.png";
  var idleVideoUrl = config.server.replace(/\/$/, "") + "/agent-idle.mp4";
  var workingVideoUrl = config.server.replace(/\/$/, "") + "/agent-working.mp4";
  var doneVideoUrl = config.server.replace(/\/$/, "") + "/agent-done.mp4";

  // ---- Agent brand record (Admin-controlled) ----
  // The agent character is an Admin Panel setting (Super Admin only,
  // Firestore agent_brand/current). The platform serves it publicly at
  // GET /api/widget/brand (relative to config.server). At init the embed
  // asks for it ONCE; when the record answers, the URL vars above
  // re-resolve with the record's version as a cache-buster, and the
  // already-rendered launcher/header markup is swapped in place.
  // Fail-soft by contract: a dead endpoint, a timeout, or a partial
  // record changes NOTHING -- the hardcoded platform defaults stay live,
  // and the widget never waits on this fetch.
  function brandCacheBust(url, version) {
    if (!url) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "v=" + encodeURIComponent(String(version == null ? 0 : version));
  }
  function applyBrandRecord(rec) {
    if (!rec || typeof rec !== "object") return false;
    var v = rec.version == null ? 0 : rec.version;
    var changed = false;
    if (typeof rec.logoUrl === "string" && rec.logoUrl) { avatarUrl = brandCacheBust(rec.logoUrl, v); changed = true; }
    if (typeof rec.idleVideoUrl === "string" && rec.idleVideoUrl) { idleVideoUrl = brandCacheBust(rec.idleVideoUrl, v); changed = true; }
    if (typeof rec.workingVideoUrl === "string" && rec.workingVideoUrl) { workingVideoUrl = brandCacheBust(rec.workingVideoUrl, v); changed = true; }
    if (typeof rec.completionVideoUrl === "string" && rec.completionVideoUrl) { doneVideoUrl = brandCacheBust(rec.completionVideoUrl, v); changed = true; }
    return changed;
  }
  function applyBrandToLiveDom() {
    // The brand fetch can resolve after createWidget already rendered the
    // defaults: swap the mounted launcher/header markup in place so a panel
    // change propagates without any page rebuild or widget re-init.
    var i, el;
    var idles = document.querySelectorAll(".rbai-vid-idle");
    for (i = 0; i < idles.length; i++) {
      el = idles[i];
      if (el.getAttribute("src") !== idleVideoUrl) {
        el.setAttribute("src", idleVideoUrl);
        el.removeAttribute("data-rbai-retried");
        try { el.load(); } catch (e1) {}
      }
      el.setAttribute("poster", avatarUrl);
    }
    var workings = document.querySelectorAll(".rbai-vid-working");
    for (i = 0; i < workings.length; i++) {
      el = workings[i];
      el.setAttribute("data-src", workingVideoUrl);
      el.removeAttribute("data-rbai-retried");
      if (el.getAttribute("src")) el.setAttribute("src", workingVideoUrl);
      el.setAttribute("poster", avatarUrl);
    }
    var dones = document.querySelectorAll(".rbai-vid-done");
    for (i = 0; i < dones.length; i++) {
      el = dones[i];
      el.setAttribute("data-src", doneVideoUrl);
      el.removeAttribute("data-rbai-retried");
      if (el.getAttribute("src")) el.setAttribute("src", doneVideoUrl);
      el.setAttribute("poster", avatarUrl);
    }
    var fallbacks = document.querySelectorAll(".rbai-avatar-fallback");
    for (i = 0; i < fallbacks.length; i++) fallbacks[i].setAttribute("src", avatarUrl);
    kickActiveVideos();
  }
  function fetchAgentBrand() {
    var endpoint;
    try { endpoint = config.server.replace(/\/$/, "") + "/api/widget/brand"; }
    catch (e0) { return; }
    var settled = false;
    function finish(rec) {
      if (settled) return;
      settled = true;
      if (rec && applyBrandRecord(rec) && widgetContainer) applyBrandToLiveDom();
    }
    try {
      // Timeout = fail-soft defaults: the widget never waits on this.
      setTimeout(function () { finish(null); }, 2500);
      fetch(endpoint, { credentials: "omit" }).then(function (r) {
        return (r && r.ok) ? r.json() : null;
      }).then(finish).catch(function () { finish(null); });
    } catch (e2) { /* fetch unavailable -- the defaults stay */ }
  }
  var agentState = "idle";
  var pendingRequests = 0;
  var workingWatchdog = null;
  var doneSettleTimer = null;
  var lastTurnProgressAt = 0;

  var isOpen = false;
  var widgetContainer = null;
  var inlineActive = false;

  // ---- Draggable launcher (v2026-10-23.2) ----
  // bubblePos = the visitor-chosen position of the (closed) widget
  // container's top-left corner, or null while the widget sits at its
  // default corner. preOpenPos = the position to restore when the
  // panel closes after an open-time shift (see anchorPanelToBubble).
  var bubblePos = null;
  var preOpenPos = null;
  var dragState = null;
  var suppressLauncherClick = false;
  var BUBBLE_POS_KEY = "rbai-bubble-pos:" + (config.siteKey || "default");

  // ---- Thread identity (session-scoped) ----
  // The visitor id and the platform conversation id persist in
  // sessionStorage (per site key), so the thread survives panel closes
  // and page reloads within the tab session: a human who takes over
  // the conversation keeps talking to the SAME thread, and this embed
  // can read that thread back via GET /api/chat/thread. A host-supplied
  // data-visitor-id always wins over the generated one.
  var storePrefix = "rbai-" + (config.siteKey || "default") + "-";
  function storeGet(key) {
    try { return window.sessionStorage.getItem(storePrefix + key); } catch (e) { return null; }
  }
  function storeSet(key, value) {
    try { window.sessionStorage.setItem(storePrefix + key, value); } catch (e) {}
  }
  if (!config.visitorId) {
    config.visitorId = storeGet("visitor") || "";
    if (!config.visitorId) {
      config.visitorId =
        "web-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      storeSet("visitor", config.visitorId);
    }
  }
  var conversationId = storeGet("conv") || null;

  // ---- Thread sync state ----
  // seenRemoteIds: thread message ids already rendered (or deliberately
  // skipped as local echoes). pendingEcho: the (role, content) pairs
  // this tab rendered itself from its own sends/replies, consumed by
  // the sync so nothing renders twice.
  var seenRemoteIds = {};
  var pendingEcho = [];
  var threadTimer = null;
  var threadSyncedOnce = false;
  // Adaptive thread-sync cadence (v2026-10-23.3, quota diet): fast
  // just after open / a turn / a new remote message, backing off
  // while idle to the cap; paused while the tab is hidden.
  var THREAD_SYNC_FAST_MS = 5000;
  var THREAD_SYNC_MAX_MS = 30000;
  var threadDelayMs = THREAD_SYNC_FAST_MS;
  var threadSyncActive = false;
  var threadRenderedCount = 0;
  // Delta sync: newest createdAt (ISO) seen in a thread-sync response,
  // and the in-flight sync promise (concurrent callers share it).
  var lastThreadTs = null;
  var threadSyncInFlight = null;
  var isPaused = false;

  // Live-activity caption channel: one random token per page session,
  // bound server-side to this visitor's conversation (chat/vision/voice
  // endpoints store it), so the embed can poll what the agent is really
  // doing before the first response hands back a conversationId.
  var activityToken = "at-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var activityTimer = null;
  var currentActivity = null;

  // ---- UI chrome strings (EN/BN) ----
  // EVERY user-facing string the embed itself renders comes from this
  // table (the activity captions below are the other half). uiLang is
  // the embed's one language state: it starts at config.lang (the
  // existing data-lang / page-lang mechanism) and then FOLLOWS THE
  // CONVERSATION — a Bengali message or reply switches the chrome to
  // Bengali, an English one switches it back (owner rule 2026-10-22:
  // bidirectional language purity — no English chrome inside a Bengali
  // conversation, and vice versa). The API carries no language field,
  // so the conversation text the embed already handles is the signal.
  var uiLang = config.lang;

  var UI_STRINGS = {
    en: {
      greeting: "Hi! How can we help you today?",
      typeMessage: "Type a message...",
      send: "Send",
      sendPhoto: "Send a photo",
      sendVideo: "Send a video",
      sendVoice: "Send a voice message",
      openChat: "Open chat",
      sentPhotoAlt: "Sent photo",
      productFallback: "Product",
      order: "Order",
      typing: "Typing...",
      lookingPhoto: "Looking at your photo...",
      watchingVideo: "Watching your video...",
      listening: "Listening...",
      videoSent: "Video sent",
      voiceSent: "Voice message sent",
      pausedTitle: "Chat paused",
      pausedBody: "This business's subscription is paused. Please ask them to reactivate to continue chatting.",
      tryAgain: "Try again",
      connError: "Connection problem — please check your internet connection and try again.",
      notConfigured: "This chat is not configured correctly yet. Please contact the business directly.",
      limitReached: "This business has reached its AI message limit for now. Please try again later, or contact the business directly.",
      rateLimited: "Too many messages. Please wait a moment and try again.",
      processError: "Sorry, I could not process your request.",
      tooLong: "Message too long",
      mediaError: "That file couldn't be processed. Please try another one.",
      photoTooLarge: "That photo is too large (max 4 MB). Please choose a smaller one.",
      videoTooLarge: "That video is too large (max 10 MB). Please choose a shorter one.",
      photoReadError: "I couldn't read that photo. Please try another one.",
      videoReadError: "I couldn't read that video. Please try another one.",
      voiceUnsupported: "Voice messages aren't supported in this browser. Please type your message.",
      recordingUnsupported: "Voice recording isn't supported in this browser. Please type your message.",
      recordingEmpty: "That recording was empty. Please try again.",
      recordingTooLong: "That recording is too long (max 10 MB). Please try a shorter one.",
      recordingProcessError: "I couldn't process that recording. Please try again.",
      micDenied: "I couldn't access the microphone. Please check the browser permission and try again.",
      micBlocked: "Microphone is blocked for this site. Allow it from the browser's site settings, then tap the mic again.",
      listenReply: "Listen to this reply",
      stopListening: "Stop listening",
      voiceUnavailable: "Voice playback isn't available on this device — no female voice was found for this language. Please read the reply above.",
      micNotFound: "No microphone was found. Please check your device and try again.",
      micBusy: "The microphone is being used by another app. Please close it and try again.",
    },
    bn: {
      greeting: "হাই! আজ কীভাবে সাহায্য করতে পারি?",
      typeMessage: "মেসেজ লিখুন...",
      send: "পাঠান",
      sendPhoto: "ছবি পাঠান",
      sendVideo: "ভিডিও পাঠান",
      sendVoice: "ভয়েস মেসেজ পাঠান",
      openChat: "চ্যাট খুলুন",
      sentPhotoAlt: "পাঠানো ছবি",
      productFallback: "পণ্য",
      order: "অর্ডার করুন",
      typing: "টাইপ করছে...",
      lookingPhoto: "আপনার ছবি দেখছি...",
      watchingVideo: "আপনার ভিডিও দেখছি...",
      listening: "শুনছি...",
      videoSent: "ভিডিও পাঠানো হয়েছে",
      voiceSent: "ভয়েস মেসেজ পাঠানো হয়েছে",
      pausedTitle: "চ্যাট বন্ধ আছে",
      pausedBody: "এই ব্যবসার সাবস্ক্রিপশন বন্ধ আছে। চ্যাট চালিয়ে যেতে তাদের আবার চালু করতে বলুন।",
      tryAgain: "আবার চেষ্টা করুন",
      connError: "সংযোগে সমস্যা হয়েছে — আপনার ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।",
      notConfigured: "এই চ্যাট এখনো ঠিকমতো সেটআপ হয়নি। অনুগ্রহ করে সরাসরি ব্যবসার সঙ্গে যোগাযোগ করুন।",
      limitReached: "এই ব্যবসার AI মেসেজের সীমা আপাতত শেষ। পরে আবার চেষ্টা করুন, অথবা সরাসরি ব্যবসার সঙ্গে যোগাযোগ করুন।",
      rateLimited: "অনেকগুলো মেসেজ পাঠানো হয়েছে। কিছুক্ষণ অপেক্ষা করে আবার চেষ্টা করুন।",
      processError: "দুঃখিত, আপনার অনুরোধটি সম্পন্ন করতে পারিনি।",
      tooLong: "মেসেজটি অনেক লম্বা",
      mediaError: "ফাইলটি প্রসেস করা যায়নি। অন্য একটি দিয়ে চেষ্টা করুন।",
      photoTooLarge: "ছবিটি অনেক বড় (সর্বোচ্চ ৪ MB)। ছোট একটি ছবি বেছে নিন।",
      videoTooLarge: "ভিডিওটি অনেক বড় (সর্বোচ্চ ১০ MB)। ছোট একটি ভিডিও বেছে নিন।",
      photoReadError: "ছবিটি পড়তে পারিনি। অন্য একটি ছবি দিয়ে চেষ্টা করুন।",
      videoReadError: "ভিডিওটি পড়তে পারিনি। অন্য একটি ভিডিও দিয়ে চেষ্টা করুন।",
      voiceUnsupported: "এই ব্রাউজারে ভয়েস মেসেজ চালানো যাবে না। আপনার মেসেজটি লিখে পাঠান।",
      recordingUnsupported: "এই ব্রাউজারে ভয়েস রেকর্ড করা যাবে না। আপনার মেসেজটি লিখে পাঠান।",
      recordingEmpty: "রেকর্ডিংটি খালি ছিল। আবার চেষ্টা করুন।",
      recordingTooLong: "রেকর্ডিংটি অনেক লম্বা (সর্বোচ্চ ১০ MB)। ছোট করে আবার রেকর্ড করুন।",
      recordingProcessError: "রেকর্ডিংটি প্রসেস করতে পারিনি। আবার চেষ্টা করুন।",
      micDenied: "মাইক্রোফোন ব্যবহারের অনুমতি পাইনি। ব্রাউজারের অনুমতি দেখে আবার চেষ্টা করুন।",
      micBlocked: "এই সাইটের জন্য মাইক্রোফোন বন্ধ আছে। ব্রাউজারের সাইট সেটিংস থেকে অনুমতি দিয়ে আবার মাইকে চাপ দিন।",
      listenReply: "উত্তরটি শুনুন",
      stopListening: "শোনা থামান",
      voiceUnavailable: "এই ডিভাইসে ভয়েস শোনা যাচ্ছে না — এই ভাষার জন্য মেয়ে কন্ঠ পাওয়া যায়নি। উপরের লেখা উত্তরটি পড়ুন।",
      micNotFound: "কোনো মাইক্রোফোন পাওয়া যায়নি। আপনার ডিভাইস দেখে আবার চেষ্টা করুন।",
      micBusy: "মাইক্রোফোনটি অন্য অ্যাপে ব্যবহৃত হচ্ছে। সেটি বন্ধ করে আবার চেষ্টা করুন।",
    },
  };

  function t(key) {
    var table = UI_STRINGS[uiLang] || UI_STRINGS.en;
    return table[key] || UI_STRINGS.en[key] || key;
  }

  // Conversation-language signal: Bengali script anywhere in the text
  // means the conversation is Bengali; Latin letters with no Bengali
  // mean English; anything else (digits, emoji, a bare URL) is no
  // signal and leaves uiLang unchanged.
  function detectTextLang(text) {
    if (!text || typeof text !== "string") return null;
    if (/[\u0980-\u09FF]/.test(text)) return "bn";
    if (/[A-Za-z]/.test(text)) return "en";
    return null;
  }

  function setUiLang(lang) {
    if (!lang || lang === uiLang || !UI_STRINGS[lang]) return;
    uiLang = lang;
    applyChromeStrings();
    renderStatus();
  }

  // Re-render the static chrome in the current uiLang (called when the
  // conversation language switches; initial render uses t() directly).
  function applyChromeStrings() {
    var input = document.getElementById("rbai-widget-text");
    if (input) input.setAttribute("placeholder", t("typeMessage"));
    var sendBtn = document.getElementById("rbai-widget-send");
    if (sendBtn) sendBtn.textContent = t("send");
    var photoBtn = document.getElementById("rbai-widget-photo");
    if (photoBtn) { photoBtn.title = t("sendPhoto"); photoBtn.setAttribute("aria-label", t("sendPhoto")); }
    var videoBtn = document.getElementById("rbai-widget-video");
    if (videoBtn) { videoBtn.title = t("sendVideo"); videoBtn.setAttribute("aria-label", t("sendVideo")); }
    var micBtn = document.getElementById("rbai-widget-mic");
    if (micBtn) { micBtn.title = t("sendVoice"); micBtn.setAttribute("aria-label", t("sendVoice")); }
    var launcher = document.getElementById("rbai-widget-btn");
    if (launcher) launcher.setAttribute("aria-label", t("openChat"));
    var pausedTitle = document.querySelector("#rbai-paused-notice h4");
    if (pausedTitle) pausedTitle.textContent = t("pausedTitle");
    var pausedBody = document.querySelector("#rbai-paused-notice p");
    if (pausedBody) pausedBody.textContent = t("pausedBody");
    var pausedRetry = document.getElementById("rbai-paused-retry");
    if (pausedRetry) pausedRetry.textContent = t("tryAgain");
  }

  // Server endpoints return human English `error` texts (validation,
  // rate limits, 500s). Those strings are born server-side but become
  // user-facing only here, so the embed maps every known one to its
  // localized chrome string and NEVER renders a raw server error: an
  // unmapped error falls back to the localized generic. (Codes the
  // embed already special-cases — subscription_paused,
  // message_limit_reached, HTTP 401/402 — are handled before this.)
  function localizeServerError(err) {
    if (!err || typeof err !== "string") return null;
    if (err.indexOf("Too many") === 0) return t("rateLimited");
    if (err === "Image too large (max 4 MB)") return t("photoTooLarge");
    if (err === "Video too large (max 10 MB)") return t("videoTooLarge");
    if (err === "Audio too large (max 10 MB)") return t("recordingTooLong");
    if (err === "Message too long") return t("tooLong");
    if (
      err === "Failed to process message" ||
      err === "Failed to process media" ||
      err === "Failed to process audio"
    ) return t("processError");
    if (
      err === "Message or image is required" ||
      err === "audio is required" ||
      err === "Provide exactly one of image or video" ||
      err === "Only image attachments are supported" ||
      err === "Only image uploads are supported here" ||
      err === "Only video uploads are supported here" ||
      err === "Only audio uploads are supported here" ||
      err === "Invalid image data" ||
      err === "Invalid video data" ||
      err === "Invalid audio data"
    ) return t("mediaError");
    return null;
  }

  // Action-specific captions, keyed by the engine's REAL activity kinds
  // (src/lib/ai/activity.ts). A specific caption appears only while the
  // matching action genuinely runs server-side; anything unobserved
  // falls back to the plain typing caption — never a fabricated claim.
  var ACTIVITY_CAPTIONS = {
    en: {
      composing: "Typing…",
      consulting_knowledge: "Checking the knowledge base…",
      perceiving_media: "Looking at your media…",
      searching_catalog: "Searching the catalog…",
      searching_website: "Searching the website…",
      recommending_alternatives: "Looking for alternatives…",
      finding_products: "Finding products for you…",
      creating_ticket: "Creating a support ticket…",
      assigning_ticket: "Assigning this to the team…",
      sending_email: "Emailing the team…",
      checking_history: "Checking your history…",
      scheduling_followup: "Scheduling a follow-up…",
      taking_order: "Placing your order…",
      triggering_webhook: "Notifying the business system…",
      sending_reply: "Sending the reply…",
    },
    bn: {
      composing: "টাইপ করছে…",
      consulting_knowledge: "জ্ঞানভাণ্ডারে খুঁজছে…",
      perceiving_media: "আপনার মিডিয়া দেখছে…",
      searching_catalog: "ক্যাটালগে খুঁজছে…",
      searching_website: "ওয়েবসাইট সার্চ করছে…",
      recommending_alternatives: "বিকল্প খুঁজছে…",
      finding_products: "আপনার জন্য পণ্য খুঁজছে…",
      creating_ticket: "সাপোর্ট টিকিট তৈরি করছে…",
      assigning_ticket: "টিমের কাছে পাঠাচ্ছে…",
      sending_email: "টিমকে ইমেইল পাঠাচ্ছে…",
      checking_history: "আপনার আগের বার্তা দেখছে…",
      scheduling_followup: "ফলো-আপ ঠিক করছে…",
      taking_order: "আপনার অর্ডার নিচ্ছে…",
      triggering_webhook: "ব্যবসার সিস্টেমে জানাচ্ছে…",
      sending_reply: "উত্তর পাঠাচ্ছে…",
    },
  };
  var SEND_CHANNEL_CAPTIONS = {
    en: {
      whatsapp: "Messaging on WhatsApp…",
      facebook: "Messaging on Facebook…",
      instagram: "Messaging on Instagram…",
      messenger: "Messaging on Messenger…",
      telegram: "Messaging on Telegram…",
      email: "Sending an email…",
    },
    bn: {
      whatsapp: "WhatsApp-এ মেসেজ করছে…",
      facebook: "Facebook-এ মেসেজ করছে…",
      instagram: "Instagram-এ মেসেজ করছে…",
      messenger: "Messenger-এ মেসেজ করছে…",
      telegram: "Telegram-এ মেসেজ করছে…",
      email: "ইমেইল পাঠাচ্ছে…",
    },
  };
  function captionForActivity(a) {
    var lang = ACTIVITY_CAPTIONS[uiLang] ? uiLang : "en";
    if (a && a.kind === "sending_reply" && a.channel) {
      var perChannel = SEND_CHANNEL_CAPTIONS[lang][a.channel];
      if (perChannel) return perChannel;
    }
    if (a && ACTIVITY_CAPTIONS[lang][a.kind]) return ACTIVITY_CAPTIONS[lang][a.kind];
    return ACTIVITY_CAPTIONS[lang].composing;
  }

  var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  var MAX_MEDIA_BYTES = 10 * 1024 * 1024;

  // Mascot framing. The STILL (agent-avatar.png) is the bust asset
  // (woman model 2026-10-29: the ASSET ITSELF is the bust: the 380x380
  // crop at (87,20) of the 512x512 owner still, exported at 512x512
  // — still-measured face x 192-356, y 81-317; shoulders x 163-391,
  // y 236-374.). The fallback <img> stays plain cover-fit: it is only
  // the poster / failure fallback. The VIDEO clips are 720x1280
  // FULL SCENES; the working clip is framed as a scene (owner directive
  // 2026-10-22, superseding the v.2 bust-centred video crop, which
  // centred the face and cut the laptop — the point of the working
  // scene — out of the circular slots entirely). Measured on the
  // shipped clips (composition is stable across each 10s loop):
  //   idle (51, standing) — head x 240-500, y 137-616; tablet x 125-300,
  //             y 645-758; hands y 690-791;
  //   working (a4, seated) — head x 171-390, y 433-742; laptop x 241-713,
  //             y 778-1018; typing hand x 215-393, y 892-978.
  // In a square slot, cover-fit on a full-width <video> can only
  // ever show a 720x720 band of the 1280-tall frame. The WORKING
  // class below therefore NARROWs the element (kept centred):
  // cover maps the full 480 width into the narrower box, which
  // stretches the visible window vertically. The IDLE class does
  // NOT narrow (owner correction 2026-10-22, v2026-10-22.6): the
  // v.5 whole-figure idle window read TOO BIG in the front
  // slots, so the idle clip is back to the smaller chest-up bust
  // of the pre-v.5 presentation —
  //   idle:    full width, object-position 17% -> window 720x720
  //            -> band y 95-815: head, tablet and hands (chest-up), at the
  //            smaller scale the owner preferred.
  //   working: width 84% -> window 720x857, object-position 32%
  //            -> band y 135-992: head, torso, typing hands AND
  //            the laptop screen/keyboard inside the frame (bottom edge trimmed ~26px).
  // Launcher (56px) and header (36px) wrap sizes are unchanged.
  //   done: 51 excerpt 5.0-6.2s (camera-facing standing pose); replace with a
  //            dedicated completion clip when the owner supplies one.
  function createStyles() {
    var style = document.createElement("style");
    style.textContent = "\n\
      #rbai-widget-container{position:fixed;bottom:20px;" + config.position + ":20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}\n\
      #rbai-widget-btn{width:56px;height:56px;border-radius:50%;background:" + config.color + ";border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:transform .2s}\n\
      #rbai-widget-btn:hover{transform:scale(1.05)}\n\
      #rbai-widget-btn{overflow:hidden;padding:0}\n\.rbai-avatarwrap{position:relative;display:block;overflow:hidden;background:#fff}\n\#rbai-widget-btn .rbai-avatarwrap{width:56px;height:56px;border-radius:50%}\n\#rbai-widget-header .rbai-avatarwrap{width:36px;height:36px;border-radius:50%;margin-right:10px;flex:none}\n\.rbai-vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;pointer-events:none}\n\.rbai-vid.active{display:block}\n\.rbai-avatar-fallback{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none}\n\.rbai-avatarwrap.novid .rbai-avatar-fallback{display:block}\n\.rbai-avatarwrap.novid .rbai-vid{display:none!important}\n\#rbai-widget-headwrap{display:flex;align-items:center}\n\
      #rbai-widget-panel{display:none;width:370px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 100px);background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.12);margin-bottom:12px;overflow:hidden;flex-direction:column}\n\
      #rbai-widget-panel.open{display:flex}\n\
      #rbai-widget-btn{touch-action:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}\n\
      #rbai-widget-container.rbai-dragging{transition:none!important}\n\
      #rbai-widget-container.rbai-dragging #rbai-widget-btn{cursor:grabbing;transform:none}\n\
      #rbai-widget-container.rbai-panel-below{display:flex;flex-direction:column;align-items:flex-start}\n\
      #rbai-widget-container.rbai-panel-below #rbai-widget-btn{order:1;flex:none}\n\
      #rbai-widget-container.rbai-panel-below #rbai-widget-panel{order:2;margin-bottom:0;margin-top:12px}\n\
      #rbai-widget-container.rbai-inline{position:relative;bottom:auto;left:auto;right:auto;z-index:1;width:100%}\n\
      #rbai-widget-container.rbai-inline #rbai-widget-panel{width:100%;max-width:100%;height:560px;max-height:640px;margin-bottom:0}\n\
      #rbai-widget-container.rbai-inline #rbai-widget-btn{display:none}\n\
      #rbai-widget-container.rbai-inline #rbai-widget-close{display:none}\n\
      #rbai-widget-header{background:" + config.color + ";color:#fff;padding:16px;display:flex;align-items:center;justify-content:space-between}\n\
      #rbai-widget-header h3{margin:0;font-size:15px;font-weight:600}\n\
      #rbai-widget-status{display:flex;align-items:center;gap:7px;padding:7px 16px;background:#F0FDF6;border-bottom:1px solid #E2E8F0;font-size:12.5px;font-weight:600;color:#065F46}\n\
      #rbai-widget-status[hidden]{display:none}\n\
      #rbai-widget-status .rbai-status-dot{width:8px;height:8px;border-radius:50%;background:" + config.color + ";flex:none;animation:rbai-pulse 1.2s infinite}\n\
      .rbai-vid-idle{object-position:50% 17%}\n\
      .rbai-vid-working{left:50%;transform:translateX(-50%);width:84%;object-position:50% 32%}\n\
      .rbai-vid-done{left:50%;transform:translateX(-50%);width:84%;object-position:50% 32%}\n\
      #rbai-widget-close{background:none;border:none;color:#fff;cursor:pointer;font-size:20px;padding:0;line-height:1}\n\
      #rbai-widget-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}\n\
      .rbai-msg{max-width:80%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.4;word-wrap:break-word}\n\
      .rbai-msg.bot{background:#F1F5F9;color:#1E293B;align-self:flex-start;border-bottom-left-radius:4px}\n\
      .rbai-msg.user{background:" + config.color + ";color:#fff;align-self:flex-end;border-bottom-right-radius:4px}\n\
      .rbai-msg.typing{color:#94A3B8;font-style:italic;animation:rbai-pulse 1.2s infinite}\n\
      .rbai-msg.system{align-self:center;background:transparent;color:#94A3B8;font-size:12px;line-height:1.45;text-align:center;padding:6px 12px;max-width:92%}\n\
      .rbai-speak{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-left:6px;padding:0;border:none;border-radius:9999px;background:transparent;color:#94A3B8;cursor:pointer;vertical-align:-6px}\n\
      .rbai-speak:hover{color:#475569;background:rgba(100,116,139,.12)}\n\
      .rbai-speak.speaking{color:#0B7A55;background:rgba(11,122,85,.12)}\n\
      .rbai-speak svg{width:14px;height:14px;flex:none}\n\
      .rbai-msg.rbai-img-msg{padding:6px}\n\
      .rbai-msg.rbai-img-msg img{display:block;max-width:180px;border-radius:8px}\n\
      #rbai-widget-input{display:flex;align-items:flex-end;border-top:1px solid #E2E8F0;padding:12px;gap:6px}\n\
      #rbai-widget-input textarea{flex:1;min-width:0;height:42px;min-height:42px;border:1px solid #E2E8F0;border-radius:8px;padding:10px 14px;font-size:14px;outline:none;resize:none;line-height:1.45;font-family:inherit;overflow-y:hidden;box-sizing:border-box}\n\
      #rbai-widget-input textarea:focus{border-color:" + config.color + "}\n\
      #rbai-widget-input button#rbai-widget-send{background:" + config.color + ";color:#fff;border:none;border-radius:8px;padding:10px 16px;cursor:pointer;font-size:14px;flex:none}\n\
      .rbai-iconbtn{background:none;border:none;cursor:pointer;color:#64748B;padding:6px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex:none}\n\
      .rbai-iconbtn:hover{background:#F1F5F9;color:" + config.color + "}\n\
      .rbai-iconbtn svg{width:20px;height:20px;display:block}\n\
      .rbai-iconbtn.recording{color:#DC2626;animation:rbai-pulse 1.2s infinite}\n\
      @keyframes rbai-pulse{0%{opacity:1}50%{opacity:.4}100%{opacity:1}}\n\
      #rbai-widget-input textarea:disabled,.rbai-iconbtn:disabled,#rbai-widget-send:disabled{opacity:.45;cursor:not-allowed}\n\
      .rbai-cards{align-self:flex-start;width:94%;display:flex;flex-direction:column;gap:10px;margin:2px 0 6px}\n\
      .rbai-card{background:#fff;border:1px solid #E8EEF3;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(15,23,42,.07)}\n\
      .rbai-card-img{width:100%;height:140px;object-fit:cover;display:block;background:#F1F5F9}\n\
      .rbai-card-body{padding:12px 14px 14px}\n\
      .rbai-card-name{font-size:14px;font-weight:700;color:#0F172A;margin:0 0 4px}\n\
      .rbai-card-price{font-size:14px;font-weight:800;color:" + config.color + ";margin:0 0 6px}\n\
      .rbai-card-desc{font-size:12.5px;line-height:1.45;color:#64748B;margin:0 0 10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}\n\
      .rbai-order-btn{width:100%;background:" + config.color + ";color:#fff;border:none;border-radius:8px;padding:9px 12px;font-size:13px;font-weight:600;cursor:pointer;transition:filter .15s}\n\
      .rbai-order-btn:hover{filter:brightness(.92)}\n\
      #rbai-paused-notice{align-self:center;width:92%;text-align:center;border:1.5px dashed " + config.color + ";background:#F0FDF6;border-radius:12px;padding:18px 14px;margin:8px 0}\n\
      #rbai-paused-notice .rbai-paused-icon{width:40px;height:40px;margin:0 auto 10px;color:" + config.color + "}\n\
      #rbai-paused-notice .rbai-paused-icon svg{width:100%;height:100%}\n\
      #rbai-paused-notice h4{margin:0 0 6px;font-size:15px;font-weight:700;color:#0F172A}\n\
      #rbai-paused-notice p{margin:0 0 12px;font-size:13px;line-height:1.5;color:#475569}\n\
      #rbai-paused-retry{background:" + config.color + ";color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer}\n\
      #rbai-paused-retry:hover{filter:brightness(.92)}\n\
    ";
    document.head.appendChild(style);
  }

  var SVG_PHOTO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6" fill="currentColor" stroke="none"/><path d="M3 17l5-5 4 4 3-3 6 6"/></svg>';
  var SVG_VIDEO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l7-3v10l-7-3z"/></svg>';
  var SVG_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  var SVG_PAUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg>';

  function createWidget() {
    var container = document.createElement("div");
    container.id = "rbai-widget-container";
    widgetContainer = container;
    container.innerHTML = '\
      <div id="rbai-widget-panel">\
        <div id="rbai-widget-header">\
          <div id="rbai-widget-headwrap"><span class="rbai-avatarwrap"><video class="rbai-vid rbai-vid-idle active" muted loop playsinline autoplay preload="auto" disablepictureinpicture src="' + idleVideoUrl + '"></video><video class="rbai-vid rbai-vid-working" muted loop playsinline preload="none" disablepictureinpicture data-src="' + workingVideoUrl + '"></video><video class="rbai-vid rbai-vid-done" muted playsinline preload="none" disablepictureinpicture data-src="' + doneVideoUrl + '"></video><img class="rbai-avatar-fallback" src="' + avatarUrl + '" alt=""/></span><h3>' + escapeHtml(config.title) + '</h3></div>\
          <button id="rbai-widget-close">&times;</button>\
        </div>\
        <div id="rbai-widget-status" hidden><span class="rbai-status-dot"></span><span id="rbai-widget-status-text"></span></div>\
        <div id="rbai-widget-messages"></div>\
        <div id="rbai-widget-input">\
          <button type="button" class="rbai-iconbtn" id="rbai-widget-photo" title="' + t("sendPhoto") + '" aria-label="' + t("sendPhoto") + '">' + SVG_PHOTO + '</button>\
          <button type="button" class="rbai-iconbtn" id="rbai-widget-video" title="' + t("sendVideo") + '" aria-label="' + t("sendVideo") + '">' + SVG_VIDEO + '</button>\
          <button type="button" class="rbai-iconbtn" id="rbai-widget-mic" title="' + t("sendVoice") + '" aria-label="' + t("sendVoice") + '">' + SVG_MIC + '</button>\
          <textarea id="rbai-widget-text" rows="1" placeholder="' + t("typeMessage") + '"></textarea>\
          <button id="rbai-widget-send">' + t("send") + '</button>\
        </div>\
        <input type="file" id="rbai-widget-file" accept="image/*" style="display:none" />\
        <input type="file" id="rbai-widget-videofile" accept="video/*" style="display:none" />\
      </div>\
      <button id="rbai-widget-btn" aria-label="' + t("openChat") + '">\
        <span class="rbai-avatarwrap"><video class="rbai-vid rbai-vid-idle active" muted loop playsinline autoplay preload="auto" disablepictureinpicture src="' + idleVideoUrl + '"></video><video class="rbai-vid rbai-vid-working" muted loop playsinline preload="none" disablepictureinpicture data-src="' + workingVideoUrl + '"></video><video class="rbai-vid rbai-vid-done" muted playsinline preload="none" disablepictureinpicture data-src="' + doneVideoUrl + '"></video><img class="rbai-avatar-fallback" src="' + avatarUrl + '" alt=""/></span>\
      </button>\
    ';
    document.body.appendChild(container);
    wireVideoFallback();
    startAliveWatchdog();
    syncInlineMount();
    // The bust still is the poster for BOTH clips: the idle clip
    // shows it until its first frame paints, and the working clip
    // (lazy-loaded on first use) shows it instead of a blank
    // circle while its first frames arrive after a state switch.
    // EVERY clip also gets the muted PROPERTY set in JS and every
    // idle clip an explicit play() kick: the launcher clip is the
    // one visible at rest, and on mobile browsers (iOS especially)
    // the autoplay attribute alone on an innerHTML-inserted
    // <video> is not a guarantee.
    var allVids = container.querySelectorAll(".rbai-vid");
    for (var p = 0; p < allVids.length; p++) {
      allVids[p].setAttribute("poster", avatarUrl);
      try { allVids[p].muted = true; allVids[p].defaultMuted = true; } catch (e) {}
    }
    var idleVids = container.querySelectorAll(".rbai-vid-idle");
    for (var q = 0; q < idleVids.length; q++) safePlay(idleVids[q]);
    // Belt-and-braces for mobile browsers that drop an early play()
    // without a trace: re-kick the active clips shortly after mount.
    setTimeout(kickActiveVideos, 1200);
    setTimeout(kickActiveVideos, 4000);

    var launcherBtn = document.getElementById("rbai-widget-btn");
    if (launcherBtn)
      launcherBtn.onclick = function () {
        // A click that trails a real drag belongs to the drag
        // (v2026-10-23.2): swallow it; a plain tap toggles as before.
        if (suppressLauncherClick) {
          suppressLauncherClick = false;
          return;
        }
        toggleWidget();
      };
    initBubbleDrag();
    document.getElementById("rbai-widget-close").onclick = toggleWidget;
    document.getElementById("rbai-widget-send").onclick = sendMessage;
    var composeBox = document.getElementById("rbai-widget-text");
    // Send mapping (unchanged from the single-line era): Enter sends.
    // In a textarea Shift+Enter inserts a newline instead of sending.
    composeBox.onkeydown = function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };
    // Auto-grow: the box follows its content on every input event
    // (typing AND paste both fire it) and resets on send.
    composeBox.addEventListener("input", autoGrowInput);
    document.getElementById("rbai-widget-photo").onclick = function () {
      if (!isPaused) document.getElementById("rbai-widget-file").click();
    };
    document.getElementById("rbai-widget-video").onclick = function () {
      if (!isPaused) document.getElementById("rbai-widget-videofile").click();
    };
    document.getElementById("rbai-widget-mic").onclick = toggleRecording;
    document.getElementById("rbai-widget-file").onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) uploadPhoto(f);
    };
    document.getElementById("rbai-widget-videofile").onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (f) uploadVideo(f);
    };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // The working clip is NOT loaded with the host page (it would tax
  // every site's initial load ecosystem-wide). Its <video> elements
  // carry data-src only; the real src is attached on first panel open
  // or first send — whichever comes first — and kept afterwards.
  // play()/pause() that tolerate browsers whose play() returns
  // undefined (older Safari): calling .catch on undefined inside
  // the settle path could throw and swallow the reply render.
  function safePlay(v) {
    if (!v) return;
    try { v.muted = true; } catch (e) {}
    try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
  }
  function safePause(v) {
    if (!v) return;
    try { v.pause(); } catch (e) {}
  }

  // Re-kick whichever clip is currently active in every wrap.
  // Needed after DOM (re)mounts (inline/SPA moves can pause a
  // media element), when the tab becomes visible again, and after
  // user gestures on browsers that blocked the first autoplay.
  function kickActiveVideos() {
    var act = document.querySelectorAll(".rbai-vid.active");
    for (var i = 0; i < act.length; i++) {
      // An ENDED completion clip stays ended (it plays once);
      // a merely-paused one may still be re-kicked mid-play.
      if (act[i].classList.contains("rbai-vid-done") && act[i].ended) continue;
      if (act[i].paused) safePlay(act[i]);
    }
  }

  // Always-alive watchdog (owner rule 2026-10-22): the mascot
  // must never end up frozen — a browser can park the active clip
  // at any time (autoplay-policy change mid-session, a discarded
  // media resource under memory pressure, an OS interruption, a
  // stall at the loop seam) without firing any event the kicks
  // above listen to. Every 4s this checks the clip that SHOULD be
  // playing (the .active one, in a wrap that is actually on
  // screen) and re-plays it if it is paused or ended. Clips in an
  // error state are left to the error handler + the probe below.
  // A wrap that fell back to the still image (.novid) is retried
  // at most once a minute: the still is a momentary fallback,
  // never a terminal state — if the clip can load again, the
  // wrap returns to video on its own.
  var aliveWatchdog = null;
  var lastNovidProbe = 0;
  function aliveTick() {
    if (document.hidden) return;
    var act = document.querySelectorAll(".rbai-vid.active");
    for (var i = 0; i < act.length; i++) {
      var v = act[i];
      // The completion clip plays exactly ONCE: the alive watchdog
      // must never replay it (its own settle path handles it).
      if (v.classList.contains("rbai-vid-done")) continue;
      var wrap = v.closest(".rbai-avatarwrap");
      if (wrap && wrap.classList.contains("novid")) continue;
      if (!v.getClientRects().length) continue; // hidden wrap (closed panel) — kicked on open
      if (v.error) continue;
      if (v.ended) {
        try { v.currentTime = 0; } catch (e) {}
        safePlay(v);
      } else if (v.paused) {
        safePlay(v);
      }
    }
    var now = Date.now();
    if (now - lastNovidProbe > 60000) {
      var wraps = document.querySelectorAll(".rbai-avatarwrap.novid");
      if (wraps.length) {
        lastNovidProbe = now;
        for (var j = 0; j < wraps.length; j++) {
          wraps[j].classList.remove("novid");
          var wv = wraps[j].querySelectorAll(".rbai-vid");
          for (var k = 0; k < wv.length; k++) {
            wv[k].removeAttribute("data-rbai-retried");
            if (wv[k].classList.contains("active")) {
              try { wv[k].load(); } catch (e2) {}
              safePlay(wv[k]);
            }
          }
        }
      }
    }
  }
  function startAliveWatchdog() {
    if (aliveWatchdog) return;
    aliveWatchdog = setInterval(aliveTick, 4000);
  }

  // Working-state watchdog: a request whose transport hangs
  // forever (half-open SSE/fetch on mobile) must not pin the
  // agent in the working state until reload. If the state is
  // still "working" 90s after the turn's LAST SIGN OF LIFE,
  // force-settle to idle; a reply that arrives later still
  // renders through the normal response handler (its settle is
  // a no-op against the zeroed counter, guarded by Math.max in
  // settleRequest).
  // Progress-aware (voice/video round 2026-10-22): the old
  // watchdog measured from state ENTRY, so a genuinely long
  // turn — multi-round tool work, a media-analysis wait (three
  // sequential vision calls + synthesis + the chat turn) —
  // was force-settled to idle mid-turn at 90s even though it
  // was alive and progressing. The watchdog now settles only
  // after 90s of SILENCE: tokens, retracts and live server
  // activity reports all stamp lastTurnProgressAt via
  // noteTurnProgress(), and a firing watchdog with recent
  // progress re-arms for just the remaining quiet time.
  function noteTurnProgress() {
    lastTurnProgressAt = Date.now();
  }
  function armWorkingWatchdog(delayMs) {
    if (workingWatchdog) return;
    var delay = typeof delayMs === "number" && delayMs > 0 ? delayMs : 90000;
    workingWatchdog = setTimeout(function () {
      workingWatchdog = null;
      if (agentState === "working") {
        var quietFor = Date.now() - (lastTurnProgressAt || 0);
        if (lastTurnProgressAt && quietFor < 90000) {
          armWorkingWatchdog(90000 - quietFor);
          return;
        }
        pendingRequests = 0;
        setAgentState("idle");
        stopActivityPolling();
      }
    }, delay);
  }
  function clearWorkingWatchdog() {
    if (workingWatchdog) { clearTimeout(workingWatchdog); workingWatchdog = null; }
  }

  // Completion-state safety net: the completion clip settles to
  // idle on its own 'ended' event; if that event never fires
  // (autoplay refused, clip error before first frame), this
  // timer guarantees the pose still settles shortly after the
  // clip's 1.2s runtime instead of pinning the mascot.
  function armDoneSettle() {
    clearDoneSettle();
    doneSettleTimer = setTimeout(function () {
      doneSettleTimer = null;
      if (agentState === "done") setAgentState("idle");
    }, 2800);
  }
  function clearDoneSettle() {
    if (doneSettleTimer) { clearTimeout(doneSettleTimer); doneSettleTimer = null; }
  }

  function ensureWorkingVideo() {
    var workings = document.querySelectorAll(".rbai-vid-working");
    for (var i = 0; i < workings.length; i++) {
      var v = workings[i];
      if (!v.getAttribute("src") && v.getAttribute("data-src")) {
        v.setAttribute("src", v.getAttribute("data-src"));
        try { v.load(); } catch (e) {}
      }
    }
    // The completion clip attaches on the same lazy path, so it
    // is loaded and ready BEFORE the first successful turn ends
    // (attaching it only at the done moment would race its own
    // first frame and the pose would be missed).
    var dones = document.querySelectorAll(".rbai-vid-done");
    for (var j = 0; j < dones.length; j++) {
      var d = dones[j];
      if (!d.getAttribute("src") && d.getAttribute("data-src")) {
        d.setAttribute("src", d.getAttribute("data-src"));
        try { d.load(); } catch (e) {}
      }
    }
  }

  // True only while the server has reported a SPECIFIC activity (a
  // real caption key) — as opposed to nothing observed yet, in which
  // case the caption falls back to the same generic "typing" words
  // the typing bubble already shows.
  function hasSpecificActivity() {
    if (!currentActivity) return false;
    var lang = ACTIVITY_CAPTIONS[uiLang] ? uiLang : "en";
    if (
      currentActivity.kind === "sending_reply" &&
      currentActivity.channel &&
      SEND_CHANNEL_CAPTIONS[lang][currentActivity.channel]
    ) return true;
    return !!ACTIVITY_CAPTIONS[lang][currentActivity.kind];
  }

  // The status strip under the header avatar: visible only while the
  // agent is working, captioned with the current REAL activity (or the
  // plain typing caption while nothing specific has been observed).
  // Owner 2026-10-22 (Help Center): the strip must never REPEAT the
  // typing bubble's generic caption — while a typing bubble is in the
  // thread, that bubble is the turn's one typing indicator, and the
  // strip stays hidden until a specific activity gives it something
  // of its own to say.
  function renderStatus() {
    var strip = document.getElementById("rbai-widget-status");
    var text = document.getElementById("rbai-widget-status-text");
    if (!strip || !text) return;
    if (agentState === "working") {
      if (document.querySelector(".rbai-msg.typing") && !hasSpecificActivity()) {
        strip.hidden = true;
        return;
      }
      text.textContent = captionForActivity(currentActivity);
      strip.hidden = false;
    } else {
      strip.hidden = true;
    }
  }

  function setAgentState(s) {
    var showWorking = s === "working";
    var showDone = s === "done";
    if (showWorking) noteTurnProgress();
    if (showWorking || showDone) ensureWorkingVideo();
    // Repeat calls in the same state (a second concurrent request,
    // an extra settle) only refresh the caption — they must not
    // restart the working clip at 0 or re-pause/re-play the clips.
    if (agentState === s) { renderStatus(); return; }
    agentState = s;
    if (showWorking) armWorkingWatchdog(); else clearWorkingWatchdog();
    if (showDone) armDoneSettle(); else clearDoneSettle();
    var idles = document.querySelectorAll(".rbai-vid-idle");
    var workings = document.querySelectorAll(".rbai-vid-working");
    var dones = document.querySelectorAll(".rbai-vid-done");
    for (var i = 0; i < idles.length; i++) {
      idles[i].classList.toggle("active", !showWorking && !showDone);
      if (showWorking || showDone) { safePause(idles[i]); }
      else { safePlay(idles[i]); }
    }
    for (var j = 0; j < workings.length; j++) {
      workings[j].classList.toggle("active", showWorking);
      if (showWorking) { try { workings[j].currentTime = 0; } catch (e) {} safePlay(workings[j]); }
      else { safePause(workings[j]); }
    }
    for (var k = 0; k < dones.length; k++) {
      dones[k].classList.toggle("active", showDone);
      if (showDone) { try { dones[k].currentTime = 0; } catch (e) {} safePlay(dones[k]); }
      else { safePause(dones[k]); }
    }
    renderStatus();
  }

  function wireVideoFallback() {
    var vids = document.querySelectorAll(".rbai-vid");
    for (var i = 0; i < vids.length; i++) {
      vids[i].addEventListener("error", function () {
        var v = this;
        // One self-heal attempt before giving up to the still image:
        // a transient network error on a phone must not freeze the
        // mascot into a static picture for the whole session.
        if (!v.getAttribute("data-rbai-retried")) {
          v.setAttribute("data-rbai-retried", "1");
          setTimeout(function () {
            try { v.load(); } catch (e) {}
            if (v.classList.contains("active")) safePlay(v);
          }, 1500);
          return;
        }
        var wrap = v.closest(".rbai-avatarwrap");
        if (wrap) wrap.classList.add("novid");
      });
      // Some mobile browsers / WebViews silently drop a play() that
      // was issued before the clip had any data: re-kick the active
      // clip at the exact moment it becomes able to play.
      vids[i].addEventListener("canplay", function () {
        if (this.classList.contains("active") && this.paused) safePlay(this);
      });
      // The clips carry `loop`, so an 'ended' event should never
      // fire — but a browser that interrupts the loop (resource
      // reloaded, playback stall at the seam) can still land the
      // ACTIVE clip on its last frame. Restart it at once: the
      // mascot must never sit frozen (owner rule 2026-10-22).
      vids[i].addEventListener("ended", function () {
        // The completion clip is the exception to the restart law
        // below: it plays exactly ONCE, and its end is the signal
        // to settle back to idle.
        if (this.classList.contains("rbai-vid-done")) {
          if (agentState === "done") setAgentState("idle");
          return;
        }
        if (this.classList.contains("active")) {
          try { this.currentTime = 0; } catch (e) {}
          safePlay(this);
        }
      });
    }
    // If autoplay was blocked, retry the active clip on user
    // interaction — every wrap's clip, not just the first, and
    // not just once.
    document.addEventListener("click", kickActiveVideos);
    document.addEventListener("pointerdown", kickActiveVideos);
    // Browsers pause backgrounded clips; resume the active one
    // when the tab becomes visible again.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) kickActiveVideos();
    });
    // Back/forward-cache restore: the page comes back with its
    // clips paused by the browser and NONE of the mount-time kicks
    // fire (the script does not re-run) — re-kick the active clip
    // on pageshow and make sure the watchdog is running.
    window.addEventListener("pageshow", function () {
      kickActiveVideos();
      startAliveWatchdog();
    });
    // A wrap that scrolled / was routed off-screen and comes back
    // into view gets its active clip re-kicked: some browsers
    // park off-screen media elements and never resume them.
    if (typeof IntersectionObserver !== "undefined") {
      var rbaiIo = new IntersectionObserver(function (entries) {
        for (var ei = 0; ei < entries.length; ei++) {
          if (entries[ei].isIntersecting) kickActiveVideos();
        }
      }, { threshold: 0.1 });
      var rbaiWraps = document.querySelectorAll(".rbai-avatarwrap");
      for (var wi = 0; wi < rbaiWraps.length; wi++) rbaiIo.observe(rbaiWraps[wi]);
    }
  }

  // ---- Draggable launcher implementation (v2026-10-23.2) ----
  // The visitor can drag the floating bubble anywhere on the page
  // (owner order 2026-10-23: the bubble often covers a page's bottom
  // submit button and could not be moved out of the way). Pointer
  // events only; a movement threshold separates a tap (opens the
  // panel, unchanged) from a drag (moves the widget; the click the
  // drag produces is swallowed exactly once). The position persists
  // for the tab session and is always clamped inside the viewport.

  function applyBubblePos(left, top, save) {
    var c = widgetContainer;
    if (!c) return;
    var rect = c.getBoundingClientRect();
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var maxL = Math.max(8, vw - rect.width - 8);
    var maxT = Math.max(8, vh - rect.height - 8);
    left = Math.min(Math.max(8, left), maxL);
    top = Math.min(Math.max(8, top), maxT);
    c.style.left = left + "px";
    c.style.top = top + "px";
    c.style.right = "auto";
    c.style.bottom = "auto";
    bubblePos = { left: left, top: top };
    if (save) {
      try {
        window.sessionStorage.setItem(BUBBLE_POS_KEY, JSON.stringify(bubblePos));
      } catch (e) {}
    }
  }

  function restoreBubblePos() {
    var raw = null;
    try {
      raw = window.sessionStorage.getItem(BUBBLE_POS_KEY);
    } catch (e) {}
    if (!raw) return;
    try {
      var p = JSON.parse(raw);
      if (p && isFinite(p.left) && isFinite(p.top)) {
        applyBubblePos(Number(p.left), Number(p.top), false);
      }
    } catch (e) {}
  }

  function clearBubbleInlinePos() {
    var c = widgetContainer;
    if (!c) return;
    c.style.left = "";
    c.style.top = "";
    c.style.right = "";
    c.style.bottom = "";
    c.classList.remove("rbai-panel-below");
  }

  // Panel anchoring for a moved bubble. The open box (panel + gap +
  // button) is the same total height in both arrangements; only the
  // button's strip inside it changes. Dropped in the top half → the
  // panel opens BELOW the button, so the button stays exactly where
  // it was dropped. Dropped in the bottom half → default arrangement
  // (panel above the button). Either way the whole open box is then
  // shift-clamped fully inside the viewport; the pre-open position
  // is remembered so closing restores the visitor's chosen spot.
  function anchorPanelToBubble() {
    if (!bubblePos || !widgetContainer) return;
    var vh = window.innerHeight || 0;
    var useBelow = bubblePos.top + 28 <= Math.floor(vh / 2);
    widgetContainer.classList.toggle("rbai-panel-below", useBelow);
    clampContainerIntoView(true);
  }

  function clampContainerIntoView(save) {
    if (!bubblePos || !widgetContainer) return;
    var rect = widgetContainer.getBoundingClientRect();
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var dx = 0;
    var dy = 0;
    if (rect.top < 8) dy = 8 - rect.top;
    else if (rect.bottom > vh - 8) dy = vh - 8 - rect.bottom;
    if (rect.left < 8) dx = 8 - rect.left;
    else if (rect.right > vw - 8) dx = vw - 8 - rect.right;
    if (dx || dy) applyBubblePos(bubblePos.left + dx, bubblePos.top + dy, save);
  }

  function onBubblePointerMove(e) {
    if (!dragState || e.pointerId !== dragState.id) return;
    var dx = e.clientX - dragState.sx;
    var dy = e.clientY - dragState.sy;
    if (!dragState.moved) {
      // Tap/drag threshold: small jitter is still a tap.
      if (Math.abs(dx) + Math.abs(dy) < 7) return;
      dragState.moved = true;
      if (widgetContainer) widgetContainer.classList.add("rbai-dragging");
    }
    applyBubblePos(dragState.left + dx, dragState.top + dy, false);
  }

  function onBubblePointerUp(e) {
    if (!dragState || e.pointerId !== dragState.id) return;
    var btn = document.getElementById("rbai-widget-btn");
    var wasDrag = dragState.moved;
    dragState = null;
    if (btn) {
      btn.removeEventListener("pointermove", onBubblePointerMove);
      btn.removeEventListener("pointerup", onBubblePointerUp);
      btn.removeEventListener("pointercancel", onBubblePointerUp);
    }
    if (widgetContainer) widgetContainer.classList.remove("rbai-dragging");
    if (wasDrag) {
      // The pointerup is followed by a click on the launcher: that
      // click belongs to the drag, not to a tap — swallow it once.
      suppressLauncherClick = true;
      setTimeout(function () {
        suppressLauncherClick = false;
      }, 400);
      // A deliberate move while open replaces the pre-open restore
      // point; the dragged position is the position now.
      preOpenPos = null;
      if (bubblePos) applyBubblePos(bubblePos.left, bubblePos.top, true);
      if (isOpen) anchorPanelToBubble();
    }
  }

  function onBubblePointerDown(e) {
    if (inlineActive || !widgetContainer) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    var btn = document.getElementById("rbai-widget-btn");
    if (!btn) return;
    var rect = widgetContainer.getBoundingClientRect();
    dragState = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    try {
      btn.setPointerCapture(e.pointerId);
    } catch (err) {}
    btn.addEventListener("pointermove", onBubblePointerMove);
    btn.addEventListener("pointerup", onBubblePointerUp);
    btn.addEventListener("pointercancel", onBubblePointerUp);
  }

  function initBubbleDrag() {
    var btn = document.getElementById("rbai-widget-btn");
    if (!btn) return;
    restoreBubblePos();
    if (!btn.addEventListener) return;
    btn.addEventListener("pointerdown", onBubblePointerDown);
    // The launcher holds <img>/<video> children: never let a press
    // turn into a native image drag instead of a bubble drag.
    btn.addEventListener("dragstart", function (e) {
      e.preventDefault();
    });
    window.addEventListener("resize", function () {
      if (!bubblePos || inlineActive) return;
      // Closed: re-clamp the bubble. Open: re-clamp the whole box.
      if (isOpen) clampContainerIntoView(true);
      else applyBubblePos(bubblePos.left, bubblePos.top, true);
    });
  }

  function toggleWidget() {
    isOpen = !isOpen;
    var panel = document.getElementById("rbai-widget-panel");
    panel.classList.toggle("open", isOpen);
    // Moved bubble (v2026-10-23.2): anchor the open panel to the
    // bubble's position; on close, restore the pre-open spot.
    if (isOpen && bubblePos) {
      preOpenPos = { left: bubblePos.left, top: bubblePos.top };
      anchorPanelToBubble();
    }
    if (!isOpen) {
      if (widgetContainer) widgetContainer.classList.remove("rbai-panel-below");
      if (preOpenPos) {
        var restorePos = preOpenPos;
        preOpenPos = null;
        applyBubblePos(restorePos.left, restorePos.top, true);
      }
    }
    // First open: lazily fetch the working clip (never on host-page load).
    if (isOpen) ensureWorkingVideo();
    if (isOpen) {
      // The panel always opens with the slim one-line composer.
      resetComposerOnOpen();
      kickActiveVideos();
      // A restored conversation renders its own history via the thread
      // sync; the greeting is only for a brand-new thread.
      if (!conversationId && !document.querySelector(".rbai-msg")) {
        addMessage(greetingIsDefault ? t("greeting") : config.greeting, "bot");
      }
      startThreadSync();
    } else {
      stopThreadSync();
    }
  }

  function addMessage(text, type) {
    var messages = document.getElementById("rbai-widget-messages");
    var msg = document.createElement("div");
    msg.className = "rbai-msg " + type;
    msg.textContent = text;
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
    return msg;
  }

  // ---- System notices (re-audit #2, owner report 2026-10-22) ----
  // Subtle centred lines for BROWSER/DEVICE states (microphone
  // blocked, no microphone found, recording problems). These are
  // NOT agent replies — the previous code posted them as "bot"
  // bubbles, which made a permission problem look like the agent
  // itself speaking (the owner's screenshot). The .system style
  // has no bubble: muted, centred, clearly chrome, not chat.
  // Dedupe (voice/video round 2026-10-22): the owner's screen
  // recording showed the identical mic-blocked notice inserted
  // TWICE in one conversation — every repeated mic attempt (or
  // any repeated device-state failure) stacked another copy of
  // the same line. A system notice is chrome, not chat: the
  // same text renders at most ONCE per widget lifetime, while
  // DISTINCT notices are never suppressed.
  var shownSystemNotices = {};
  function addSystemNotice(text) {
    if (!text) return null;
    if (shownSystemNotices[text]) return null;
    shownSystemNotices[text] = true;
    return addMessage(text, "system");
  }

  // ---- Voice playback (re-audit #2, owner directive 2026-10-22) ----
  // Every agent reply carries a small speaker control that reads
  // the reply aloud IN THE REPLY'S OWN LANGUAGE (Bengali replies
  // in Bengali, English in English) via the browser's built-in
  // speech synthesis — no keys, no cost. Rules: click-only (never
  // autoplay); clicking the same control again stops; starting
  // another reply's playback stops the current one; where speech
  // synthesis is unavailable the control is never rendered (no
  // dead button).
  var speakingBtn = null;
  var SVG_SPEAK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.6 5.4a9 9 0 0 1 0 13.2"/></svg>';
  var SVG_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

  function speechSupported() {
    return (
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      typeof SpeechSynthesisUtterance !== "undefined"
    );
  }

  function stopSpeaking() {
    var btn = speakingBtn;
    speakingBtn = null;
    if (btn) {
      btn.classList.remove("speaking");
      btn.innerHTML = SVG_SPEAK;
      btn.title = t("listenReply");
      btn.setAttribute("aria-label", t("listenReply"));
    }
    if (speechSupported()) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
  }

  // ---- Female voice selection (voice/video round 2026-10-22; ----
  // ---- hardened v2026-10-23.1, owner correction 2026-10-23) ----
  // OWNER RULE (firm): a spoken reply must ALWAYS be a female
  // voice — "সবসময়ই মেয়ে কন্ঠে কথা বলবে". The 2026-10-22 picker
  // returned null whenever no voice carried a known female NAME,
  // and speakReply then set only u.lang, so the BROWSER'S LANGUAGE
  // DEFAULT spoke — male or robotic on many devices. That silent
  // default was the main male-slip path; two more: an empty voice
  // list at first click (browsers load voices asynchronously) hit
  // the same default, and unlabelled same-language voices (most
  // Bengali bn-BD/bn-IN voices carry no gendered name) were
  // skipped even when they were the platform's female voice.
  // The picker therefore NEVER leaves the choice to the browser
  // default any more:
  //   Pass 1 — a voice for the REPLY'S language whose name is
  //     identifiably FEMALE (list below) -> pitch 1.0.
  //   Pass 2 — no identifiable female: the first voice for the
  //     language that is NOT identifiably male (unlabelled
  //     platform voices) -> pitch 1.1 (a slightly raised,
  //     feminizing nudge inside the 1.05-1.15 band).
  //   NO pass 3 any more (owner rule, 2026-10-29: no male voice
  //     ever): when only identifiably-male voices exist for the
  //     language, or no voice exists for it at all, the picker
  //     returns null and the caller does NOT speak — it shows
  //     the voice-unavailable note instead. The browser default
  //     is never left to speak either (it may be male).
  //   A pitch is NEVER lowered anywhere in this picker.
  // A name is always tested FEMALE first: an identifiably-female
  // name can never be reclassified male ("female" itself
  // contains "male"; "Danielle" contains "Daniel"; "Alexandra"
  // contains "Alex"; "Samantha" contains "Sam"). The male test
  // additionally uses a word-boundary match for "male" so a
  // "... Female" voice is never caught by it. The list is
  // cached and refreshed on voiceschanged AND re-read at every
  // speak; an empty list at speak time gets ONE short retry
  // (speakReply, <=350ms) — a first click never waits longer
  // and never stays silent.
  var FEMALE_VOICE_NAME_PARTS = [
    "zira", "jenny", "aria", "samantha", "google us english",
    "karen", "moira", "tessa", "fiona", "veena", "serena",
    "allison", "ava", "susan", "heera", "aditi", "raveena",
    "lekha", "female",
    // v2026-10-23.1 additions (platform voice catalogues —
    // Microsoft Azure / Windows, Apple, Google — see task log):
    "neerja", "swara", "kalpana", "sonia", "libby", "mia",
    "maisie", "emma", "michelle", "hazel", "catherine",
    "natasha", "linda", "erica", "danielle", "alexandra",
    "kanya", "tanisha", "nabanita",
  ];
  // Identifiably-MALE voice names (kept SEPARATE from the female
  // list). Pass 2 skips these; they are NEVER spoken (no male
  // last resort — see the picker contract below).
  var MALE_VOICE_NAME_PARTS = [
    "david", "daniel", "guy", "christopher", "ryan", "mark",
    "alex", "fred", "george", "arthur", "madhur", "hemant",
    "ravi", "james", "richard", "sean", "stefan", "thomas",
    "william", "prabhat", "sameer", "bashkar", "pradeep",
    "davis", "andrew", "brian", "jason", "tony", "eric",
    "diego", "enrique", "jorge", "mathieu",
    "yunyang", "yunjian", "yunye",
  ];
  function voiceNameHas(name, parts) {
    for (var i = 0; i < parts.length; i++) {
      if (name.indexOf(parts[i]) >= 0) return true;
    }
    return false;
  }
  function isFemaleVoiceName(name) {
    return voiceNameHas(name, FEMALE_VOICE_NAME_PARTS);
  }
  function isMaleVoiceName(name) {
    // Female wins every tie (see the note above): a name that
    // reads female is never male, whatever else it contains.
    if (isFemaleVoiceName(name)) return false;
    if (/\bmale\b/.test(name)) return true;
    return voiceNameHas(name, MALE_VOICE_NAME_PARTS);
  }
  var cachedVoices = [];
  function refreshVoices() {
    if (!speechSupported()) return;
    try {
      var vs = window.speechSynthesis.getVoices();
      if (vs && vs.length) cachedVoices = vs;
    } catch (e) {}
  }
  function initVoiceCache() {
    if (!speechSupported()) return;
    refreshVoices();
    try {
      if (typeof window.speechSynthesis.addEventListener === "function") {
        window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
      } else {
        window.speechSynthesis.onvoiceschanged = refreshVoices;
      }
    } catch (e) {}
  }
  // Returns { voice, pitch }: voice is a female-named (pass 1)
  // or unlabelled (pass 2) voice for the language, or null when
  // NO female or unlabelled voice exists for it (empty list,
  // male-only list, or no voice for the language). A null voice
  // means DO NOT SPEAK: the caller shows the voice-unavailable
  // note instead. There is no male fallback and no browser-
  // default fallback — a male voice is never spoken, and the
  // browser default (possibly male) is never left to speak.
  function pickVoiceForLang(langTag) {
    refreshVoices();
    var lang = String(langTag || "").toLowerCase().split("-")[0];
    if (!lang || !cachedVoices.length) return { voice: null, pitch: 1.1 };
    var firstUnlabelled = null;
    for (var i = 0; i < cachedVoices.length; i++) {
      var v = cachedVoices[i];
      var vLang = String(v.lang || "").toLowerCase();
      if (vLang.indexOf(lang) !== 0) continue;
      var name = String(v.name || "").toLowerCase();
      if (isFemaleVoiceName(name)) return { voice: v, pitch: 1.0 };
      if (isMaleVoiceName(name)) continue;
      if (!firstUnlabelled) firstUnlabelled = v;
    }
    if (firstUnlabelled) return { voice: firstUnlabelled, pitch: 1.1 };
    return { voice: null, pitch: 1.1 };
  }

  function speakReply(text, btn) {
    if (!speechSupported() || !text) return;
    if (speakingBtn === btn) {
      stopSpeaking();
      return;
    }
    stopSpeaking();
    var lang = detectTextLang(text) === "bn" ? "bn-BD" : "en-US";
    // Queue sentence by sentence: mobile Chrome silently truncates
    // single very long utterances.
    var parts =
      String(text).replace(/\s+/g, " ").match(/[^.!?।\n]+[.!?।]*\s*/g) || [text];
    var queue = parts
      .map(function (p) { return p.trim(); })
      .filter(function (p) { return p.length > 0; });
    if (!queue.length) queue = [String(text)];
    speakingBtn = btn;
    btn.classList.add("speaking");
    btn.innerHTML = SVG_STOP;
    btn.title = t("stopListening");
    btn.setAttribute("aria-label", t("stopListening"));
    var last = queue.length - 1;
    function doSpeak() {
      // Stopped (or superseded) while waiting for voices: the
      // pending speak must not fire after the user stopped it.
      if (speakingBtn !== btn) return;
      var pick = pickVoiceForLang(lang);
      // Fail-closed (owner rule, no male voice ever): no female
      // or unlabelled voice for this language means DO NOT
      // SPEAK — never a male voice, never the browser default.
      // The text reply stays readable; the note below says
      // plainly why there is no audio.
      if (!pick.voice) {
        stopSpeaking();
        addSystemNotice(t("voiceUnavailable"));
        return;
      }
      queue.forEach(function (part, i) {
        var u = new SpeechSynthesisUtterance(part);
        u.lang = lang;
        u.pitch = pick.pitch;
        if (pick.voice) u.voice = pick.voice;
        if (i === last) {
          u.onend = function () { if (speakingBtn === btn) stopSpeaking(); };
          u.onerror = function () { if (speakingBtn === btn) stopSpeaking(); };
        }
        window.speechSynthesis.speak(u);
      });
    }
    refreshVoices();
    if (cachedVoices.length) { doSpeak(); return; }
    // Empty list at speak time: browsers load voices
    // asynchronously, so wait ONCE, briefly — a voiceschanged
    // fast-path plus a 50ms poll, with a hard ~350ms cap — then
    // doSpeak runs: it speaks only if a female or unlabelled
    // voice was found, otherwise it shows the voice-unavailable
    // note (never a male voice, never the browser default).
    // Never blocked, never a noticeable delay.
    // fireOnce guarantees exactly one speak however the wait
    // resolves, and doSpeak's own guard drops it entirely if
    // the user stopped playback while waiting.
    var fired = false;
    var waitTimer = null;
    var pollTimer = null;
    function fireOnce() {
      if (fired) return;
      fired = true;
      if (pollTimer) clearInterval(pollTimer);
      if (waitTimer) clearTimeout(waitTimer);
      try {
        if (typeof window.speechSynthesis.removeEventListener === "function") {
          window.speechSynthesis.removeEventListener("voiceschanged", onVoicesReady);
        }
      } catch (e) {}
      doSpeak();
    }
    function onVoicesReady() {
      refreshVoices();
      if (cachedVoices.length) fireOnce();
    }
    try {
      if (typeof window.speechSynthesis.addEventListener === "function") {
        window.speechSynthesis.addEventListener("voiceschanged", onVoicesReady);
      }
    } catch (e) {}
    pollTimer = setInterval(onVoicesReady, 50);
    waitTimer = setTimeout(fireOnce, 350);
  }

  function attachSpeakButton(msgEl, text) {
    if (!msgEl || !text || !speechSupported()) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rbai-speak";
    btn.innerHTML = SVG_SPEAK;
    btn.title = t("listenReply");
    btn.setAttribute("aria-label", t("listenReply"));
    btn.addEventListener("click", function () {
      speakReply(text, btn);
    });
    msgEl.appendChild(btn);
  }

  function addImageMessage(dataUrl) {
    var messages = document.getElementById("rbai-widget-messages");
    var msg = document.createElement("div");
    msg.className = "rbai-msg user rbai-img-msg";
    var img = document.createElement("img");
    img.src = dataUrl;
    img.alt = t("sentPhotoAlt");
    msg.appendChild(img);
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  // ---- Subscription paused state (HTTP 402 {error:'subscription_paused'}) ----
  // A distinct, friendly notice: no AI reply, inputs disabled so no further
  // requests (and no spend) happen until the business reactivates.
  function showPausedState() {
    if (isPaused) return;
    isPaused = true;
    ["rbai-widget-text", "rbai-widget-send", "rbai-widget-photo", "rbai-widget-video", "rbai-widget-mic"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = true;
    });
    if (document.getElementById("rbai-paused-notice")) return;
    var messages = document.getElementById("rbai-widget-messages");
    var notice = document.createElement("div");
    notice.id = "rbai-paused-notice";

    var icon = document.createElement("div");
    icon.className = "rbai-paused-icon";
    icon.innerHTML = SVG_PAUSE;
    notice.appendChild(icon);

    var title = document.createElement("h4");
    title.textContent = t("pausedTitle");
    notice.appendChild(title);

    var text = document.createElement("p");
    text.textContent = t("pausedBody");
    notice.appendChild(text);

    var retry = document.createElement("button");
    retry.id = "rbai-paused-retry";
    retry.type = "button";
    retry.textContent = t("tryAgain");
    retry.onclick = clearPausedState;
    notice.appendChild(retry);

    messages.appendChild(notice);
    messages.scrollTop = messages.scrollHeight;
  }

  function clearPausedState() {
    isPaused = false;
    ["rbai-widget-text", "rbai-widget-send", "rbai-widget-photo", "rbai-widget-video", "rbai-widget-mic"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = false;
    });
    var notice = document.getElementById("rbai-paused-notice");
    if (notice) notice.remove();
  }

  // ---- Product cards (Phase 3, user decision 10) ----
  // Built with DOM APIs (textContent) — never innerHTML with product data —
  // so a malicious catalog entry cannot inject markup into a visitor's page.
  function formatPrice(p) {
    if (p.price === null || p.price === undefined || p.price === "") return "";
    return (p.currency ? p.currency + " " : "") + p.price;
  }

  function renderProductCards(products) {
    var messages = document.getElementById("rbai-widget-messages");
    var wrap = document.createElement("div");
    wrap.className = "rbai-cards";
    (products || []).slice(0, 3).forEach(function (p) {
      var card = document.createElement("div");
      card.className = "rbai-card";

      if (p.imageUrl) {
        var img = document.createElement("img");
        img.className = "rbai-card-img";
        img.alt = p.name || t("productFallback");
        img.src = p.imageUrl;
        img.onerror = function () { this.style.display = "none"; };
        card.appendChild(img);
      }

      var body = document.createElement("div");
      body.className = "rbai-card-body";

      var name = document.createElement("div");
      name.className = "rbai-card-name";
      name.textContent = p.name || t("productFallback");
      body.appendChild(name);

      var priceText = formatPrice(p);
      if (priceText) {
        var price = document.createElement("div");
        price.className = "rbai-card-price";
        price.textContent = priceText;
        body.appendChild(price);
      }

      if (p.description) {
        var desc = document.createElement("div");
        desc.className = "rbai-card-desc";
        desc.textContent = p.description;
        body.appendChild(desc);
      }

      var btn = document.createElement("button");
      btn.className = "rbai-order-btn";
      btn.type = "button";
      btn.textContent = t("order");
      btn.onclick = (function (productName) {
        return function () { orderProduct(productName); };
      })(p.name || "this item");
      body.appendChild(btn);

      card.appendChild(body);
      wrap.appendChild(card);
    });
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }

  // The Order button starts the Phase 2 order flow: the AI collects the
  // business's required order fields conversationally from here.
  function orderProduct(productName) {
    if (isPaused) return;
    sendText("I would like to order: " + productName);
  }

  // ---- Live activity polling ----
  // While any request is in flight, poll the activity endpoint so the
  // caption tracks what the agent is really doing server-side. Polling
  // stops the moment the last pending request settles — it never runs
  // while the widget is idle.
  function pollActivity() {
    var q =
      "siteKey=" + encodeURIComponent(config.siteKey) +
      "&token=" + encodeURIComponent(activityToken) +
      (conversationId ? "&conversationId=" + encodeURIComponent(conversationId) : "") +
      (config.visitorId ? "&visitorId=" + encodeURIComponent(config.visitorId) : "");
    fetch(config.server + "/api/chat/activity?" + q)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        currentActivity = (data && data.activity) || null;
        // A live server activity is a sign of life for the
        // in-flight turn (progress-aware watchdog).
        if (currentActivity) noteTurnProgress();
        renderStatus();
      })
      .catch(function () { /* caption keeps its last honest state */ });
  }

  function startActivityPolling() {
    if (activityTimer) return;
    pollActivity();
    // 2 s cadence (was 1.2 s): the caption still tracks the turn
    // closely, and each poll is now a single-doc read server-side.
    // Polling still runs ONLY while a request is in flight.
    activityTimer = setInterval(pollActivity, 2000);
  }

  function stopActivityPolling() {
    if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
    currentActivity = null;
    renderStatus();
  }

  // ---- Thread sync (human handoff) ----
  // Polls GET /api/chat/thread while the panel is open. Assistant-side
  // messages the tab has not rendered yet (a human's Inbox replies,
  // above all) are appended in order. Customer-side messages are only
  // rendered on the first sync of a restored conversation (history);
  // during live polling they are this tab's own echoes.
  function syncThread() {
    if (!conversationId || !config.siteKey || !config.visitorId) {
      return Promise.resolve();
    }
    if (threadSyncInFlight) return threadSyncInFlight;
    var q =
      "siteKey=" + encodeURIComponent(config.siteKey) +
      "&conversationId=" + encodeURIComponent(conversationId) +
      "&visitorId=" + encodeURIComponent(config.visitorId);
    if (lastThreadTs) {
      // 2 s overlap: safe because rendered messages dedupe by id.
      q += "&since=" + encodeURIComponent(new Date(Date.parse(lastThreadTs) - 2000).toISOString());
    }
    var promise = fetch(config.server + "/api/chat/thread?" + q)
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.messages) return;
        var initial = !threadSyncedOnce;
        threadSyncedOnce = true;
        data.messages.forEach(function (m) {
          if (!m || !m.id || seenRemoteIds[m.id]) return;
          // Duplicate-reply guard (agent-quality D1): while any local
          // request is in flight, never render an assistant message
          // from the thread here. The engine saves the turn's reply
          // BEFORE the response reaches this tab, so a poll processed
          // in that window rendered the reply once — and the response
          // handler then rendered it a second time, because the
          // pendingEcho for the reply is only registered when the
          // response itself is handled (too late for a poll that
          // lands first). Deferring WITHOUT marking the id seen is
          // safe in every ordering: a poll processed before the
          // response handler still sees pendingRequests > 0 and
          // skips, and a poll processed after it finds the
          // registered echo below and consumes the message instead.
          // Assistant replies from a human (Inbox) that arrive
          // mid-turn are deferred the same way and render on the
          // first poll after the turn settles.
          if (m.role !== "customer" && pendingRequests > 0) return;
          // Advance the delta cursor from this processed message.
          // (Deferred messages above deliberately do not advance it:
          // they must be re-fetched after the turn settles, exactly as
          // the duplicate-reply guard intends.)
          if (m.createdAt) {
            var mTs = Date.parse(m.createdAt);
            if (!isNaN(mTs) && (!lastThreadTs || mTs > Date.parse(lastThreadTs))) {
              lastThreadTs = new Date(mTs).toISOString();
            }
          }
          // Consume a local echo instead of rendering a duplicate.
          for (var i = 0; i < pendingEcho.length; i++) {
            if (pendingEcho[i].role === m.role && pendingEcho[i].content === m.content) {
              pendingEcho.splice(i, 1);
              seenRemoteIds[m.id] = true;
              return;
            }
          }
          seenRemoteIds[m.id] = true;
          if (m.role === "customer" && !initial) return;
          if (m.role !== "customer") {
            // A restored or human-written thread also speaks the
            // conversation's language — chrome follows it.
            var threadLang = detectTextLang(m.content);
            if (threadLang) setUiLang(threadLang);
          }
          var renderedMsg = addMessage(m.content, m.role === "customer" ? "user" : "bot");
          threadRenderedCount++;
          if (m.role !== "customer") attachSpeakButton(renderedMsg, m.content);
        });
      })
      .catch(function () {});
    threadSyncInFlight = promise;
    promise.then(
      function () { if (threadSyncInFlight === promise) threadSyncInFlight = null; },
      function () { if (threadSyncInFlight === promise) threadSyncInFlight = null; }
    );
    return promise;
  }

  // Adaptive scheduler (v2026-10-23.3): a timeout chain instead of a
  // fixed interval. Each completed sync re-arms the next one — fast
  // when something just rendered, backing off ×1.6 while idle up to
  // the 30 s cap. Hidden tabs do not poll at all: the timer is
  // cleared on hide and an immediate sync runs on show (see the
  // visibilitychange hook below). Panel open/close still starts and
  // stops the whole loop via startThreadSync/stopThreadSync.
  function scheduleThreadSync() {
    if (!threadSyncActive) return;
    if (threadTimer) clearTimeout(threadTimer);
    threadTimer = setTimeout(runThreadSyncTick, threadDelayMs);
  }

  function runThreadSyncTick() {
    threadTimer = null;
    if (!threadSyncActive) return;
    if (typeof document !== "undefined" && document.hidden) {
      // Paused while hidden; visibilitychange re-arms on return.
      return;
    }
    var before = threadRenderedCount;
    syncThread().then(function () {
      if (!threadSyncActive) return;
      if (threadRenderedCount > before) {
        // A human reply (or restored history) just landed — stay
        // fast, the conversation is live right now.
        threadDelayMs = THREAD_SYNC_FAST_MS;
      } else {
        threadDelayMs = Math.min(
          THREAD_SYNC_MAX_MS,
          Math.round(threadDelayMs * 1.6)
        );
      }
      scheduleThreadSync();
    });
  }

  function startThreadSync() {
    if (threadSyncActive) return;
    threadSyncActive = true;
    threadDelayMs = THREAD_SYNC_FAST_MS;
    // Immediate sync on open (unchanged behaviour), then the
    // adaptive chain takes over.
    var before = threadRenderedCount;
    syncThread().then(function () {
      if (threadRenderedCount > before) {
        threadDelayMs = THREAD_SYNC_FAST_MS;
      }
      scheduleThreadSync();
    });
  }

  function stopThreadSync() {
    threadSyncActive = false;
    if (threadTimer) {
      clearTimeout(threadTimer);
      threadTimer = null;
    }
  }

  // A settled local turn is the moment a handoff state change (or a
  // human's fast reply) is most likely: sync once immediately and
  // return to the fast cadence. Called from settleRequest only —
  // the send path itself is never delayed by polling.
  function pokeThreadSync() {
    if (!threadSyncActive) return;
    threadDelayMs = THREAD_SYNC_FAST_MS;
    var before = threadRenderedCount;
    syncThread().then(function () {
      if (threadRenderedCount > before) {
        threadDelayMs = THREAD_SYNC_FAST_MS;
      }
      scheduleThreadSync();
    });
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", function () {
      if (!threadSyncActive) return;
      if (document.hidden) {
        if (threadTimer) {
          clearTimeout(threadTimer);
          threadTimer = null;
        }
      } else if (isOpen) {
        // Back in view: catch up at once, fast cadence resumes.
        threadDelayMs = THREAD_SYNC_FAST_MS;
        var before = threadRenderedCount;
        syncThread().then(function () {
          if (threadRenderedCount > before) {
            threadDelayMs = THREAD_SYNC_FAST_MS;
          }
          scheduleThreadSync();
        });
      }
    });
  }

  // ---- Shared API plumbing ----
  function postApi(path, payload, typing) {
    startActivityPolling();
    fetch(config.server + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(
          function (data) { return { status: res.status, data: data }; },
          function () { return { status: res.status, data: null }; }
        );
      })
      .then(function (r) { handleApiResponse(r.data, r.status, typing); })
      .catch(function () { handleApiResponse(null, 0, typing); });
  }

  // Settle one in-flight request: drop its typing bubble and, when
  // the last pending request finishes, settle the agent and stop
  // the activity polling. Shared by the JSON and streaming paths.
  // `succeeded` marks a SUCCESS terminal (a real reply fully
  // delivered): the agent then plays the completion clip once
  // before settling to idle. Anything else — errors, gates,
  // silence, aborts — settles straight to idle: no happy pose
  // on a failure.
  function settleRequest(typing, succeeded) {
    if (typing) { typing.remove(); renderStatus(); }
    pendingRequests = Math.max(0, pendingRequests - 1);
    if (pendingRequests === 0) {
      setAgentState(succeeded ? "done" : "idle");
      stopActivityPolling();
      pokeThreadSync();
    }
  }

  function handleApiResponse(data, status, typing, streamBubble) {
    // Success = a reply delivered through the normal success
    // shape. Every gate/error/silent outcome below settles
    // straight to idle instead (see settleRequest).
    var succeeded =
      !!data &&
      status !== 401 &&
      status !== 402 &&
      data.error !== "subscription_paused" &&
      data.error !== "message_limit_reached" &&
      !data.error &&
      !data.silent &&
      typeof data.response === "string" &&
      data.response.length > 0;
    settleRequest(typing, succeeded);

    if (!data) {
      // Genuine transport failure only (network down / unreadable
      // response). Server-side states are handled below and must never
      // be mislabeled as a connection error.
      addMessage(t("connError"), "bot");
      return;
    }
    // Subscription hard-stop: dedicated paused state, nothing else.
    if (status === 402 || data.error === "subscription_paused") {
      showPausedState();
      return;
    }
    if (status === 401) {
      addMessage(t("notConfigured"), "bot");
      return;
    }
    if (data.error === "message_limit_reached") {
      addMessage(t("limitReached"), "bot");
      return;
    }
    if (data.conversationId) {
      // A different conversation must not inherit the delta cursor of
      // the previous one (its history predates the cursor).
      if (conversationId && data.conversationId !== conversationId) {
        lastThreadTs = null;
      }
      conversationId = data.conversationId;
      storeSet("conv", conversationId);
    }
    // Human takeover: pure silence — render nothing at all.
    if (data.silent) return;
    if (data.response) {
      // The reply's own language is a conversation-language signal:
      // chrome follows it (e.g. a voice/photo turn with no typed text).
      var replyLang = detectTextLang(data.response);
      if (replyLang) setUiLang(replyLang);
      pendingEcho.push({ role: "assistant", content: data.response });
      // A streamed reply reuses its live bubble: the done payload's
      // response text is authoritative (it can carry suffixes the
      // token stream never saw, e.g. a review ask).
      if (streamBubble) {
        streamBubble.textContent = data.response;
        attachSpeakButton(streamBubble, data.response);
      } else {
        attachSpeakButton(addMessage(data.response, "bot"), data.response);
      }
    } else if (data.error) {
      // Never render a raw server error text (they are English-only);
      // known ones map to their localized chrome string, unknown ones
      // to the localized generic.
      addMessage(localizeServerError(data.error) || t("processError"), "bot");
    } else {
      addMessage(t("processError"), "bot");
    }
    if (data.products && data.products.length) {
      renderProductCards(data.products);
    }
  }

  function sendText(text) {
    text = (text || "").trim();
    if (!text || isPaused) return;

    addMessage(text, "user");
    pendingEcho.push({ role: "customer", content: text });
    pendingRequests++;
    setAgentState("working");

    var typing = addMessage(t("typing"), "bot typing");

    var payload = {
      message: text,
      conversationId: conversationId,
      siteKey: config.siteKey,
      visitorId: config.visitorId,
      activityToken: activityToken,
    };
    // Streaming first (the reply renders as it is generated); browsers
    // without fetch-stream support keep the plain JSON path.
    if (typeof ReadableStream !== "undefined" && typeof TextDecoder !== "undefined") {
      sendTextStreaming(payload, typing);
    } else {
      postApi("/api/chat/widget", payload, typing);
    }
  }

  // ---- Streaming send (SSE) ----
  // Asks the endpoint for a token stream. The typing bubble is removed
  // the moment the FIRST token arrives and the reply grows in place;
  // the working-state avatar + activity captions keep running until
  // the terminal done event settles the request (tool rounds can still
  // be working after a retracted preamble). If the answer is not SSE
  // (a gate error, or an older server), it is handled as plain JSON —
  // and there is deliberately NO retry: the message was already sent.
  function sendTextStreaming(payload, typing) {
    startActivityPolling();
    var bubble = null;
    var streamed = "";
    var currentTyping = typing;
    payload.stream = true;
    fetch(config.server + "/api/chat/widget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        var contentType = res.headers.get("content-type") || "";
        if (contentType.indexOf("text/event-stream") === -1 || !res.body) {
          return res.json().then(
            function (data) { handleApiResponse(data, res.status, currentTyping); },
            function () { handleApiResponse(null, res.status, currentTyping); }
          );
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        var doneData = null;
        var errorData = null;

        function scrollToBottom() {
          var messages = document.getElementById("rbai-widget-messages");
          if (messages) messages.scrollTop = messages.scrollHeight;
        }

        function handleEvent(raw) {
          var event = "message";
          var dataStr = "";
          raw.split("\n").forEach(function (line) {
            if (line.indexOf("event:") === 0) event = line.slice(6).trim();
            else if (line.indexOf("data:") === 0) dataStr += line.slice(5).trim();
          });
          if (!dataStr) return;
          var data = null;
          try { data = JSON.parse(dataStr); } catch (e) { return; }
          if (event === "token" && data.text) {
            noteTurnProgress();
            if (!bubble) {
              if (currentTyping) { currentTyping.remove(); currentTyping = null; renderStatus(); }
              bubble = addMessage("", "bot");
            }
            streamed += data.text;
            bubble.textContent = streamed;
            scrollToBottom();
          } else if (event === "retract") {
            noteTurnProgress();
            // The streamed text preceded tool calls — discard it.
            // Re-audit #2 TYPING LAW (owner 2026-10-22): the typing
            // bubble must NEVER re-appear after the first token of a
            // turn — the previous code re-added it here, which read
            // as a second "typing…" at the END of the turn. The
            // mascot working state (driven by pendingRequests) keeps
            // signalling genuine in-flight tool work on its own.
            if (bubble) { bubble.remove(); bubble = null; streamed = ""; }
          } else if (event === "done") {
            doneData = data;
          } else if (event === "error") {
            errorData = data;
          }
        }

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buffer += decoder.decode(r.value, { stream: true });
            var idx = buffer.indexOf("\n\n");
            while (idx >= 0) {
              handleEvent(buffer.slice(0, idx));
              buffer = buffer.slice(idx + 2);
              idx = buffer.indexOf("\n\n");
            }
            return pump();
          });
        }

        return pump().then(function () {
          if (buffer.trim()) handleEvent(buffer);
          if (doneData) {
            handleApiResponse(doneData, 200, currentTyping, bubble);
          } else if (errorData) {
            handleApiResponse(errorData, 500, currentTyping);
          } else if (bubble) {
            // The stream ended abruptly after tokens: drop the partial
            // bubble and settle silently — if the turn completed
            // server-side, the thread sync renders the saved reply;
            // a kept partial would duplicate it.
            bubble.remove();
            settleRequest(currentTyping);
          } else {
            handleApiResponse(null, 0, currentTyping);
          }
        });
      })
      .catch(function () {
        if (bubble) {
          bubble.remove();
          settleRequest(currentTyping);
        } else {
          handleApiResponse(null, 0, currentTyping);
        }
      });
  }

  // Compose auto-grow (owner directive 2026-10-22): the message box
  // was a fixed single-line input — editing a long message in it was
  // painful. The textarea now grows with its content up to ~45% of
  // the panel height, then scrolls internally; sendMessage resets it
  // to one line. The message list above is untouched.
  //
  // Composer fix (v2026-10-22.11, owner screenshot): the empty box
  // must rest at EXACTLY one line. scrollHeight must never size the
  // EMPTY box: for an empty textarea the browser reports the
  // PLACEHOLDER's height there, and the placeholder wraps at phone
  // widths — measured in Chromium (390px viewport, the widget's
  // ~141px-wide composer): empty scrollHeight 61px against a true
  // one-line clientHeight of 40px, i.e. every send/clear "reset"
  // actually landed on the wrapped placeholder's height, and any
  // taller placeholder wrap (narrower box, device font) inflates it
  // further. The empty height is therefore computed from the box's
  // own line metrics: line-height + vertical padding + borders
  // (= 42px border-box at the shipped metrics).
  function restHeightPx(input) {
    var cs = null;
    try { cs = window.getComputedStyle ? window.getComputedStyle(input) : null; } catch (e) {}
    function px(v) { var n = parseFloat(v); return n > 0 ? n : 0; }
    var lineHeight = cs ? px(cs.lineHeight) : 0;
    if (!lineHeight) lineHeight = (cs && px(cs.fontSize) ? px(cs.fontSize) : 14) * 1.45;
    return Math.round(lineHeight + px(cs && cs.paddingTop) + px(cs && cs.paddingBottom) +
      px(cs && cs.borderTopWidth) + px(cs && cs.borderBottomWidth));
  }

  function autoGrowInput() {
    var input = document.getElementById("rbai-widget-text");
    if (!input) return;
    if (!input.value) {
      // Empty (rest / just sent / just cleared): slim one line,
      // sized from line metrics — never from placeholder-inflated
      // scrollHeight.
      input.style.height = restHeightPx(input) + "px";
      input.style.overflowY = "hidden";
      return;
    }
    input.style.height = "auto";
    var panel = document.getElementById("rbai-widget-panel");
    var cap = panel && panel.clientHeight
      ? Math.floor(panel.clientHeight * 0.45)
      : 160;
    var full = input.scrollHeight;
    input.style.height = Math.min(full, cap) + "px";
    input.style.overflowY = full > cap ? "auto" : "hidden";
  }

  // Panel-open reset (v2026-10-22.11): the panel must ALWAYS open
  // with the slim one-line box — no sizing ran on open before, so a
  // height grown (or inflated) earlier in the page's lifetime was
  // what greeted the visitor, even with the box empty. A preserved
  // draft keeps its TEXT (unsent words are the visitor's — opening
  // a panel must never delete them) but not its height: the box
  // reopens slim, the draft scrolls inside the one-line box, and
  // the visitor's next input event re-grows it via autoGrowInput.
  function resetComposerOnOpen() {
    var input = document.getElementById("rbai-widget-text");
    if (!input) return;
    input.style.height = restHeightPx(input) + "px";
    input.style.overflowY = input.value ? "auto" : "hidden";
    input.scrollTop = 0;
  }

  function sendMessage() {
    var input = document.getElementById("rbai-widget-text");
    var text = input.value;
    input.value = "";
    autoGrowInput();
    // The visitor's own typed language sets the conversation language
    // for all chrome from this turn on.
    var typedLang = detectTextLang(text);
    if (typedLang) setUiLang(typedLang);
    sendText(text);
  }

  // ---- Photo upload -> /api/chat/vision ----
  function uploadPhoto(file) {
    if (!file || isPaused) return;
    if (file.size > MAX_IMAGE_BYTES) {
      addMessage(t("photoTooLarge"), "bot");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result || "");
      var base64 = dataUrl.split(",")[1] || "";
      if (!base64) {
        addMessage(t("photoReadError"), "bot");
        return;
      }
      addImageMessage(dataUrl);
      pendingRequests++;
      setAgentState("working");
      var typing = addMessage(t("lookingPhoto"), "bot typing");
      postApi("/api/chat/vision", {
        siteKey: config.siteKey,
        visitorId: config.visitorId,
        conversationId: conversationId,
        activityToken: activityToken,
        image: { mimeType: file.type || "image/jpeg", base64: base64 },
      }, typing);
    };
    reader.onerror = function () {
      addMessage(t("photoReadError"), "bot");
    };
    reader.readAsDataURL(file);
  }

  // ---- Video upload -> /api/chat/vision ----
  // Media fix 2026-10-22 (shipped with embed v2026-10-22.2):
  // the server has no ffmpeg
  // (serverless), so a raw video upload can never be perceived
  // there. The browser CAN decode the file it was handed — capture
  // frames at ~10%/50%/90% as JPEGs and post them as `frames`; the
  // server perceives the frames like photos and synthesizes the
  // answer. If extraction fails for any reason, fall back to the
  // legacy raw-video upload (uploadVideoRaw below).
  function uploadVideo(file) {
    if (!file || isPaused) return;
    if (file.size > MAX_MEDIA_BYTES) {
      addMessage(t("videoTooLarge"), "bot");
      return;
    }
    // The turn counts as working from NOW: frame extraction is
    // local decode time (up to the 15s extraction timeout) and
    // the visitor must see the working clip + caption for it, not
    // the idle clip. Both branches below settle this one pending
    // request (postApi on success, settleRequest on read errors).
    pendingRequests++;
    setAgentState("working");
    extractVideoFrames(file, function (frames) {
      if (frames && frames.length) {
        addMessage(t("videoSent"), "user");
        var typing = addMessage(t("watchingVideo"), "bot typing");
        postApi("/api/chat/vision", {
          siteKey: config.siteKey,
          visitorId: config.visitorId,
          conversationId: conversationId,
          activityToken: activityToken,
          frames: frames,
        }, typing);
        return;
      }
      uploadVideoRaw(file);
    });
  }

  function extractVideoFrames(file, done) {
    var url;
    try { url = URL.createObjectURL(file); } catch (e) { done(null); return; }
    var video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    var finished = false;
    function finish(frames) {
      if (finished) return;
      finished = true;
      try { URL.revokeObjectURL(url); } catch (e) {}
      done(frames);
    }
    var timer = setTimeout(function () { finish(null); }, 15000);
    video.onerror = function () { clearTimeout(timer); finish(null); };
    video.onloadedmetadata = function () {
      var dur = video.duration;
      if (!dur || !isFinite(dur)) { clearTimeout(timer); finish(null); return; }
      var times = [0.1, 0.5, 0.9].map(function (f) {
        return Math.min(Math.max(dur * f, 0), Math.max(dur - 0.1, 0));
      });
      var frames = [];
      var idx = 0;
      video.onseeked = function () {
        try {
          var canvas = document.createElement("canvas");
          var scale = Math.min(1, 640 / (video.videoWidth || 640));
          canvas.width = Math.max(1, Math.round((video.videoWidth || 640) * scale));
          canvas.height = Math.max(1, Math.round((video.videoHeight || 360) * scale));
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          var base64 = (canvas.toDataURL("image/jpeg", 0.82).split(",")[1] || "");
          if (base64) frames.push({ mimeType: "image/jpeg", base64: base64 });
        } catch (e) { /* frame skipped */ }
        idx++;
        if (idx < times.length) {
          try { video.currentTime = times[idx]; } catch (e) { clearTimeout(timer); finish(frames.length ? frames : null); }
        } else {
          clearTimeout(timer);
          finish(frames.length ? frames : null);
        }
      };
      try { video.currentTime = times[0]; } catch (e) { clearTimeout(timer); finish(null); }
    };
    try { video.load(); } catch (e) {}
  }

  function uploadVideoRaw(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result || "");
      var base64 = dataUrl.split(",")[1] || "";
      if (!base64) {
        settleRequest(null);
        addMessage(t("videoReadError"), "bot");
        return;
      }
      addMessage(t("videoSent"), "user");
      var typing = addMessage(t("watchingVideo"), "bot typing");
      postApi("/api/chat/vision", {
        siteKey: config.siteKey,
        visitorId: config.visitorId,
        conversationId: conversationId,
        activityToken: activityToken,
        video: { mimeType: file.type || "video/mp4", base64: base64 },
      }, typing);
    };
    reader.onerror = function () {
      // uploadVideo already counted this turn as pending; settle
      // it here or the agent would stay in the working state.
      settleRequest(null);
      addMessage(t("videoReadError"), "bot");
    };
    reader.readAsDataURL(file);
  }

  // ---- Voice messages -> /api/chat/voice ----
  var mediaRecorder = null;
  var audioChunks = [];
  var isRecording = false;

  function setRecordingUI(on) {
    isRecording = on;
    var btn = document.getElementById("rbai-widget-mic");
    if (btn) btn.classList.toggle("recording", on);
  }

  function toggleRecording() {
    if (isPaused) return;
    if (isRecording) {
      try { mediaRecorder.stop(); } catch (e) { setRecordingUI(false); }
      return;
    }
    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      addSystemNotice(t("voiceUnsupported"));
      return;
    }
    // Re-audit #2 (owner report 2026-10-22): pre-flight the
    // microphone permission state BEFORE calling getUserMedia.
    // When permission is already denied — by the host page's
    // Permissions-Policy, the browser's site settings, or a prior
    // denial — getUserMedia rejects instantly and NO prompt is
    // ever shown; the old code surfaced that as a fake agent reply
    // ("মাইক্রোফোন ব্যবহারের অনুমতি পাইনি…"). A denied state now
    // renders a brief SYSTEM NOTICE saying it is blocked and how
    // to allow it. 'prompt'/'granted' fall through to getUserMedia,
    // where the browser shows its real prompt. The Permissions API
    // is not universal (and can throw for this name), so any doubt
    // also falls through to getUserMedia.
    var startCapture = function () {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      audioChunks = [];
      try {
        mediaRecorder = new MediaRecorder(stream);
      } catch (e) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        addSystemNotice(t("recordingUnsupported"));
        return;
      }
      mediaRecorder.ondataavailable = function (e) {
        if (e.data && e.data.size) audioChunks.push(e.data);
      };
      mediaRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        setRecordingUI(false);
        var mimeType = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
        var blob = new Blob(audioChunks, { type: mimeType });
        if (!blob.size) {
          addSystemNotice(t("recordingEmpty"));
          return;
        }
        if (blob.size > MAX_MEDIA_BYTES) {
          addSystemNotice(t("recordingTooLong"));
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var base64 = String(reader.result || "").split(",")[1] || "";
          if (!base64) {
            addSystemNotice(t("recordingProcessError"));
            return;
          }
          addMessage(t("voiceSent"), "user");
          pendingRequests++;
          setAgentState("working");
          var typing = addMessage(t("listening"), "bot typing");
          postApi("/api/chat/voice", {
            siteKey: config.siteKey,
            visitorId: config.visitorId,
            conversationId: conversationId,
            activityToken: activityToken,
            audio: { mimeType: mimeType, base64: base64 },
          }, typing);
        };
        reader.readAsDataURL(blob);
      };
      mediaRecorder.start();
      setRecordingUI(true);
    }).catch(function (err) {
      // Split by DOMException name instead of one generic bubble:
      // NotAllowedError = the visitor (or the browser/OS) denied the
      // permission — the case behind the owner's screenshot, where
      // getUserMedia itself was called correctly ({audio:true} on a
      // secure origin) and the promise rejected. NotFoundError = no
      // microphone exists; NotReadableError = the device is busy.
      var errName = (err && err.name) || "";
      if (errName === "NotFoundError" || errName === "OverconstrainedError") {
        addSystemNotice(t("micNotFound"));
      } else if (errName === "NotReadableError" || errName === "AbortError") {
        addSystemNotice(t("micBusy"));
      } else {
        addSystemNotice(t("micDenied"));
      }
    });
    };
    if (navigator.permissions && navigator.permissions.query) {
      try {
        navigator.permissions
          .query({ name: "microphone" })
          .then(function (status) {
            if (status && status.state === "denied") {
              addSystemNotice(t("micBlocked"));
            } else {
              startCapture();
            }
          })
          .catch(function () {
            startCapture();
          });
      } catch (e) {
        startCapture();
      }
    } else {
      startCapture();
    }
  }

  // ---- Inline mode (help-center pages) ----
  // A page that renders the mount element (default "#rbai-chat-inline",
  // or the selector in data-inline-target) gets the chat as an
  // always-open box inside that element instead of the floating bubble;
  // every other page keeps the floating widget. A MutationObserver
  // follows SPA route changes: when the mount appears the container
  // moves into it, and when it disappears the container is rescued back
  // to <body>, so the widget is never lost with a routed-away page and
  // two chat surfaces never coexist.
  function findInlineMount() {
    if (!config.inlineTarget) return null;
    try { return document.querySelector(config.inlineTarget); } catch (e) { return null; }
  }

  function openPanelInPlace() {
    // The floating widget's first-open behaviour (see toggleWidget):
    // working clip lazy-load, greeting for a brand-new thread only,
    // thread sync so human replies land in this box too.
    var panel = document.getElementById("rbai-widget-panel");
    isOpen = true;
    if (panel) panel.classList.add("open");
    // Inline panels follow the same rule: slim one-line composer.
    resetComposerOnOpen();
    ensureWorkingVideo();
    // The container was just (re)moved into the inline mount —
    // DOM moves can pause a media element, so re-kick the active
    // clip in its new home.
    kickActiveVideos();
    if (!conversationId && !document.querySelector(".rbai-msg")) {
      addMessage(greetingIsDefault ? t("greeting") : config.greeting, "bot");
    }
    startThreadSync();
  }

  function enterInline(mount) {
    if (!widgetContainer) return;
    if (inlineActive && widgetContainer.parentElement === mount) return;
    inlineActive = true;
    widgetContainer.classList.add("rbai-inline");
    // Inline layout owns the container's position while mounted;
    // the visitor's dragged spot is remembered, not lost.
    clearBubbleInlinePos();
    mount.appendChild(widgetContainer);
    openPanelInPlace();
  }

  function exitInline() {
    if (!widgetContainer || !inlineActive) return;
    inlineActive = false;
    widgetContainer.classList.remove("rbai-inline");
    if (document.body && !document.body.contains(widgetContainer)) {
      document.body.appendChild(widgetContainer);
    }
    // Back to floating: restore the visitor's dragged spot if any.
    preOpenPos = null;
    if (bubblePos) applyBubblePos(bubblePos.left, bubblePos.top, false);
    isOpen = false;
    var panel = document.getElementById("rbai-widget-panel");
    if (panel) panel.classList.remove("open");
    stopThreadSync();
  }

  function syncInlineMount() {
    var mount = findInlineMount();
    if (mount) enterInline(mount);
    else if (inlineActive) exitInline();
    // data-mode="inline" with no mount found keeps the floating
    // bubble: a help page must never end up with no chat at all.
  }

  function startInlineObserver() {
    if (typeof MutationObserver === "undefined" || !document.body) return;
    var observer = new MutationObserver(function () { syncInlineMount(); });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Voice list warm-up: browsers load speech voices
  // asynchronously; start listening for them at init so the
  // first spoken reply already knows the device's female voice.
  initVoiceCache();

  // The brand fetch fires at once and never blocks the render:
  // the widget builds instantly from the defaults and the live
  // markup is swapped only when the record actually answers.
  fetchAgentBrand();

  // Initialize
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      createStyles();
      createWidget();
      startInlineObserver();
    });
  } else {
    createStyles();
    createWidget();
    startInlineObserver();
  }
})();
