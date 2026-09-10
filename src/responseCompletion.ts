// Per-request HTTP response-completion coordinator (RepoConnect HTTP MCP
// Session Churn Continuity, R4: RESPONSE-FINISH-ORDER-001).
//
// Pure state machine: no I/O, no timers, no ambient state. The caller routes
// the three terminal signals of one HTTP request (handler settlement and the
// response `finish` / `close` events, in whatever order the transport and the
// HTTP stack deliver them); the tracker drives exactly-once in-flight release
// and at-most-once application scoring per this truth table:
//
//   handler-success then finish  -> mark (iff application-use) once, release once
//   finish then handler-success  -> mark (iff application-use) once, release once
//   close-before-finish, later settle (either way)
//                                -> release once, never mark
//   handler-success then close-before-finish
//                                -> release once, never mark
//   normal finish then close     -> no duplicate mark, no duplicate release
//   handler exception            -> release once, never mark
//   no terminal signal yet       -> held (nothing driven)
//
// Rationale: handler resolution is not response completion. On a large normal
// response the handler can resolve milliseconds before the HTTP stack emits
// `finish`; a client that received only a prefix and ended the connection
// must not leave behind a scored-but-undelivered operation. `finish` is the
// accepted server-side completion boundary; `close` before `finish`
// permanently classifies the response as incomplete. All drive methods latch
// their signal, so repeated delivery (finish+close, double close) is safe
// even against a non-idempotent sink — though the HTTP-layer sink is itself
// idempotent as defense in depth.

export interface ResponseCompletionSink {
  releaseInFlight(): void;
  markApplicationCompleted(): void;
}

export interface ResponseCompletionTracker {
  onHandlerSuccess(): void;
  onHandlerError(): void;
  onResponseFinish(): void;
  onResponseClose(): void;
}

export function createResponseCompletionTracker(
  isApplicationUse: boolean,
  sink: ResponseCompletionSink
): ResponseCompletionTracker {
  let handlerSucceeded = false;
  let handlerErrored = false;
  let responseFinished = false;
  let closedBeforeFinish = false;
  let released = false;
  let marked = false;

  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    sink.releaseInFlight();
  };
  const markOnce = (): void => {
    if (marked) return;
    marked = true;
    if (isApplicationUse) sink.markApplicationCompleted();
  };
  const reconcile = (): void => {
    if (closedBeforeFinish) {
      // Premature end: release only. Never score — even if the handler
      // settles internally afterwards.
      releaseOnce();
      return;
    }
    if (handlerSucceeded && responseFinished) {
      markOnce();
      releaseOnce();
    }
  };

  return {
    onHandlerSuccess: (): void => {
      // Defense in depth: the caller drives exactly one of success/error per
      // request (try/catch mutual exclusion), but an errored handler must
      // never score even if a stray success signal ever arrived.
      if (handlerErrored) return;
      handlerSucceeded = true;
      reconcile();
    },
    onHandlerError: (): void => {
      // Conservative unscored release through the finalization path; a later
      // error-middleware finish or close reconciles to no-ops.
      handlerErrored = true;
      releaseOnce();
    },
    onResponseFinish: (): void => {
      responseFinished = true;
      reconcile();
    },
    onResponseClose: (): void => {
      if (!responseFinished) {
        // Incomplete response: suppress scoring permanently and release
        // immediately so an ended connection cannot hold capacity.
        closedBeforeFinish = true;
        releaseOnce();
      } else {
        reconcile();
      }
    }
  };
}
