# Index price scale and option premiums

The chart's right price scale is a three-column horizontal scroller: CE, index
levels, PE. It opens on the center index column. Buttons provide the same
navigation for keyboard/mouse use. These controls sit below the chart at the
bottom right. The center button displays the nearest option expiry as `DD/MM E`
and still selects the index column. The existing cached index-instrument response
supplies expiry metadata before premiums load, without an extra quote request;
missing or expired metadata displays `— E`. Public expiry metadata loads even
without an active broker session. Nifty 50 levels use fixed 50-point multiples;
Sensex and Bank Nifty use 100-point multiples. Rows and grid lines use the actual
underlying price coordinate. Normally the candle range is preserved; a tight
range containing no strike is extended just enough to expose the nearest level.
Existing live, support/resistance, trade and removable horizontal-line badges
remain in the index column, without obscuring candles or replacing premiums.

CE/PE cells show rupee LTP for that row's strike and the selected index's nearest
unexpired contract. Nifty/Bank Nifty resolve NFO OPTIDX instruments; Sensex resolves
BFO OPTIDX instruments from Angel One's master. Master strikes are divided by 100
as described in the [SmartAPI instrument-master clarification](https://smartapi.angelbroking.com/smartapi/forum/topic/467/incorrect-strike-price-showing-on-https-margincalculator-angelbroking-com-openapi_file-files-openapiscripmaster-json/1).
Expiry selection uses the 15:30 IST cutoff and never mixes expiries or underlyings.
Missing contracts and unfetched/invalid quotes show a dash with a reason.

`POST /api/angelone/option-premiums` uses the logged-in bearer token and the server's
existing SmartAPI private key. It resolves contracts server-side and requests LTP
through the [official market-data API](https://smartapi.angelone.in/docs), whose
[SDK implementation](https://github.com/angel-one/smartapi-python/blob/main/SmartApi/smartConnect.py)
uses `mode` and `exchangeTokens`. Up to 25 visible strikes produce at most 50
contracts in one request. Quote calls are serialized one second apart per server
instance, deduplicated and cached for ten seconds per bearer/strike set, with a
rate-limit cooldown and bounded queue/cache. The full master is not retained:
only index metadata and nearest-expiry index option records stay in memory.

Premiums load only while CE or PE is revealed on the mounted chart. Scrolling
price/history ranges is debounced; requests abort on index changes/unmount.
Paired quotes are reused when switching CE to PE. Successful polling runs every
15 seconds after completion; failures retry after 30 seconds. Hidden tabs pause
polling, and premiums older than 30 seconds or from expired contracts stop being
shown. Broker failures remain inline and do not trigger a popup.

SmartAPI's HTTP-200 `AG8001` / `AG8002` / `AG8003` failures are forwarded as
HTTP 401, preserving either spelling of its error-code field. CE/PE requests
refresh the JWT once and retry with the new token. Profile and premium requests
share an in-flight refresh; JWT, refresh and feed tokens rotate together and
reconnect streams without triggering another history sync. An expired refresh
token or rejected retry shows an inline sign-in message and stops periodic quote
retries until authentication changes. Refresh responses cannot restore a logged
out session or overwrite a newer login. Rate limits do not rotate tokens.

The supplied live-market-data documentation confirms LTP mode for premium prices.
FULL mode additionally exposes option volume, OI and depth, but fetching those is
not necessary for this price scale. Option Greeks expose sensitivities and IV,
not LTP; the documented NSE-only availability also excludes Sensex BFO options.
They are not used as a substitute for a missing premium or a spot-index VWAP.

The header states the expiry and identifies these as latest premiums. Hover shows
the receipt time; these are current option quotes, not historical option prices
for the selected candle. The LTP endpoint does not supply an exchange trade time,
so timestamps are explicitly receipt times. These display quotes do not change
agent confirmation rules, index-point P/L or submit orders.

Restart the backend after updating code so the new endpoint is available.
`npm run test:options` checks steps/coordinates, contract/expiry resolution,
exchange/token matching, partial quote failures, caching, serialization, rate
limits and session recovery. Browser checks mock quotes for all three indices on mobile and desktop;
they do not validate a live broker session or exchange permissions.
