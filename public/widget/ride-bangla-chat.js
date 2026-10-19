/**
 * Ride Bangla AI Agent - Live Chat Widget
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
    greeting: script.getAttribute("data-greeting") || "Hi! How can we help you today?",
    title: script.getAttribute("data-title") || "Ride Bangla AI Agent",
  };

  var avatarUrl = config.server.replace(/\/$/, "") + "/agent-avatar.png";
  var idleVideoUrl = config.server.replace(/\/$/, "") + "/agent-idle.mp4";
  var workingVideoUrl = config.server.replace(/\/$/, "") + "/agent-working.mp4";
  var agentState = "idle";
  var pendingRequests = 0;

  var conversationId = null;
  var isOpen = false;
  var isPaused = false;

  var MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  var MAX_MEDIA_BYTES = 10 * 1024 * 1024;

  function createStyles() {
    var style = document.createElement("style");
    style.textContent = "\n\
      #rbai-widget-container{position:fixed;bottom:20px;" + config.position + ":20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}\n\
      #rbai-widget-btn{width:56px;height:56px;border-radius:50%;background:" + config.color + ";border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:transform .2s}\n\
      #rbai-widget-btn:hover{transform:scale(1.05)}\n\
      #rbai-widget-btn{overflow:hidden;padding:0}\n\.rbai-avatarwrap{position:relative;display:block;overflow:hidden;background:#fff}\n\#rbai-widget-btn .rbai-avatarwrap{width:56px;height:56px;border-radius:50%}\n\#rbai-widget-header .rbai-avatarwrap{width:36px;height:36px;border-radius:50%;margin-right:10px;flex:none}\n\.rbai-vid{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none;pointer-events:none}\n\.rbai-vid.active{display:block}\n\.rbai-avatar-fallback{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none}\n\.rbai-avatarwrap.novid .rbai-avatar-fallback{display:block}\n\.rbai-avatarwrap.novid .rbai-vid{display:none!important}\n\#rbai-widget-headwrap{display:flex;align-items:center}\n\
      #rbai-widget-panel{display:none;width:370px;max-width:calc(100vw - 40px);height:520px;max-height:calc(100vh - 100px);background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.12);margin-bottom:12px;overflow:hidden;flex-direction:column}\n\
      #rbai-widget-panel.open{display:flex}\n\
      #rbai-widget-header{background:" + config.color + ";color:#fff;padding:16px;display:flex;align-items:center;justify-content:space-between}\n\
      #rbai-widget-header h3{margin:0;font-size:15px;font-weight:600}\n\
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
    container.innerHTML = '\
      <div id="rbai-widget-panel">\
        <div id="rbai-widget-header">\
          <div id="rbai-widget-headwrap"><span class="rbai-avatarwrap"><video class="rbai-vid rbai-vid-idle active" muted loop playsinline autoplay preload="auto" disablepictureinpicture src="' + idleVideoUrl + '"></video><video class="rbai-vid rbai-vid-working" muted loop playsinline preload="auto" disablepictureinpicture src="' + workingVideoUrl + '"></video><img class="rbai-avatar-fallback" src="' + avatarUrl + '" alt=""/></span><h3>' + escapeHtml(config.title) + '</h3></div>\
          <button id="rbai-widget-close">&times;</button>\
        </div>\
        <div id="rbai-widget-messages"></div>\
        <div id="rbai-widget-input">\
          <button type="button" class="rbai-iconbtn" id="rbai-widget-photo" title="Send a photo" aria-label="Send a photo">' + SVG_PHOTO + '</button>\
          <button type="button" class="rbai-iconbtn" id="rbai-widget-video" title="Send a video" aria-label="Send a video">' + SVG_VIDEO + '</button>\
          <button type="button" class="rbai-iconbtn" id="rbai-widget-mic" title="Send a voice message" aria-label="Send a voice message">' + SVG_MIC + '</button>\
          <input type="text" placeholder="Type a message..." id="rbai-widget-text" />\
          <button id="rbai-widget-send">Send</button>\
        </div>\
        <input type="file" id="rbai-widget-file" accept="image/*" style="display:none" />\
        <input type="file" id="rbai-widget-videofile" accept="video/*" style="display:none" />\
      </div>\
      <button id="rbai-widget-btn" aria-label="Open chat">\
        <span class="rbai-avatarwrap"><video class="rbai-vid rbai-vid-idle active" muted loop playsinline autoplay preload="auto" disablepictureinpicture src="' + idleVideoUrl + '"></video><video class="rbai-vid rbai-vid-working" muted loop playsinline preload="auto" disablepictureinpicture src="' + workingVideoUrl + '"></video><img class="rbai-avatar-fallback" src="' + avatarUrl + '" alt=""/></span>\
      </button>\
    ';
    document.body.appendChild(container);
    wireVideoFallback();
    // Ensure the visible idle video actually plays (autoplay policies).
    var iv = container.querySelector(".rbai-vid-idle");
    if (iv) iv.play().catch(function () {});

    document.getElementById("rbai-widget-btn").onclick = toggleWidget;
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

  function setAgentState(s) {
    var showWorking = s === "working";
    if (agentState === s && !showWorking) return;
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
    if (isOpen && !document.querySelector(".rbai-msg")) {
      addMessage(config.greeting, "bot");
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
    img.alt = "Sent photo";
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
    title.textContent = "Chat paused";
    notice.appendChild(title);

    var text = document.createElement("p");
    text.textContent = "This business's subscription is paused. Please ask them to reactivate to continue chatting.";
    notice.appendChild(text);

    var retry = document.createElement("button");
    retry.id = "rbai-paused-retry";
    retry.type = "button";
    retry.textContent = "Try again";
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
        img.alt = p.name || "Product";
        img.src = p.imageUrl;
        img.onerror = function () { this.style.display = "none"; };
        card.appendChild(img);
      }

      var body = document.createElement("div");
      body.className = "rbai-card-body";

      var name = document.createElement("div");
      name.className = "rbai-card-name";
      name.textContent = p.name || "Product";
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
      btn.textContent = "Order";
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

  // ---- Shared API plumbing ----
  function postApi(path, payload, typing) {
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

  function handleApiResponse(data, status, typing) {
    if (typing) typing.remove();
    pendingRequests = Math.max(0, pendingRequests - 1);
    if (pendingRequests === 0) setAgentState("idle");

    if (!data) {
      addMessage("Connection error. Please try again.", "bot");
      return;
    }
    // Subscription hard-stop: dedicated paused state, nothing else.
    if (status === 402 || data.error === "subscription_paused") {
      showPausedState();
      return;
    }
    if (data.conversationId) conversationId = data.conversationId;
    // Human takeover: pure silence — render nothing at all.
    if (data.silent) return;
    if (data.response) {
      addMessage(data.response, "bot");
    } else if (data.error) {
      addMessage(data.error, "bot");
    } else {
      addMessage("Sorry, I could not process your request.", "bot");
    }
    if (data.products && data.products.length) {
      renderProductCards(data.products);
    }
  }

  function sendText(text) {
    text = (text || "").trim();
    if (!text || isPaused) return;

    addMessage(text, "user");
    pendingRequests++;
    setAgentState("working");

    var typing = addMessage("Typing...", "bot typing");

    postApi("/api/chat/widget", {
      message: text,
      conversationId: conversationId,
      siteKey: config.siteKey,
      visitorId: config.visitorId,
    }, typing);
  }

  function sendMessage() {
    var input = document.getElementById("rbai-widget-text");
    var text = input.value;
    input.value = "";
    sendText(text);
  }

  // ---- Photo upload -> /api/chat/vision ----
  function uploadPhoto(file) {
    if (!file || isPaused) return;
    if (file.size > MAX_IMAGE_BYTES) {
      addMessage("That photo is too large (max 4 MB). Please choose a smaller one.", "bot");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result || "");
      var base64 = dataUrl.split(",")[1] || "";
      if (!base64) {
        addMessage("I couldn't read that photo. Please try another one.", "bot");
        return;
      }
      addImageMessage(dataUrl);
      pendingRequests++;
      setAgentState("working");
      var typing = addMessage("Looking at your photo...", "bot typing");
      postApi("/api/chat/vision", {
        siteKey: config.siteKey,
        visitorId: config.visitorId,
        conversationId: conversationId,
        image: { mimeType: file.type || "image/jpeg", base64: base64 },
      }, typing);
    };
    reader.onerror = function () {
      addMessage("I couldn't read that photo. Please try another one.", "bot");
    };
    reader.readAsDataURL(file);
  }

  // ---- Video upload -> /api/chat/vision ----
  function uploadVideo(file) {
    if (!file || isPaused) return;
    if (file.size > MAX_MEDIA_BYTES) {
      addMessage("That video is too large (max 10 MB). Please choose a shorter one.", "bot");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result || "");
      var base64 = dataUrl.split(",")[1] || "";
      if (!base64) {
        addMessage("I couldn't read that video. Please try another one.", "bot");
        return;
      }
      addMessage("Video sent", "user");
      pendingRequests++;
      setAgentState("working");
      var typing = addMessage("Watching your video...", "bot typing");
      postApi("/api/chat/vision", {
        siteKey: config.siteKey,
        visitorId: config.visitorId,
        conversationId: conversationId,
        video: { mimeType: file.type || "video/mp4", base64: base64 },
      }, typing);
    };
    reader.onerror = function () {
      addMessage("I couldn't read that video. Please try another one.", "bot");
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
      addMessage("Voice messages aren't supported in this browser. Please type your message.", "bot");
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      audioChunks = [];
      try {
        mediaRecorder = new MediaRecorder(stream);
      } catch (e) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        addMessage("Voice recording isn't supported in this browser. Please type your message.", "bot");
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
          addMessage("That recording was empty. Please try again.", "bot");
          return;
        }
        if (blob.size > MAX_MEDIA_BYTES) {
          addMessage("That recording is too long (max 10 MB). Please try a shorter one.", "bot");
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var base64 = String(reader.result || "").split(",")[1] || "";
          if (!base64) {
            addMessage("I couldn't process that recording. Please try again.", "bot");
            return;
          }
          addMessage("Voice message sent", "user");
          pendingRequests++;
          setAgentState("working");
          var typing = addMessage("Listening...", "bot typing");
          postApi("/api/chat/voice", {
            siteKey: config.siteKey,
            visitorId: config.visitorId,
            conversationId: conversationId,
            audio: { mimeType: mimeType, base64: base64 },
          }, typing);
        };
        reader.readAsDataURL(blob);
      };
      mediaRecorder.start();
      setRecordingUI(true);
    }).catch(function () {
      addMessage("I couldn't access the microphone. Please check the browser permission and try again.", "bot");
    });
  }

  // Initialize
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      createStyles();
      createWidget();
    });
  } else {
    createStyles();
    createWidget();
  }
})();
