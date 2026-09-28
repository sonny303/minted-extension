import type { AiFillReview, AiLearningSummary } from "../shared/fill";
import type { BgResponse } from "../shared/messages";

export interface AiReviewButtons {
  accept: HTMLButtonElement;
  clear: HTMLButtonElement;
  retry: HTMLButtonElement;
}

export interface AiReviewControllerPort {
  getReview(): AiFillReview | null;
  getTabId(): number | null;
  getFillSessionId(): string | null;
  isSubmitted(): boolean;
  accept(tabId: number, fillSessionId: string): Promise<BgResponse<boolean>>;
  clear(tabId: number | null, fillSessionId: string): Promise<BgResponse<number>>;
  retry(fillSessionId: string): Promise<BgResponse<AiLearningSummary>>;
  update(review: AiFillReview, submitted: boolean): void;
  showError(message: string): void;
}

/** Bind the three explicit review actions; each successful state change comes
 * from a worker response, never an optimistic Good Catch. */
export function bindAiReviewActions(buttons: AiReviewButtons, port: AiReviewControllerPort): void {
  buttons.accept.addEventListener("click", () => {
    const review = port.getReview();
    const tabId = port.getTabId();
    const fillSessionId = port.getFillSessionId();
    if (!review || review.writes.length === 0 || tabId == null || !fillSessionId) return;
    buttons.accept.disabled = true;
    void port.accept(tabId, fillSessionId).then((response) => {
      if (!response.ok) {
        buttons.accept.disabled = false;
        port.showError(response.error);
        return;
      }
      port.update({
        ...review,
        accepted: true,
        learning: { state: "accepted", confirmedSavedCount: 0, insertedCount: 0, preservedCount: 0 },
      }, false);
    }).catch(() => {
      buttons.accept.disabled = false;
      port.showError("The AI suggestions could not be accepted. Retry from this page.");
    });
  });

  buttons.clear.addEventListener("click", () => {
    const review = port.getReview();
    if (!review || review.writes.length === 0 || port.isSubmitted()) return;
    buttons.clear.disabled = true;
    void port.clear(port.getTabId(), review.fillSessionId).then((response) => {
      if (!response.ok) {
        buttons.clear.disabled = false;
        port.showError(response.error);
        return;
      }
      port.update({
        ...review,
        status: "no-matches",
        accepted: false,
        cleared: true,
        learning: { state: "revoked", confirmedSavedCount: 0, insertedCount: 0, preservedCount: 0 },
      }, false);
    }).catch(() => {
      buttons.clear.disabled = false;
      port.showError("AI suggestions could not be cleared. Retry from this page.");
    });
  });

  buttons.retry.addEventListener("click", () => {
    const review = port.getReview();
    const fillSessionId = port.getFillSessionId();
    if (!review || !fillSessionId || review.learning?.state !== "failed" || !port.isSubmitted()) return;
    buttons.retry.disabled = true;
    void port.retry(fillSessionId).then((response) => {
      if (!response.ok) {
        buttons.retry.disabled = false;
        port.showError(response.error);
        return;
      }
      port.update({ ...review, learning: response.data }, true);
    }).catch(() => {
      buttons.retry.disabled = false;
      port.showError("Good Catch could not be retried. Try again in a moment.");
    });
  });
}

/** Value-free status copy used by the real renderer and the interaction test. */
export function aiReviewStatusText(review: AiFillReview): string {
  const count = review.writes.length;
  const remainder = review.unprocessedControls > 0
    ? ` ${review.unprocessedControls} controls remain for manual review.`
    : "";
  const learning = review.learning;
  if (review.cleared) return "AI suggestions cleared where unchanged. Static fills and later edits remain.";
  if (learning?.state === "learned") {
    if (learning.confirmedSavedCount > 0) {
      const preserved = learning.preservedCount > 0
        ? ` ${learning.preservedCount} existing mappings were preserved.`
        : "";
      return `Good Catch: ${learning.confirmedSavedCount} mapping${learning.confirmedSavedCount === 1 ? "" : "s"} confirmed for future fills.${preserved}`;
    }
    if (learning.preservedCount > 0) {
      return `No new Good Catch was added; ${learning.preservedCount} existing mapping${learning.preservedCount === 1 ? " was" : "s were"} preserved.`;
    }
    return "No new Good Catch mappings were added.";
  }
  if (learning?.state === "pending") return "Submission logged. Saving accepted mappings…";
  if (learning?.state === "failed") {
    const saved = learning.confirmedSavedCount > 0
      ? ` ${learning.confirmedSavedCount} mapping${learning.confirmedSavedCount === 1 ? " was" : "s were"} confirmed.`
      : "";
    return learning.reason === "missing_page_scope"
      ? `Submission logged, but some suggestions lacked a safe page URL and were not learned.${saved}`
      : `Submission logged. Good Catch could not finish; retry learning.${saved}`;
  }
  if (learning?.state === "revoked") return "AI learning was cleared when the work context changed.";
  if (review.accepted) return `Accepted ${count} AI suggestion${count === 1 ? "" : "s"} for this fill.`;
  if (review.status === "unavailable") return `On-device AI is unavailable; static fills still completed.${remainder}`;
  if (review.status === "error") return `AI review could not finish; static fills still completed.${remainder}`;
  if (review.status === "ready") return `AI suggested ${count} field${count === 1 ? "" : "s"}. Review amber fields, then accept or clear.${remainder}`;
  return `No high-confidence AI matches; static fills still completed.${remainder}`;
}
