import { afterEach, describe, expect, it, vi } from "vitest";

import { apiAccessLogin, apiAccessStatus } from "./api";

function hangingFetch(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("The request was aborted.", "AbortError")),
      { once: true },
    );
  });
}

describe("access API requests", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts and reports a stalled login request after the timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(hangingFetch);
    vi.stubGlobal("fetch", fetchMock);

    const request = apiAccessLogin("general", "test-password");
    const rejection = expect(request).rejects.toMatchObject({
      status: 504,
      message: expect.stringContaining("30 секунд"),
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an access-status request when its owner unmounts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(hangingFetch);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const request = apiAccessStatus("general", controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout after a successful access response", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ configured: true, authenticated: true }),
            { status: 200 },
          ),
        ),
    );

    await expect(apiAccessLogin("general", "test-password")).resolves.toEqual({
      configured: true,
      authenticated: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
