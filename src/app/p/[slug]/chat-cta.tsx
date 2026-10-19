"use client";

/**
 * chat-cta.tsx — client-side "Chat with us" button for the public landing
 * page. Opens the embedded chat widget by clicking its launcher button.
 */

export function ChatCtaButton({
  label,
  background,
  color,
  small,
}: {
  label: string;
  background: string;
  color: string;
  small?: boolean;
}) {
  const openChat = () => {
    const btn = document.getElementById("rbai-widget-btn") as HTMLButtonElement | null;
    if (btn) {
      btn.click();
    } else {
      // Widget script still loading — scroll to where it will appear.
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }
  };

  return (
    <button
      onClick={openChat}
      className="lp-cta"
      style={
        small
          ? { background, color, fontSize: 14, padding: "10px 22px" }
          : { background, color }
      }
    >
      {label}
    </button>
  );
}
