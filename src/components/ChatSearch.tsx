"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * The chat box. It does not display results - it rewrites the URL and lets the listing below
 * re-render from it, the same thing the filter bar does. So a chat answer is an ordinary,
 * shareable, refreshable filtered search, and there is only one results view in the app.
 *
 * What it does show is the reasoning: which filters were derived, and what a vague word like
 * "cheap" was taken to mean, with the number and where it came from. The user can see the rule
 * that was applied and overrule it in the filter bar.
 */

interface ChatResponse {
  understood: boolean;
  source: "llm" | "fallback";
  degradedReason?: string;
  explanations: string[];
  ignored: string[];
  queryString: string;
  message?: string;
  error?: string;
}

const EXAMPLES = [
  "tanie 2 pokoje we Wrzeszczu do 600 tys",
  "nice cheap flat around 40m",
  "nowe mieszkanie z balkonem i windą",
];

const ERROR_MESSAGES: Record<string, string> = {
  too_many_requests: "Too many searches in a row - give it a minute.",
  message_too_long: "That is longer than 200 characters. Try a shorter sentence.",
  empty_message: "Type what you are looking for first.",
};

export default function ChatSearch() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [result, setResult] = useState<ChatResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [sending, setSending] = useState(false);

  async function ask(message: string) {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = (await response.json()) as ChatResponse;
      if (!response.ok) {
        setResult(null);
        setError(ERROR_MESSAGES[data.error ?? ""] ?? "The search assistant is unavailable right now.");
        return;
      }
      setResult(data);
      if (data.understood) {
        startTransition(() => router.push(data.queryString ? `/?${data.queryString}` : "/"));
      }
    } catch {
      setResult(null);
      setError("The search assistant could not be reached.");
    } finally {
      setSending(false);
    }
  }

  const busy = sending || pending;

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(value);
        }}
      >
        <label className="sr-only" htmlFor="chat-input">
          Describe the flat you are looking for
        </label>
        <input
          id="chat-input"
          value={value}
          maxLength={200}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Describe what you are looking for, in Polish or English"
          className="flex-1 rounded border border-neutral-300 px-3 py-2"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Thinking…" : "Search"}
        </button>
      </form>

      {!result && !error && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span>Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setValue(example);
                void ask(example);
              }}
              className="rounded-full border border-neutral-300 px-2 py-1 hover:bg-neutral-50"
            >
              {example}
            </button>
          ))}
        </p>
      )}

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {result && !result.understood && <p className="mt-3 text-sm text-neutral-700">{result.message}</p>}

      {result?.understood && (
        <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">Understood as:</p>
              <ul className="mt-1 list-disc pl-5">
                {result.explanations.map((explanation) => (
                  <li key={explanation}>{explanation}</li>
                ))}
              </ul>
              {result.ignored.length > 0 && (
                <p className="mt-2 text-emerald-800">Ignored: {result.ignored.join("; ")}.</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setValue("");
                setResult(null);
                startTransition(() => router.push("/"));
              }}
              className="shrink-0 text-xs underline"
            >
              clear
            </button>
          </div>
        </div>
      )}

      {result?.source === "fallback" && (
        <p className="mt-2 text-xs text-neutral-500">
          {result.degradedReason
            ? `Interpreted by the built-in parser - ${result.degradedReason}.`
            : "Interpreted by the built-in parser - no GEMINI_API_KEY is configured."}{" "}
          The rules that turn this into filters are the same either way.
        </p>
      )}
    </section>
  );
}
