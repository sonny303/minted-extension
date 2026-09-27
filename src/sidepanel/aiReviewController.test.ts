import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { AiFillReview, AiLearningSummary } from "../shared/fill";
import { aiReviewStatusText, bindAiReviewActions } from "./aiReviewController";

describe("AI review interaction controller", () => {
  it("dispatches Accept, pre-touch Clear, and learn-only retry with honest Good Catch copy", async () => {
    const dom = new JSDOM('<button id="accept"></button><button id="clear"></button><button id="retry"></button>');
    const document = dom.window.document;
    const buttons = {
      accept: document.getElementById("accept") as HTMLButtonElement,
      clear: document.getElementById("clear") as HTMLButtonElement,
      retry: document.getElementById("retry") as HTMLButtonElement,
    };
    const reviewWrite = {
      selector: "#npi",
      token: "provider.npi",
      confidence: 0.92,
      fieldType: "text" as const,
      pageUrl: "https://portal.example/form",
    };
    let review: AiFillReview = {
      scanId: "scan-1", fillSessionId: "fill-1", status: "ready",
      writes: [reviewWrite], unprocessedControls: 0, accepted: false,
    };
    let submitted = false;
    const requests: Array<{ type: string; fillSessionId: string; tabId?: number | null }> = [];
    const render = vi.fn((next: AiFillReview, didSubmit: boolean) => {
      review = next;
      submitted = didSubmit;
    });
    const showError = vi.fn();
    bindAiReviewActions(buttons, {
      getReview: () => review,
      getTabId: () => 7,
      getFillSessionId: () => review.fillSessionId,
      isSubmitted: () => submitted,
      accept: async (tabId, fillSessionId) => {
        requests.push({ type: "ACCEPT_AI_FILL", tabId, fillSessionId });
        return { ok: true, data: true };
      },
      clear: async (tabId, fillSessionId) => {
        requests.push({ type: "CLEAR_AI_FILL", tabId, fillSessionId });
        return { ok: true, data: 1 };
      },
      retry: async (fillSessionId) => {
        requests.push({ type: "RETRY_AI_LEARNING", fillSessionId });
        const data: AiLearningSummary = {
          state: "learned", confirmedSavedCount: 1, insertedCount: 0, preservedCount: 2,
        };
        return { ok: true, data };
      },
      update: render,
      showError,
    });

    buttons.accept.click();
    await vi.waitFor(() => expect(review.accepted).toBe(true));
    expect(requests[0]).toEqual({ type: "ACCEPT_AI_FILL", tabId: 7, fillSessionId: "fill-1" });
    expect(aiReviewStatusText(review)).toBe("Accepted 1 AI suggestion for this fill.");

    // Clear remains an explicit undo before the touch even after consent.
    buttons.clear.click();
    await vi.waitFor(() => expect(review.cleared).toBe(true));
    expect(requests[1]).toEqual({ type: "CLEAR_AI_FILL", tabId: 7, fillSessionId: "fill-1" });
    expect(aiReviewStatusText(review)).toContain("AI suggestions cleared where unchanged");

    review = { ...review, accepted: true, cleared: false, learning: {
      state: "failed", confirmedSavedCount: 0, insertedCount: 0, preservedCount: 0,
      reason: "request_failed",
    } };
    submitted = true;
    buttons.retry.click();
    await vi.waitFor(() => expect(review.learning?.state).toBe("learned"));
    expect(requests[2]).toEqual({ type: "RETRY_AI_LEARNING", fillSessionId: "fill-1" });
    expect(requests.map((request) => request.type)).not.toContain("MARK_SUBMITTED");
    expect(aiReviewStatusText(review)).toBe(
      "Good Catch: 1 mapping confirmed for future fills. 2 existing mappings were preserved.",
    );
    expect(render).toHaveBeenCalledTimes(3);
    expect(showError).not.toHaveBeenCalled();

    dom.window.close();
  });
});
