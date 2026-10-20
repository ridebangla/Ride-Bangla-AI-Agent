import type { Metadata } from "next";

// Auth surfaces (/login, /setup) are not marketing pages — keep them out of
// the index. This layout is a server component, so the noindex metadata for
// the whole (auth) group lives here (the pages themselves are client
// components and cannot export metadata).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-full flex items-center justify-center bg-rbai-bg px-4 py-12">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
