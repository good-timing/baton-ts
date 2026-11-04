## typescript: 0.6.7 published vs 0.6.8 checkout

The numbers compare two versions of one SDK on one machine. They are not what a vendor sees in production: the collector is local and the client is in the same process. Median (lowest–highest) of 5, 5 runs.

| measure | metric | 0.6.7 published | 0.6.8 checkout | change |
|---|---|---|---|---|
| overhead | plain_p50_ms | 0.115 (0.114–0.116) | 0.116 (0.116–0.118) | +0% |
| overhead | plain_p99_ms | 0.288 (0.278–0.36) | 0.303 (0.283–0.327) | +5% (noise) |
| overhead | baton_p50_ms | 0.247 (0.245–0.25) | 0.252 (0.25–0.256) | +2% |
| overhead | baton_p99_ms | 1.74 (1.71–1.8) | 1.78 (1.68–1.93) | +2% (noise) |
| overhead | added_p50_ms | 0.131 (0.13–0.135) | 0.135 (0.134–0.14) | +3% (noise) |
| overhead | added_p99_ms | 1.45 (1.38–1.5) | 1.5 (1.39–1.62) | +3% (noise) |
| burst | wall_ms | 2,082 (2,043–2,134) | 2,213 (2,120–2,272) | +6% |
| burst | call_p50_ms | 2.03 (2–2.05) | 2.13 (2.04–2.19) | +5% |
| burst | call_p99_ms | 4 (3.94–4.63) | 4.24 (3.91–4.43) | +6% (noise) |
| burst | close_ms | 2.28 (2.19–2.36) | 2.33 (2.21–2.54) | +2% (noise) |
| burst | emitted | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | delivered | 20,000 (20,000–20,000) | 20,000 (20,000–20,000) | same |
| burst | lost | 0 (0–0) | 0 (0–0) | same |
| outage_hang | wall_ms | 337 (325–339) | 350 (347–361) | +4% |
| outage_hang | call_p50_ms | 1.54 (1.51–1.56) | 1.6 (1.59–1.64) | +4% |
| outage_hang | call_p99_ms | 3.32 (3.25–3.55) | 3.55 (3.41–3.63) | +7% |
| outage_hang | close_ms | 3,000 (3,000–3,001) | 3,001 (3,000–3,001) | +0% (noise) |
| outage_hang | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_hang | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_hang | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | wall_ms | 325 (318–337) | 364 (356–376) | +12% |
| outage_down | call_p50_ms | 1.49 (1.47–1.51) | 1.58 (1.56–1.66) | +6% |
| outage_down | call_p99_ms | 3.47 (3.06–3.94) | 4.73 (4.33–5.02) | +36% |
| outage_down | close_ms | 1,088 (1,075–1,093) | 1,049 (1,038–1,056) | -4% |
| outage_down | emitted | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| outage_down | delivered | 0 (0–0) | 0 (0–0) | same |
| outage_down | lost | 4,000 (4,000–4,000) | 4,000 (4,000–4,000) | same |
| memory | heap_after_warmup_bytes | 26,640,448 (26,578,976–26,658,368) | 23,419,664 (22,459,424–23,420,920) | -12% |
| memory | heap_at_half_bytes | 26,921,216 (26,018,064–26,955,712) | 22,369,848 (22,336,800–22,828,360) | -17% |
| memory | heap_at_end_bytes | 26,054,120 (25,589,144–26,072,488) | 22,474,384 (22,444,632–22,488,720) | -14% |
| memory | growth_per_call_bytes | -84.9 (-90.2–-42.9) | 9.79 (-34.9–12.6) | +112% |
| memory_outage | heap_after_warmup_bytes | 26,239,032 (25,760,920–26,255,928) | 22,611,088 (22,587,544–22,627,048) | -14% |
| memory_outage | heap_at_half_bytes | 26,975,632 (26,962,952–26,979,928) | 23,817,448 (23,801,896–23,827,536) | -12% |
| memory_outage | heap_at_end_bytes | 26,951,488 (26,922,936–26,957,576) | 23,794,704 (23,755,376–23,822,032) | -12% |
| memory_outage | growth_per_call_bytes | -2.41 (-5.07–-2.03) | -2.98 (-4.65–1.08) | -23% (noise) |
| process | max_rss_bytes | 216,383,488 (212,283,392–217,501,696) | 207,233,024 (206,544,896–207,630,336) | -4% |
