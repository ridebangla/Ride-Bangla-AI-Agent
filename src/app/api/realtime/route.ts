import { NextRequest } from "next/server";
import { subscribe } from "@/lib/realtime";
import { requireAuth, isAuthenticated } from "@/lib/route-auth";
import { runWithBusiness } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // C-07: the SSE feed previously let anyone subscribe to any channel
  // (including `global`), disclosing live events. Require auth.
  const auth = await requireAuth(request, "conversations:read");
  if (!isAuthenticated(auth)) return auth;

  return runWithBusiness(auth.businessId, async () => {

    const channel = request.nextUrl.searchParams.get("channel") || "global";

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // Send initial connection event
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "connected", channel })}\n\n`)
        );

        // Subscribe to events
        const unsubscribe = subscribe(channel, (event) => {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
            );
          } catch {
            unsubscribe();
          }
        });

        // Heartbeat every 30 seconds
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            clearInterval(heartbeat);
            unsubscribe();
          }
        }, 30000);

        // Cleanup on abort
        request.signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });

  });
}
