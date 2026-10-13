# Optional AI and news availability

Technical trade confirmation, entries and exits run locally and never depend on
Gemini or the local text classifier. Provider failures appear as a small status
message inside the Gemini card, with no AI error toast.

## Automatic news and optional commentary

The news endpoint assesses only fresh headlines from available public sources.
It caches assessments for 24 hours, bounded to 1,000 entries, in the ignored
`.cache/ai-news.json`. Publication age still cannot exceed 48 hours. The cache also
persists Gemini cooldown state, never an API key, broker credentials or chart
prompts. Cache read/write failures cannot stop technical evaluation.

Common Indian/global news assessments are shared across Nifty, Sensex and Bank
Nifty. Constituent announcements remain index-specific. Changed titles,
descriptions, publication times or company context invalidate their cache entry.
OI/global quote revisions and new candles do not reclassify unchanged headlines.
Client revisions are rebound only when headline content and source availability
match, so stale feeds cannot regain a directional vote from a cached assessment.

Automatic requests are serialized and concurrent duplicates are coalesced.
Gemini candle commentary is manual; its identical overlapping requests are
coalesced and successful results cached in memory for five minutes. Only current
completed chart data is displayed. Commentary cannot confirm or veto entries.

A shared provider circuit applies to news and commentary. Transient overload or
network failures receive at most one delayed retry with jitter; continued failures
pause cloud calls for at least two minutes. Quota errors pause them for at least
30 minutes, respecting a longer Retry-After/retry-delay (bounded to 24 hours).
Configuration/billing errors pause for 15 minutes without a retry. Client status
messages show the retry time, and cooling-down commentary buttons are disabled.
These measures reduce requests; they do not increase provider quota.

[Google's retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting)
recommends bounded backoff for transient errors. Daily/project quota exhaustion
still needs the relevant quota reset or account configuration to recover.

## Local financial-text fallback

Run `npm run news:setup` once to download the quantized `Xenova/finbert` ONNX model.
`NEWS_LOCAL_CLASSIFIER=auto` (default) uses downloaded files offline; `off` disables
it. Inference runs in a separate process with bounded startup/inference timeouts,
so it does not block the trading/API thread. If the system Node is older than
20.9, setup prepares Node 22 in the ignored `.cache/news-runtime` directory; it
does not replace system Node. Model/dependency setup needs internet access once.

[FinBERT](https://huggingface.co/ProsusAI/finbert) predicts English financial-text
positive/negative/neutral labels. A positive company sentence, oil headline or
foreign-market event does not automatically imply a positive Indian-index move.
Consequently fallback badges read `Text +ve`, `Text -ve`, etc.; they are marked
`TEXT_ONLY` and never contribute to the news market-impact evidence budget.
Classifier confidence is not a market prediction probability. Low-confidence
labels remain unclear. When Gemini recovers, current local-only headlines can
receive validated market-impact assessments and replace provisional labels.

The model's upstream license and usage conditions apply; see its model card.
If inference fails or neither provider is available, headlines remain readable,
market-impact assessment is explicitly unavailable, and sentiment coverage is
reduced. Existing matching Gemini cache entries remain usable while fresh.

The ONNX CPU runtime is pinned to 1.21.0 for compatibility with older Intel Mac
system libraries. Proxy/archive packages are overridden to patched versions;
setup also installs optional native modules using the supported classifier runtime.
The transformer library and model are used only by the backend worker, never
included in the browser bundle.

Omitted/partial headline assessments have a two-minute attempt guard to prevent
immediate repeat calls across cards. News retries after provider cooldown or
transient transport failure; healthy cached news is checked periodically without
another cloud call. Clients exclude assessments older than 24 hours even after
rebinding them to a fresh macro-context revision.
