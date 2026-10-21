/**
 * Ride Bangla AI Agent - Live Chat Widget
 * CANONICAL EMBED — v2026-10-22.1 (NEW: every widget chrome string is
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
 * bust-framed (head + shoulders, face centred — the served
 * agent-avatar.png is a distant full-body shot) and the working clip's
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
    title: script.getAttribute("data-title") || "Ride Bangla AI Agent",
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

  var avatarUrl = config.server.replace(/\/$/, "") + "/agent-avatar.png";
  var idleVideoUrl = config.server.replace(/\/$/, "") + "/agent-idle.mp4";
  var workingVideoUrl = config.server.replace(/\/$/, "") + "/agent-working.mp4";
  var agentState = "idle";
  var pendingRequests = 0;

  var isOpen = false;
  var widgetContainer = null;
  var inlineActive = false;

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

  // Mascot framing (owner reference 2026-10-22: BUST — head +
  // shoulders, face centred). Measured on the served assets:
  // agent-avatar.png is 1024x1024 with the full-body figure occupying
  // only x 27-73% / y 18-90% (a distant shot), so as a plain cover-fit
  // still it renders tiny; the fallback <img> is therefore scaled to
  // 178% and offset (-39%, -14%), which crops the visible square to
  // x 22-78% / y 8-64% of the artwork — head + shoulders, face centred.
  // The clips are 480x854 full-scene: in a square slot, cover-fit shows
  // a 56%-of-height band; the idle figure's head sits at y 19-38%, so
  // object-position 17% centres that band on the bust; the working
  // scene's mascot head sits higher (y 8-40%), hence 8%. Launcher
  // (56px) and header (36px) wrap sizes are unchanged.
  function createStyles() {
    var style = document.createElement("style");
    style.textContent = "\n\
      #rbai-widget-container{position:fixed;bottom:20px;" + config.position + ":20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}\n\
      #rbai-widget-btn{width:56px;height:56px;border-radius:50%;background:" + config.color + ";border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:transform .2s}\n\
      #rbai-widget-btn:hover{transform:scale(1.05)}\n\
      #rbai-widget-btn{overflow:hidden;padding:0}\n\.rbai-avatarwrap{position:relative;display:block;overflow:hidden;background:#fff}\n\#rbai-widget-btn .rbai-avatarwrap{width:56px;height:56px;border-radius:50%}\n\#rbai-widget-header .rbai-avatarwrap{width:36px;height:36px;border-radius:50%;margin-right:10px;flex:none}\n\.rbai-vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;pointer-events:none}\n\.rbai-vid.active{display:block}\n\.rbai-avatar-fallback{position:absolute;left:-39%;top:-14%;width:178%;height:178%;max-width:none;object-fit:cover;display:none}\n\.rbai-avatarwrap.novid .rbai-avatar-fallback{display:block}\n\.rbai-avatarwrap.novid .rbai-vid{display:none!important}\n\#rbai-widget-headwrap{display:flex;align-items:center}\n\
      #rbai-widget-panel{display:none;width:370px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 100px);background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.12);margin-bottom:12px;overflow:hidden;flex-direction:column}\n\
      #rbai-widget-panel.open{display:flex}\n\
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
      .rbai-vid-working{object-position:50% 8%}\n\
      #rbai-widget-close{background:none;border:none;color:#fff;cursor:pointer;font-size:20px;padding:0;line-height:1}\n\
      #rbai-widget-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}\n\
      .rbai-msg{max-width:80%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.4;word-wrap:break-word}\n\
      .rbai-msg.bot{background:#F1F5F9;color:#1E293B;align-self:flex-start;border-bottom-left-radius:4px}\n\
      .rbai-msg.user{background:" + config.color + ";color:#fff;align-self:flex-end;border-bottom-right-radius:4px}\n\
      .rbai-msg.typing{color:#94A3B8;font-style:italic}\n\
      .rbai-msg.rbai-img-msg{padding:6px}\n\
      .rbai-msg.rbai-img-msg img{display:block;max-width:180px;border-radius:8px}\n\
      #rbai-widget-input{display:flex;align-items:center;border-top:1px solid #E2E8F0;padding:12px;gap:6px}\n\
      #rbai-widget-input input{flex:1;min-width:0;border:1px solid #E2E8F0;border-radius:8px;padding:10px 14px;font-size:14px;outline:none}\n\
      #rbai-widget-input input:focus{border-color:" + config.color + "}\n\
      #rbai-widget-input button#rbai-widget-send{background:" + config.color + ";color:#fff;border:none;border-radius:8px;padding:10px 16px;cursor:pointer;font-size:14px;flex:none}\n\
      .rbai-iconbtn{background:none;border:none;cursor:pointer;color:#64748B;padding:6px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex:none}\n\
      .rbai-iconbtn:hover{background:#F1F5F9;color:" + config.color + "}\n\
      .rbai-iconbtn svg{width:20px;height:20px;display:block}\n\
      .rbai-iconbtn.recording{color:#DC2626;animation:rbai-pulse 1.2s infinite}\n\
      @keyframes rbai-pulse{0%{opacity:1}50%{opacity:.4}100%{opacity:1}}\n\
      #rbai-widget-input input:disabled,.rbai-iconbtn:disabled,#rbai-widget-send:disabled{opacity:.45;cursor:not-allowed}\n\
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
          <div id="rbai-widget-headwrap"><span class="rbai-avatarwrap"><video class="rbai-vid rbai-vid-idle active" muted loop playsinline autoplay preload="auto" disablepictureinpicture src="' + idleVideoUrl + '"></video><video class="rbai-vid rbai-vid-working" muted loop playsinline preload="none" disablepictureinpicture data-src="' + workingVideoUrl + '"></video><img class="rbai-avatar-fallback" src="' + avatarUrl + '" alt=""/></span><h3>' + escapeHtml(config.title) + '</h3></div>\
          <button id="rbai-widget-close">&times;</button>\
        </div>\
        <div id="rbai-widget-status" hidden><span class="rbai-status-dot"></span><span id="rbai-widget-status-text"></span></div>\
        <div id="rbai-widget-messages"></div>\
        <div id="rbai-widget-input">\
          <button type="button" class="rbai-iconbtn" id="rbai-widget-photo" title="' + t("sendPhoto") + '" aria-label="' + t("sendPhoto") + '">' + SVG_PHOTO + '</button>\
          <button type="button" class="rbai-iconbtn" id="rbai-widget-video" title="' + t("sendVideo") + '" aria-label="' + t("sendVideo") + '">' + SVG_VIDEO + '</button>\
          <button type="button" class="rbai-iconbtn" id="rbai-widget-mic" title="' + t("sendVoice") + '" aria-label="' + t("sendVoice") + '">' + SVG_MIC + '</button>\
          <input type="text" placeholder="' + t("typeMessage") + '" id="rbai-widget-text" />\
          <button id="rbai-widget-send">' + t("send") + '</button>\
        </div>\
        <input type="file" id="rbai-widget-file" accept="image/*" style="display:none" />\
        <input type="file" id="rbai-widget-videofile" accept="video/*" style="display:none" />\
      </div>\
      <button id="rbai-widget-btn" aria-label="' + t("openChat") + '">\
        <span class="rbai-avatarwrap"><video class="rbai-vid rbai-vid-idle active" muted loop playsinline autoplay preload="auto" disablepictureinpicture src="' + idleVideoUrl + '"></video><video class="rbai-vid rbai-vid-working" muted loop playsinline preload="none" disablepictureinpicture data-src="' + workingVideoUrl + '"></video><img class="rbai-avatar-fallback" src="' + avatarUrl + '" alt=""/></span>\
      </button>\
    ';
    document.body.appendChild(container);
    wireVideoFallback();
    syncInlineMount();
    // Static poster (the avatar image) until the idle clip's first frame
    // paints, and ensure the visible idle video actually plays
    // (autoplay policies).
    var idleVids = container.querySelectorAll(".rbai-vid-idle");
    for (var p = 0; p < idleVids.length; p++) idleVids[p].setAttribute("poster", avatarUrl);
    var iv = container.querySelector(".rbai-vid-idle");
    if (iv) iv.play().catch(function () {});

    var launcherBtn = document.getElementById("rbai-widget-btn");
    if (launcherBtn) launcherBtn.onclick = toggleWidget;
    document.getElementById("rbai-widget-close").onclick = toggleWidget;
    document.getElementById("rbai-widget-send").onclick = sendMessage;
    document.getElementById("rbai-widget-text").onkeypress = function (e) {
      if (e.key === "Enter") sendMessage();
    };
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
  function ensureWorkingVideo() {
    var workings = document.querySelectorAll(".rbai-vid-working");
    for (var i = 0; i < workings.length; i++) {
      var v = workings[i];
      if (!v.getAttribute("src") && v.getAttribute("data-src")) {
        v.setAttribute("src", v.getAttribute("data-src"));
        try { v.load(); } catch (e) {}
      }
    }
  }

  // The status strip under the header avatar: visible only while the
  // agent is working, captioned with the current REAL activity (or the
  // plain typing caption while nothing specific has been observed).
  function renderStatus() {
    var strip = document.getElementById("rbai-widget-status");
    var text = document.getElementById("rbai-widget-status-text");
    if (!strip || !text) return;
    if (agentState === "working") {
      text.textContent = captionForActivity(currentActivity);
      strip.hidden = false;
    } else {
      strip.hidden = true;
    }
  }

  function setAgentState(s) {
    var showWorking = s === "working";
    if (showWorking) ensureWorkingVideo();
    if (agentState === s && !showWorking) { renderStatus(); return; }
    agentState = s;
    var idles = document.querySelectorAll(".rbai-vid-idle");
    var workings = document.querySelectorAll(".rbai-vid-working");
    for (var i = 0; i < idles.length; i++) {
      idles[i].classList.toggle("active", !showWorking);
      if (showWorking) { idles[i].pause(); }
      else { idles[i].play().catch(function () {}); }
    }
    for (var j = 0; j < workings.length; j++) {
      workings[j].classList.toggle("active", showWorking);
      if (showWorking) { try { workings[j].currentTime = 0; } catch (e) {} workings[j].play().catch(function () {}); }
      else { workings[j].pause(); }
    }
    renderStatus();
  }

  function wireVideoFallback() {
    var vids = document.querySelectorAll(".rbai-vid");
    for (var i = 0; i < vids.length; i++) {
      vids[i].addEventListener("error", function () {
        var wrap = this.closest(".rbai-avatarwrap");
        if (wrap) wrap.classList.add("novid");
      });
      // If autoplay was blocked, retry on first user interaction.
      vids[i].addEventListener("play", function () {}, false);
    }
    document.addEventListener("click", function once() {
      var act = document.querySelector(".rbai-vid.active");
      if (act && act.paused) act.play().catch(function () {});
    }, { once: true });
  }

  function toggleWidget() {
    isOpen = !isOpen;
    var panel = document.getElementById("rbai-widget-panel");
    panel.classList.toggle("open", isOpen);
    // First open: lazily fetch the working clip (never on host-page load).
    if (isOpen) ensureWorkingVideo();
    if (isOpen) {
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
        renderStatus();
      })
      .catch(function () { /* caption keeps its last honest state */ });
  }

  function startActivityPolling() {
    if (activityTimer) return;
    pollActivity();
    activityTimer = setInterval(pollActivity, 1200);
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
    if (!conversationId || !config.siteKey || !config.visitorId) return;
    var q =
      "siteKey=" + encodeURIComponent(config.siteKey) +
      "&conversationId=" + encodeURIComponent(conversationId) +
      "&visitorId=" + encodeURIComponent(config.visitorId);
    fetch(config.server + "/api/chat/thread?" + q)
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
          addMessage(m.content, m.role === "customer" ? "user" : "bot");
        });
      })
      .catch(function () {});
  }

  function startThreadSync() {
    if (threadTimer) return;
    syncThread();
    threadTimer = setInterval(syncThread, 4000);
  }

  function stopThreadSync() {
    if (threadTimer) {
      clearInterval(threadTimer);
      threadTimer = null;
    }
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

  // Settle one in-flight request: drop its typing bubble and, when the
  // last pending request finishes, return the agent to idle and stop
  // the activity polling. Shared by the JSON and streaming paths.
  function settleRequest(typing) {
    if (typing) typing.remove();
    pendingRequests = Math.max(0, pendingRequests - 1);
    if (pendingRequests === 0) {
      setAgentState("idle");
      stopActivityPolling();
    }
  }

  function handleApiResponse(data, status, typing, streamBubble) {
    settleRequest(typing);

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
      if (streamBubble) streamBubble.textContent = data.response;
      else addMessage(data.response, "bot");
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
            if (!bubble) {
              if (currentTyping) { currentTyping.remove(); currentTyping = null; }
              bubble = addMessage("", "bot");
            }
            streamed += data.text;
            bubble.textContent = streamed;
            scrollToBottom();
          } else if (event === "retract") {
            // The streamed text preceded tool calls — discard it and
            // show the typing state again while the agent works.
            if (bubble) { bubble.remove(); bubble = null; streamed = ""; }
            if (!currentTyping) currentTyping = addMessage(t("typing"), "bot typing");
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

  function sendMessage() {
    var input = document.getElementById("rbai-widget-text");
    var text = input.value;
    input.value = "";
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
  function uploadVideo(file) {
    if (!file || isPaused) return;
    if (file.size > MAX_MEDIA_BYTES) {
      addMessage(t("videoTooLarge"), "bot");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result || "");
      var base64 = dataUrl.split(",")[1] || "";
      if (!base64) {
        addMessage(t("videoReadError"), "bot");
        return;
      }
      addMessage(t("videoSent"), "user");
      pendingRequests++;
      setAgentState("working");
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
      addMessage(t("voiceUnsupported"), "bot");
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      audioChunks = [];
      try {
        mediaRecorder = new MediaRecorder(stream);
      } catch (e) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        addMessage(t("recordingUnsupported"), "bot");
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
          addMessage(t("recordingEmpty"), "bot");
          return;
        }
        if (blob.size > MAX_MEDIA_BYTES) {
          addMessage(t("recordingTooLong"), "bot");
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var base64 = String(reader.result || "").split(",")[1] || "";
          if (!base64) {
            addMessage(t("recordingProcessError"), "bot");
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
        addMessage(t("micNotFound"), "bot");
      } else if (errName === "NotReadableError" || errName === "AbortError") {
        addMessage(t("micBusy"), "bot");
      } else {
        addMessage(t("micDenied"), "bot");
      }
    });
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
    ensureWorkingVideo();
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
