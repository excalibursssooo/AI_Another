import { useEffect, useRef } from "react";

import { POLL_INTERVALS, POLL_LIMITS } from "@/config/constants";
import { getErrorMessage } from "@/lib/utils/error";

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  const message = getErrorMessage(error).toLowerCase();
  return name === "AbortError" || name === "CanceledError" || message.includes("aborted") || message.includes("canceled");
}

export function useFeedPolling(loadFeedPosts: (signal: AbortSignal) => Promise<void>) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failCountRef = useRef(0);
  const loadActionRef = useRef(loadFeedPosts);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadActionRef.current = loadFeedPosts;
  }, [loadFeedPosts]);

  useEffect(() => {
    let isSubscribed = true;

    const poll = async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await loadActionRef.current(controller.signal);
        failCountRef.current = 0;
      } catch (error) {
        if (isAbortLikeError(error)) {
          return;
        }
        failCountRef.current += 1;
      }

      if (isSubscribed) {
        if (failCountRef.current >= POLL_LIMITS.MAX_FAIL_COUNT) {
          return;
        }

        const backoffDelay =
          failCountRef.current === 0
            ? POLL_INTERVALS.FEED_POSTS
            : POLL_INTERVALS.FEED_POSTS + (2 ** failCountRef.current) * 1000;

        timeoutRef.current = setTimeout(poll, Math.min(backoffDelay, POLL_LIMITS.MAX_BACKOFF_MS));
      }
    };

    void poll();

    return () => {
      isSubscribed = false;
      abortRef.current?.abort();
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);
}
